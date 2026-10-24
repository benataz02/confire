import { and, eq, inArray } from "drizzle-orm";
import {
  db, configModel, configProject, configProjectEvent, EXTERNAL_ROLES, member, portalCompany, user, type RevisionDiff,
} from "@confire/db";
import { tenantCurrency } from "./b1.ts";
import { modelLabels } from "./config-project.ts";
import { CONFIRE, MAIL_LOCALE, mailLang, type MailLang } from "./mail/layout.tsx";
import type { SendResult } from "./mail/mailer.ts";
import {
  clientOnboardedMail, clientProjectMail, staffRequestMail, type ClientEventKind, type StaffEventKind,
} from "./mail/portal-mail.tsx";
import { deliver, staffOf, type NotificationType, type Person } from "./notifications.ts";
import { tenantBrand } from "./portal/settings.ts";
import { appTenantUrl, portalTenantUrl } from "./tenant.ts";

// The producer of project notifications (spec 2026-10-22-notifications-design.md §4, §7): which
// catalog type an event is, who is eligible, and the mail they would get — notifications.ts then
// applies each person's own switches. Called once the event's transaction has committed, and never
// awaited by the request: a notification is never on the critical path, and a mail failure lands on
// the event row's `mailError` instead of failing anything. Eligibility is read at send time, so
// someone who has left the company or the supplier since gets nothing. Whoever caused the event is
// never told of it.
// ponytail: no retry queue — there is no job runner; add an outbox table when a lost mail matters.

/** A client's action → what staff hear. */
const STAFF: Partial<Record<string, NotificationType>> = {
  submitted: "request.submitted", resubmitted: "request.resubmitted", comment: "request.comment", file: "request.file",
  quote_accepted: "request.quote_accepted", quote_declined: "request.quote_declined",
};
/** A staff action → what the client hears. `revised` is absent: its transition's mail lists it. */
const CLIENT: Partial<Record<string, NotificationType>> = {
  accepted: "project.accepted", returned: "project.returned", declined: "project.declined", quoted: "project.quoted",
  comment: "project.comment", file: "project.file",
};

const inFlight = new Set<Promise<unknown>>();
/** Every notification started so far, finished — what a test waits on before reading devOutbox. */
export const notificationsSettled = () => Promise.allSettled([...inFlight]);

