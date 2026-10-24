import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, count, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  db, EXTERNAL_ROLES, member, notification, notificationOptout, user,
  type NotificationChannel, type NotificationParams,
} from "@confire/db";
import { sendMails, type Mail, type SendResult } from "./mail/mailer.ts";

// Notifications (spec docs/superpowers/specs/2026-10-22-notifications-design.md): the catalog of
// events a user can hear of, and the one way to tell them — a bell row and a mail, each unless that
// user switched it off. The ONLY writer of `notification` and `notification_optout`; both processes
// import it (the portal/members.ts pattern). Who is eligible is the producer's call (notify.ts for
// project events); this module applies each person's own switches and nothing else.

export type Audience = "staff" | "client";

/** One row of a user's settings table, in its order. Labels are each SPA's (`NOTIF_<ID>`), so adding
 *  an event is an entry here, its i18n keys and a producer call — no schema change, no backfill. */
export const NOTIFICATION_TYPES = [
  { id: "request.submitted", audience: "staff", group: "portal" },
  { id: "request.assigned", audience: "staff", group: "portal" },
  { id: "request.resubmitted", audience: "staff", group: "portal" },
  { id: "request.comment", audience: "staff", group: "portal" },
  { id: "request.file", audience: "staff", group: "portal" },
  { id: "request.quote_accepted", audience: "staff", group: "portal" },
  { id: "request.quote_declined", audience: "staff", group: "portal" },
  { id: "client.onboarded", audience: "staff", group: "portal" },
  { id: "project.accepted", audience: "client", group: "portal" },
  { id: "project.returned", audience: "client", group: "portal" },
  { id: "project.declined", audience: "client", group: "portal" },
  { id: "project.quoted", audience: "client", group: "portal" },
  { id: "project.comment", audience: "client", group: "portal" },
  { id: "project.file", audience: "client", group: "portal" },
] as const satisfies readonly { id: string; audience: Audience; group: string }[];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]["id"];

export type Person = { userId: string; email: string; name: string };

/** The tenant's staff — every member but its customers — narrowed by `where`, by name. */
export const staffOf = (tenantId: string, where?: SQL) => db
  .select({ userId: user.id, email: user.email, name: user.name })
  .from(member).innerJoin(user, eq(user.id, member.userId))
  .where(and(eq(member.organizationId, tenantId), notInArray(member.role, EXTERNAL_ROLES), where))
  .orderBy(user.name);

/** Tell `to` about one event: a bell row each, and a mail each, minus whoever switched that channel
 *  off for this type. The two are independent — a failed insert is logged and the mail still goes.
 *  Mail failures come back for the producer to record (`config_project_event.mailError`). */
export async function deliver(n: {
  tenantId: string; type: NotificationType; to: Person[];
  params: NotificationParams; path: string;
  mail: (to: Person) => Mail; mailKey: string;
}): Promise<SendResult> {
  if (!n.to.length) return { error: null };
  const off = await db.select({ userId: notificationOptout.userId, channel: notificationOptout.channel })
    .from(notificationOptout)
    .where(and(
      eq(notificationOptout.tenantId, n.tenantId), eq(notificationOptout.type, n.type),
      inArray(notificationOptout.userId, n.to.map((p) => p.userId)),
    ));
  const wants = (p: Person, channel: NotificationChannel) => !off.some((o) => o.userId === p.userId && o.channel === channel);
  const bell = n.to.filter((p) => wants(p, "bell"));
  if (bell.length) {
    await db.insert(notification)
      .values(bell.map((p) => ({ tenantId: n.tenantId, userId: p.userId, type: n.type, params: n.params, path: n.path })))
      .catch((e: unknown) => console.error(`[notify] bell ${n.type} failed`, e));
  }
  return sendMails(n.to.filter((p) => wants(p, "mail")).map(n.mail), n.mailKey);
}

// --- the bell and the settings page, for both routers ---------------------------------------------
// Every read and write is (the request's tenant, the session's user): the tenant comes out of the
// membership join, so a forged x-tenant reaches only a tenant the user belongs to, and only their rows.

const mine = (tenantId: string, userId: string) =>
  and(eq(notification.tenantId, tenantId), eq(notification.userId, userId));

export async function unreadCount(tenantId: string, userId: string) {
  const [r] = await db.select({ count: count() }).from(notification)
    .where(and(mine(tenantId, userId), isNull(notification.readAt)));
  return { count: r?.count ?? 0 };
}

/** Newest first. ponytail: the newest 50, no paging; keyset "More" on createdAt if anyone misses older. */
export const listNotifications = (tenantId: string, userId: string) => db
  .select({
    id: notification.id, type: notification.type, params: notification.params, path: notification.path,
    createdAt: notification.createdAt, read: sql<boolean>`${notification.readAt} is not null`,
  })
  .from(notification).where(mine(tenantId, userId))
  .orderBy(desc(notification.createdAt)).limit(50);

export const MarkReadZ = z.object({ ids: z.array(z.uuid()).max(500).optional() });
export const DismissZ = z.object({ id: z.uuid() });
export const PreferenceZ = z.object({ type: z.string().min(1), channel: z.enum(["bell", "mail"]), enabled: z.boolean() });

/** The given ids, or every unread one. Another user's id matches nothing. */
export async function markRead(tenantId: string, userId: string, ids?: string[]) {
  await db.update(notification).set({ readAt: new Date() })
    .where(and(mine(tenantId, userId), isNull(notification.readAt), ids ? inArray(notification.id, ids) : undefined));
}

/** The close button: the row goes. Another user's id matches nothing. */
export async function dismiss(tenantId: string, userId: string, id: string) {
  await db.delete(notification).where(and(mine(tenantId, userId), eq(notification.id, id)));
}

const typesOf = (audience: Audience) => NOTIFICATION_TYPES.filter((t) => t.audience === audience);

/** The settings table: every type the caller's side can receive, each channel on unless switched off.
 *  An opt-out whose type has left the catalog is simply never asked about. */
export async function preferences(tenantId: string, userId: string, audience: Audience) {
  const off = await db.select({ type: notificationOptout.type, channel: notificationOptout.channel })
    .from(notificationOptout)
    .where(and(eq(notificationOptout.tenantId, tenantId), eq(notificationOptout.userId, userId)));
  const on = (type: string, channel: NotificationChannel) => !off.some((o) => o.type === type && o.channel === channel);
  return typesOf(audience).map((t) => ({ id: t.id, group: t.group, bell: on(t.id, "bell"), mail: on(t.id, "mail") }));
}

export async function setPreference(tenantId: string, userId: string, audience: Audience, p: z.infer<typeof PreferenceZ>) {
  if (!typesOf(audience).some((t) => t.id === p.type)) throw new ORPCError("BAD_REQUEST", { message: `No notification ${p.type} here` });
  if (p.enabled) {
    await db.delete(notificationOptout).where(and(
      eq(notificationOptout.userId, userId), eq(notificationOptout.tenantId, tenantId),
      eq(notificationOptout.type, p.type), eq(notificationOptout.channel, p.channel),
    ));
  } else {
    await db.insert(notificationOptout).values({ userId, tenantId, type: p.type, channel: p.channel }).onConflictDoNothing();
  }
}
