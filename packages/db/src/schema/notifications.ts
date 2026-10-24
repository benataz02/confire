import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// Notifications (spec docs/superpowers/specs/2026-10-22-notifications-design.md §8): the bell's
// entries and each user's switch-offs. Written only by apps/server/src/notifications.ts, which both
// processes import. A row carries its own text inputs rather than a key to the event it came from,
// so an event that is not a project's can live in the same table.

export type NotificationChannel = "bell" | "mail";
/** The bell's text inputs, snapshotted like a mail: a renamed project does not rewrite old entries. */
export type NotificationParams = Record<string, string | number | null>;

// ponytail: no retention; delete read rows older than N days when the table hurts.
export const notification = pgTable(
  "notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    /** a catalog id: `request.submitted` */
    type: text("type").notNull(),
    params: jsonb("params").$type<NotificationParams>().notNull(),
    /** tenant-relative, in the recipient's app: `/configs/<id>`, `/projects/<id>` */
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notification_user_idx").on(t.userId, t.tenantId, t.createdAt.desc())],
);

/** Everything is on by default (§5): a row is one switch-off, and switching back on deletes it. A
 *  type added to the catalog later is therefore on for everyone, with no backfill. */
export const notificationOptout = pgTable(
  "notification_optout",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    channel: text("channel").$type<NotificationChannel>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tenantId, t.type, t.channel] })],
);
