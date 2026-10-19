import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  db, configModel, configProject, configProjectEvent, EXTERNAL_ROLE, member, portalCompany, user,
  type NotifyEvent, type NotifyMode, type PortalSettings, type RevisionDiff,
} from "@confire/db";
import { tenantConnector, tenantCurrency } from "./b1.ts";
import { modelLabels } from "./config-project.ts";
import { CONFIRE } from "./mail/layout.tsx";
import { sendMail, sendMails, type SendResult } from "./mail/mailer.ts";
import {
  clientOnboardedMail, clientProjectMail, staffRequestMail, type ClientEventKind, type StaffEventKind,
} from "./mail/portal-mail.tsx";
import { sendClientMail } from "./portal/sender-domain.ts";
import { tenantBrand } from "./portal/settings.ts";
import { appTenantUrl, portalTenantUrl } from "./tenant.ts";

// Who hears about a project event (spec §12, D22, D27), and the mail they get. Called once the
// event's transaction has committed, and never awaited by the request: a mail is never on the
// critical path, and a failure lands on the event row's `mailError` instead of failing anything.
// Recipients are resolved at send time, so someone who has left a company or the supplier since
// gets nothing.
// ponytail: no retry queue — there is no job runner; add an outbox table when a lost mail matters.

/** A staff action → the D27 setting that decides who on the client's side hears of it. A staff
 *  file counts as a comment. `revised` is absent: its transition's mail lists it. */
const CLIENT: Partial<Record<string, NotifyEvent>> = {
  accepted: "accepted", returned: "returned", declined: "declined", quoted: "quoted", comment: "comment", file: "comment",
};
/** A client action staff always hear of (§12, fixed). */
const STAFF = new Set<string>(["submitted", "resubmitted", "comment", "file", "quote_accepted", "quote_declined"]);

const inFlight = new Set<Promise<unknown>>();
/** Every send started so far, finished — what a test waits on before reading devOutbox. */
export const notificationsSettled = () => Promise.allSettled([...inFlight]);

function background(work: () => Promise<unknown>): void {
  const p: Promise<unknown> = work().catch((e) => console.error("[notify]", e)).finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** After commit: tell whoever §12 says about this event. `revisedId` is the `revised` event the
 *  same transition wrote, listed in its mail. */
export const notifyInBackground = (tenantId: string, eventId: string, revisedId: string | null = null) =>
  background(() => notifyEvent(tenantId, eventId, revisedId));

type Person = { userId: string; email: string; name: string };

/** The client's side (D27): `creator` is the project's creator, `buyers` adds every buyer and owner
 *  — as members of the company now. A viewer hears only of a project they created. */
export async function clientRecipients(tenantId: string, cardCode: string, createdBy: string, mode: NotifyMode): Promise<Person[]> {
  if (mode === "off") return [];
  const seats = await db
    .select({ userId: member.userId, email: user.email, name: user.name, role: member.portalRole })
    .from(member).innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, tenantId), eq(member.role, EXTERNAL_ROLE), eq(member.cardCode, cardCode)));
  return seats
    .filter((s) => s.userId === createdBy || (mode === "buyers" && s.role !== "viewer"))
    .map(({ role: _role, ...p }) => p);
}

/** The tenant's staff — every member but its customers — narrowed by `where`. */
const staff = (tenantId: string, where: SQL | undefined) => db
  .select({ userId: user.id, email: user.email, name: user.name })
  .from(member).innerJoin(user, eq(user.id, member.userId))
  .where(and(eq(member.organizationId, tenantId), ne(member.role, EXTERNAL_ROLE), where));

/** The BP's sales employee's email in B1 — `SalesPersonCode` → `SalesPersons.Email` (checked in the
 *  cached schema 2026-10-18; -1 is B1's "-No Sales Employee-"). Live, so anything that fails (no
 *  agent, agent down, no email) is a null and the caller falls back. */