function background(work: () => Promise<unknown>): void {
  const p: Promise<unknown> = work().catch((e) => console.error("[notify]", e)).finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** After commit: tell whoever §4 makes eligible. `revisedId` is the `revised` event the same
 *  transition wrote, listed in its mail. */
export const notifyInBackground = (tenantId: string, eventId: string, revisedId: string | null = null) =>
  background(() => notifyEvent(tenantId, eventId, revisedId));

/** The client side (§4): the project's creator, while they still hold a seat at its company. */
const creator = (tenantId: string, cardCode: string, userId: string): Promise<Person[]> => db
  .select({ userId: user.id, email: user.email, name: user.name })
  .from(member).innerJoin(user, eq(user.id, member.userId))
  .where(and(
    eq(member.organizationId, tenantId), inArray(member.role, EXTERNAL_ROLES),
    eq(member.cardCode, cardCode), eq(member.userId, userId),
  ));

/** The staff side (§4): the assignee while still on staff. With none — a first submit, or an assignee
 *  who has left — every staff member, of whom notifications.ts keeps those who have the type on, so a
 *  request is never silent. */
async function assigneeOrStaff(tenantId: string, assigneeId: string | null): Promise<Person[]> {
  if (assigneeId) {
    const r = await staffOf(tenantId, eq(member.userId, assigneeId));
    if (r.length) return r;
  }
  return staffOf(tenantId);
}

/** The words a revision line is built from, in the client mail's language. */
const REVISION_WORDS: Record<MailLang, { yes: string; no: string; batches: string; changed: (n: number) => string; rows: string }> = {
  en: { yes: "Yes", no: "No", batches: "Batch quantities", changed: (n) => `${n} row${n === 1 ? "" : "s"} changed`, rows: "rows" },
  es: { yes: "Sí", no: "No", batches: "Cantidades por lote", changed: (n) => `${n} fila${n === 1 ? " modificada" : "s modificadas"}`, rows: "filas" },
};

/** A revision as the lines its mail lists — the timeline's Revision, as text. */
export function revisionLines(d: RevisionDiff, labels: Record<string, string>, lang: MailLang = "en"): string[] {
  const w = REVISION_WORDS[lang];
  const show = (v: unknown): string =>
    v === undefined || v === null || v === "" ? "—"
    : Array.isArray(v) ? v.join(", ")
    : typeof v === "boolean" ? (v ? w.yes : w.no)
    : String(v);
  return [
    ...Object.entries(d.entries).map(([k, [a, b]]) => `${labels[k] ?? k}: ${show(a)} → ${show(b)}`),
    ...(d.batches ? [`${w.batches}: ${show(d.batches[0])} → ${show(d.batches[1])}`] : []),
    ...Object.entries(d.tables).map(([k, [a, b]]) =>
      `${labels[k] ?? k}: ${a === b ? w.changed(b) : `${a} → ${b} ${w.rows}`}`),
  ];
}

async function revisionOf(revisedId: string, modelId: string, lang: MailLang): Promise<string[]> {
  const [[ev], [m]] = await Promise.all([
    db.select({ payload: configProjectEvent.payload }).from(configProjectEvent).where(eq(configProjectEvent.id, revisedId)).limit(1),
    db.select({ definition: configModel.definition }).from(configModel).where(eq(configModel.id, modelId)).limit(1),
  ]);
  return ev?.payload ? revisionLines(ev.payload as RevisionDiff, modelLabels(m?.definition), lang) : [];
}

/** The bell shows a note's start; the mail and the timeline carry all of it. */
const excerpt = (note: string | null) => note && note.length > 140 ? `${note.slice(0, 139).trimEnd()}…` : note;

async function notifyEvent(tenantId: string, eventId: string, revisedId: string | null): Promise<void> {
  const [e] = await db
    .select({
      kind: configProjectEvent.kind, actorSide: configProjectEvent.actorSide, actorUserId: configProjectEvent.actorUserId,
      visibility: configProjectEvent.visibility, note: configProjectEvent.note, payload: configProjectEvent.payload,
      projectId: configProjectEvent.projectId, actorName: user.name,
    })
    .from(configProjectEvent).leftJoin(user, eq(user.id, configProjectEvent.actorUserId))
    .where(and(eq(configProjectEvent.id, eventId), eq(configProjectEvent.tenantId, tenantId)))
    .limit(1);
  if (!e) return;
  // `assigned` is staff's own business, internal by nature. Any other internal event — a note, a
  // file kept internal — is for staff's eyes only and tells nobody.
  const type = e.kind === "assigned" ? "request.assigned"
    : e.visibility === "internal" ? undefined
    : e.actorSide === "external" ? STAFF[e.kind] : CLIENT[e.kind];
  if (!type) return;

  const [p] = await db
    .select({
      name: configProject.name, status: configProject.status, createdBy: configProject.createdBy,
      assigneeId: configProject.assigneeId, modelId: configProject.modelId,
      cardCode: portalCompany.cardCode, cardName: portalCompany.cardName, languageCode: portalCompany.languageCode,
    })
    .from(configProject)
    .innerJoin(portalCompany, and(eq(portalCompany.tenantId, configProject.tenantId), eq(portalCompany.cardCode, configProject.portalCardCode)))
    .where(and(eq(configProject.id, e.projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  // No company: an internal-only configuration, with no client to tell. A client's draft is still
  // private (§10), so its comments and files reach no one at the supplier.
  if (!p || (e.actorSide === "external" && p.status === "draft")) return;

  const eligible = type.startsWith("project.") ? await creator(tenantId, p.cardCode, p.createdBy)
    // The new assignee only: "assigned to you" means nothing to anyone else.
    : type === "request.assigned" ? await staffOf(tenantId, eq(member.userId, (e.payload as { assigneeId: string }).assigneeId))
    : await assigneeOrStaff(tenantId, p.assigneeId);
  const to = eligible.filter((x) => x.userId !== e.actorUserId);
  if (!to.length) return;

  const { slug, brand } = await tenantBrand(tenantId);
  const actorName = e.actorName ?? "Someone";
  const fileName = e.kind === "file" ? ((e.payload as { name?: string } | null)?.name ?? null) : null;
  const params = { projectName: p.name, actorName, note: excerpt(e.note), fileName };
  const mailKey = `batch-event/${eventId}`;
  let r: SendResult;
  if (type.startsWith("project.")) {
    const q = e.kind === "quoted" ? (e.payload as { docNum: number | null; value: number }) : null;
    const currency = q ? await tenantCurrency(tenantId) : null;
    const path = `/projects/${e.projectId}`;
    // The client's mail is in its company's SAP language.
    const lang = mailLang(p.languageCode);
    const common = {
      brand, kind: e.kind as ClientEventKind, projectName: p.name, note: e.note, fileName, lang,
      actorName: e.actorName ?? (lang === "es" ? "Alguien" : "Someone"),
      revision: revisedId ? await revisionOf(revisedId, p.modelId, lang) : [],
      quote: q ? {
        docNum: q.docNum,
        value: `${q.value.toLocaleString(MAIL_LOCALE[lang], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`,
      } : null,
      url: portalTenantUrl(slug, path),
    };
    r = await deliver({
      tenantId, type, to, params: q ? { ...params, docNum: q.docNum } : params, path, mailKey,
      mail: (x) => clientProjectMail({ ...common, to: x.email }),
    });
  } else {
    // Internal mail is Confire's, from notify@mail.<domain>.
    const path = `/configs/${e.projectId}`;
    const common = {
      brand: CONFIRE, kind: e.kind as StaffEventKind, companyName: p.cardName, projectName: p.name, actorName, note: e.note, fileName,
      url: appTenantUrl(slug, path),
    };
    r = await deliver({
      tenantId, type, to, params: { ...params, companyName: p.cardName }, path, mailKey,
      mail: (x) => staffRequestMail({ ...common, to: x.email }),
    });
  }
  if (r.error) await db.update(configProjectEvent).set({ mailError: r.error }).where(eq(configProjectEvent.id, eventId));
}

/** §5.4 step 6: the inviter hears that their new client's lead now exists in B1 — if they still
 *  work for the supplier. */
export function notifyOnboarded(o: {
  tenantId: string; invitationId: string; inviterId: string | null;
  client: { name: string; email: string }; cardCode: string; cardName: string;
}): void {
  background(async () => {
    if (!o.inviterId) return;
    const to = await staffOf(o.tenantId, eq(member.userId, o.inviterId));
    if (!to.length) return;
    const { slug } = await tenantBrand(o.tenantId);
    const path = `/b1/BusinessPartners/${encodeURIComponent(o.cardCode)}`;
    const r = await deliver({
      tenantId: o.tenantId, type: "client.onboarded", to, path, mailKey: `onboarded/${o.invitationId}`,
      params: { actorName: o.client.name, companyName: o.cardName, cardCode: o.cardCode },
      mail: (x) => clientOnboardedMail({
        brand: CONFIRE, to: x.email, invitationId: o.invitationId,
        clientName: o.client.name, clientEmail: o.client.email, cardCode: o.cardCode, cardName: o.cardName,
        url: appTenantUrl(slug, path),
      }),
    });
    if (r.error) console.error(`[mail] onboarded ${o.cardCode} failed: ${r.error}`);
  });
}