async function salesEmployeeEmail(tenantId: string, cardCode: string): Promise<string | null> {
  try {
    const { b1 } = await tenantConnector(tenantId);
    const bp = (await b1.readEntity("BusinessPartners", cardCode, { select: ["SalesPersonCode"] })).data as { SalesPersonCode?: unknown };
    const code = Number(bp.SalesPersonCode);
    if (!Number.isInteger(code) || code < 0) return null;
    const sp = (await b1.readEntity("SalesPersons", code, { select: ["Email"] })).data as { Email?: unknown };
    return typeof sp.Email === "string" && sp.Email.trim() ? sp.Email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** D22: the request's assignee (while still on staff), else the BP's sales employee matched to a
 *  member by email, else the tenant's picked fallback members, else its admins and owners — so a
 *  request is never silent. */
export async function staffRecipients(
  tenantId: string, assigneeId: string | null, cardCode: string, settings: PortalSettings,
): Promise<Person[]> {
  if (assigneeId) {
    const r = await staff(tenantId, eq(member.userId, assigneeId));
    if (r.length) return r;
  }
  const sales = await salesEmployeeEmail(tenantId, cardCode);
  if (sales) {
    const r = await staff(tenantId, sql`lower(${user.email}) = ${sales}`);
    if (r.length) return r;
  }
  if (settings.notifyFallback?.length) {
    const r = await staff(tenantId, inArray(member.userId, settings.notifyFallback));
    if (r.length) return r;
  }
  return staff(tenantId, inArray(member.role, ["admin", "owner"]));
}

const show = (v: unknown): string =>
  v === undefined || v === null || v === "" ? "—"
  : Array.isArray(v) ? v.join(", ")
  : typeof v === "boolean" ? (v ? "Yes" : "No")
  : String(v);

/** A revision as the lines its mail lists — the timeline's Revision, as text. */
export function revisionLines(d: RevisionDiff, labels: Record<string, string>): string[] {
  return [
    ...Object.entries(d.entries).map(([k, [a, b]]) => `${labels[k] ?? k}: ${show(a)} → ${show(b)}`),
    ...(d.batches ? [`Batch quantities: ${show(d.batches[0])} → ${show(d.batches[1])}`] : []),
    ...Object.entries(d.tables).map(([k, [a, b]]) =>
      `${labels[k] ?? k}: ${a === b ? `${b} row${b === 1 ? "" : "s"} changed` : `${a} → ${b} rows`}`),
  ];
}

async function revisionOf(revisedId: string, modelId: string): Promise<string[]> {
  const [[ev], [m]] = await Promise.all([
    db.select({ payload: configProjectEvent.payload }).from(configProjectEvent).where(eq(configProjectEvent.id, revisedId)).limit(1),
    db.select({ definition: configModel.definition }).from(configModel).where(eq(configModel.id, modelId)).limit(1),
  ]);
  return ev?.payload ? revisionLines(ev.payload as RevisionDiff, modelLabels(m?.definition)) : [];
}

async function notifyEvent(tenantId: string, eventId: string, revisedId: string | null): Promise<void> {
  const [e] = await db
    .select({
      kind: configProjectEvent.kind, actorSide: configProjectEvent.actorSide, visibility: configProjectEvent.visibility,
      note: configProjectEvent.note, payload: configProjectEvent.payload, projectId: configProjectEvent.projectId,
      actorName: user.name, actorEmail: user.email,
    })
    .from(configProjectEvent).leftJoin(user, eq(user.id, configProjectEvent.actorUserId))
    .where(and(eq(configProjectEvent.id, eventId), eq(configProjectEvent.tenantId, tenantId)))
    .limit(1);
  // An internal note is for staff's eyes only, and mails nobody.
  if (!e || e.visibility === "internal") return;
  const toClient = e.actorSide === "internal" ? CLIENT[e.kind] : undefined;
  const toStaff = e.actorSide === "external" && STAFF.has(e.kind);
  if (!toClient && !toStaff) return;

  const [p] = await db
    .select({
      name: configProject.name, status: configProject.status, createdBy: configProject.createdBy,
      assigneeId: configProject.assigneeId, modelId: configProject.modelId,
      cardCode: portalCompany.cardCode, cardName: portalCompany.cardName,
      companyNotify: portalCompany.notify,
    })
    .from(configProject)
    .innerJoin(portalCompany, and(eq(portalCompany.tenantId, configProject.tenantId), eq(portalCompany.cardCode, configProject.portalCardCode)))
    .where(and(eq(configProject.id, e.projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  // No company: an internal-only configuration, with no client to tell. A client's draft is still
  // private (§10), so its comments and files reach no one at the supplier.
  if (!p || (toStaff && p.status === "draft")) return;

  const { slug, brand, settings } = await tenantBrand(tenantId);
  const actorName = e.actorName ?? "Someone";
  const fileName = e.kind === "file" ? ((e.payload as { name?: string } | null)?.name ?? null) : null;
  const key = `batch-event/${eventId}`;
  let r: SendResult;
  if (toClient) {
    const mode = p.companyNotify?.[toClient] ?? settings.notify?.[toClient] ?? "buyers";
    const to = await clientRecipients(tenantId, p.cardCode, p.createdBy, mode);
    if (!to.length) return;
    const q = e.kind === "quoted" ? (e.payload as { docNum: number | null; value: number }) : null;
    const currency = q ? await tenantCurrency(tenantId) : null;
    const common = {
      brand, kind: e.kind as ClientEventKind, projectName: p.name, actorName, note: e.note, fileName,
      revision: revisedId ? await revisionOf(revisedId, p.modelId) : [],
      quote: q ? {
        docNum: q.docNum,
        value: `${q.value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`,
      } : null,
      url: portalTenantUrl(slug, `/projects/${e.projectId}`),
      // The tenant's sales address, else the staff member who acted.
      replyTo: settings.replyTo || e.actorEmail || undefined,
    };
    r = await sendClientMail(settings, tenantId, to.map((x) => clientProjectMail({ ...common, to: x.email })), key);
  } else {
    // Internal mail is Confire's, from mail.<domain> (D29), and replies to the client who acted.
    const to = await staffRecipients(tenantId, p.assigneeId, p.cardCode, settings);
    const common = {
      brand: CONFIRE, kind: e.kind as StaffEventKind, companyName: p.cardName, projectName: p.name, actorName, note: e.note, fileName,
      url: appTenantUrl(slug, `/configs/${e.projectId}`), replyTo: e.actorEmail ?? undefined,
    };
    r = await sendMails(to.map((x) => staffRequestMail({ ...common, to: x.email })), key);
  }
  if (r.error) await db.update(configProjectEvent).set({ mailError: r.error }).where(eq(configProjectEvent.id, eventId));
}

/** §5.4 step 6: the inviter hears that their new client's lead now exists in B1 — if they still
 *  work for the supplier. Internal mail, replying to the client. */
export function notifyOnboarded(o: {
  tenantId: string; invitationId: string; inviterId: string | null;
  client: { name: string; email: string }; cardCode: string; cardName: string;
}): void {
  background(async () => {
    if (!o.inviterId) return;
    const [inviter] = await staff(o.tenantId, eq(member.userId, o.inviterId));
    if (!inviter) return;
    const { slug } = await tenantBrand(o.tenantId);
    const r = await sendMail(clientOnboardedMail({
      brand: CONFIRE, to: inviter.email, replyTo: o.client.email, invitationId: o.invitationId,
      clientName: o.client.name, clientEmail: o.client.email, cardCode: o.cardCode, cardName: o.cardName,
      url: appTenantUrl(slug, `/b1/BusinessPartners/${encodeURIComponent(o.cardCode)}`),
    }));
    if (r.error) console.error(`[mail] onboarded ${o.cardCode} -> ${inviter.email} failed: ${r.error}`);
  });
}
