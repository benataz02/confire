import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  db, configProject, configProjectEvent, member, projectFile,
  type ConfigProject, type ProjectEventKind, type ProjectEventPayload, type ProjectInputs, type ProjectStatus,
  type RevisionDiff,
} from "@confire/db";
import type { Val } from "@confire/config-engine";
import { sameJson } from "./canon.ts";
import { staffOf } from "./notifications.ts";
import { notifyInBackground } from "./notify.ts";

// A project's lifecycle (spec §7): the ONLY writer of config_project.status and of
// config_project_event. Both processes import it — the portal's buyer actions and the internal
// Requests inbox — so the two sides cannot enforce different rules (the portal/members.ts pattern).
//
// Every transition locks the row, checks where it stands, and writes the new status and its
// events in one transaction. The side that loses a race reads the status the winner left and gets
// a message naming it, instead of a lost write. Once a write commits, notify.ts tells whoever is
// eligible (notifications spec §4), off the request path.

export type Side = "internal" | "external";
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Who acts. `cardCode` is the portal seat's company — the external fence, always read against a
 *  project already loaded by (id, tenantId), since a CardCode alone names a company at every tenant. */
export type Actor = { userId: string; side: Side; cardCode?: string };

/** An internal read never sees a client's draft (spec §10): it is private until the first submit. */
export const internalVisible = or(isNull(configProject.portalCardCode), ne(configProject.status, "draft"));

/** assertWritable's rule again, as the WHERE of the input UPDATE that follows it — so an edit that
 *  races a submit or a send-back writes nothing rather than landing on the other side's status. */
export const writableBy = (side: Side) => side === "external"
  ? inArray(configProject.status, ["draft", "returned"])
  : and(ne(configProject.status, "quoted"), or(isNull(configProject.portalCardCode), eq(configProject.status, "in_review")));

/** assertWritable's rule as a plain test, for a project already loaded: what a view refreshes on
 *  read (config-project.ts) and what a page locks. */
export const canWrite = (p: Pick<ConfigProject, "status" | "portalCardCode">, side: Side): boolean =>
  p.portalCardCode === null ? side === "internal" && p.status !== "quoted"
  : side === "external" ? p.status === "draft" || p.status === "returned" : p.status === "in_review";

/** Client-facing words for a status (spec §7). */
export const STATUS_LABEL: Record<ProjectStatus, string> = {
  draft: "Draft", submitted: "Submitted", in_review: "In review", returned: "Changes requested",
  declined: "Declined", quoted: "Quoted",
};

const TRANSITIONS = {
  submit: { from: ["draft"], to: "submitted", side: "external", kind: "submitted" },
  withdraw: { from: ["submitted"], to: "draft", side: "external", kind: "withdrawn" },
  resubmit: { from: ["returned"], to: "submitted", side: "external", kind: "resubmitted" },
  accept: { from: ["submitted"], to: "in_review", side: "internal", kind: "accepted" },
  sendBack: { from: ["submitted", "in_review"], to: "returned", side: "internal", kind: "returned", revise: true },
  decline: { from: ["submitted", "in_review"], to: "declined", side: "internal", kind: "declined", revise: true },
  // An internal-only configuration quotes straight from draft; a portal one only from review.
  quote: { from: ["in_review"], to: "quoted", side: "internal", kind: "quoted", revise: true },
  quoteAccept: { from: ["quoted"], to: "quoted", side: "external", kind: "quote_accepted" },
  quoteDecline: { from: ["quoted"], to: "in_review", side: "external", kind: "quote_declined" },
} as const satisfies Record<string, {
  from: readonly ProjectStatus[]; to: ProjectStatus; side: Side; kind: ProjectEventKind; revise?: true;
}>;
export type Action = keyof typeof TRANSITIONS;

/** The events that freeze a round's inputs — the baseline a revision is diffed against (§7.4). */
const INPUT_EVENTS: ProjectEventKind[] = ["submitted", "resubmitted", "quoted"];

export const inputsOf = (p: Pick<ConfigProject, "entries" | "batches" | "tables">): ProjectInputs =>
  ({ entries: p.entries, batches: p.batches, tables: p.tables });

/** What staff changed since `base`, or null when nothing did (§7.4). Entry keys and table keys are
 *  stored; labels are resolved from the model when the timeline is read. */
export function revisionDiff(base: ProjectInputs, cur: ProjectInputs): RevisionDiff | null {
  const entries: RevisionDiff["entries"] = {};
  for (const k of new Set([...Object.keys(base.entries), ...Object.keys(cur.entries)])) {
    const a = base.entries[k] as Val | undefined;
    const b = cur.entries[k] as Val | undefined;
    if (!sameJson(a, b)) entries[k] = [a, b];
  }
  const tables: RevisionDiff["tables"] = {};
  for (const k of new Set([...Object.keys(base.tables), ...Object.keys(cur.tables)])) {
    const a = base.tables[k] ?? [];
    const b = cur.tables[k] ?? [];
    if (!sameJson(a, b)) tables[k] = [a.length, b.length];
  }
  const batchesChanged = !sameJson(base.batches, cur.batches);
  if (!Object.keys(entries).length && !Object.keys(tables).length && !batchesChanged) return null;
  return { entries, tables, ...(batchesChanged ? { batches: [base.batches, cur.batches] } : {}) };
}

/** Append one event. Private to this module and the two exported writers below. */
async function append(q: DbOrTx, e: {
  tenantId: string; projectId: string; kind: ProjectEventKind; actor: Actor;
  visibility?: "external" | "internal"; note?: string | null; payload?: ProjectEventPayload | null;
}) {
  const [row] = await q.insert(configProjectEvent).values({
    tenantId: e.tenantId, projectId: e.projectId, kind: e.kind,
    actorUserId: e.actor.userId, actorSide: e.actor.side,
    visibility: e.visibility ?? "external", note: e.note ?? null, payload: e.payload ?? null,
  }).returning({ id: configProjectEvent.id });
  return row!.id;
}

/** A project row the actor may see, or NOT_FOUND. The fence for both sides: a client sees only
 *  its company's projects; staff never see a client's draft. Not FORBIDDEN — a foreign id is
 *  indistinguishable from a missing one. */
function fenced<T extends { portalCardCode: string | null; status: ProjectStatus }>(row: T | undefined, actor: Actor): T {
  if (!row) throw new ORPCError("NOT_FOUND");
  if (actor.side === "external" && (!actor.cardCode || row.portalCardCode !== actor.cardCode))
    throw new ORPCError("NOT_FOUND");
  if (actor.side === "internal" && row.portalCardCode !== null && row.status === "draft")
    throw new ORPCError("NOT_FOUND");
  return row;
}

/** The project's `created` event — internal configurations too. */
export const recordCreated = (q: DbOrTx, tenantId: string, projectId: string, actor: Actor, payload?: ProjectEventPayload) =>
  append(q, { tenantId, projectId, kind: "created", actor, payload });

async function fencedProject(q: DbOrTx, tenantId: string, projectId: string, actor: Actor) {
  const [row] = await q.select({ portalCardCode: configProject.portalCardCode, status: configProject.status })
    .from(configProject).where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))).limit(1);
  return fenced(row, actor);
}

/** A comment, both ways (§8). A client's is always external; staff choose. */
export async function addComment(tenantId: string, projectId: string, actor: Actor, note: string, internalOnly: boolean) {
  await fencedProject(db, tenantId, projectId, actor);
  const id = await append(db, {
    tenantId, projectId, kind: "comment", actor, note,
    visibility: actor.side === "internal" && internalOnly ? "internal" : "external",
  });
  notifyInBackground(tenantId, id);
  return id;
}

/** A file on the timeline (D14), in any status a comment may be posted in — staff may keep it
 *  internal, as a note. The file and its event are one transaction; nothing deletes either. */
export async function addFile(
  tenantId: string, projectId: string, actor: Actor,
  file: { name: string; mime: string; data: Buffer }, internalOnly: boolean,
): Promise<{ id: string; eventId: string }> {
  const visibility = actor.side === "internal" && internalOnly ? "internal" : "external";
  const id = crypto.randomUUID();
  const eventId = await db.transaction(async (tx) => {
    await fencedProject(tx, tenantId, projectId, actor);
    const eventId = await append(tx, {
      tenantId, projectId, kind: "file", actor, visibility,
      payload: { fileId: id, name: file.name, size: file.data.length },
    });
    await tx.insert(projectFile).values({
      id, tenantId, projectId, eventId, name: file.name, mime: file.mime, size: file.data.length, data: file.data,
      uploadedBy: actor.userId, visibility,
    });
    return eventId;
  });
  notifyInBackground(tenantId, eventId);
  return { id, eventId };
}

/** A project's file as the actor may download it, or NOT_FOUND: the project fenced as for any
 *  read, and the portal sees `external` files only — the same fence as the timeline. */
export async function projectFileFor(tenantId: string, fileId: string, actor: Actor) {
  const [f] = await db.select().from(projectFile)
    .where(and(eq(projectFile.id, fileId), eq(projectFile.tenantId, tenantId))).limit(1);
  if (!f?.projectId || (actor.side === "external" && f.visibility !== "external")) throw new ORPCError("NOT_FOUND");
  await fencedProject(db, tenantId, f.projectId, actor);
  return f;
}

/** Hand a client's request to a colleague (spec 2026-10-22-notifications-design.md §6). `assigned` is
 *  an event like the rest, so this module stays its only writer: the row locked, the assignee and an
 *  internal `assigned` event in one transaction, the new assignee told after commit. Any status the
 *  actor may see — a draft is not one. Assigning the current assignee writes nothing. */
export async function assign(tenantId: string, projectId: string, actor: Actor, assigneeId: string) {
  if (actor.side !== "internal") throw new ORPCError("FORBIDDEN");
  const r = await db.transaction(async (tx) => {
    const [locked] = await tx.select({
      portalCardCode: configProject.portalCardCode, status: configProject.status, assigneeId: configProject.assigneeId,
    }).from(configProject)
      .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
      .for("update");
    const row = fenced(locked, actor);
    if (row.portalCardCode === null) throw new ORPCError("BAD_REQUEST", { message: "Only a client's request has an assignee" });
    const [target] = await staffOf(tenantId, eq(member.userId, assigneeId));
    if (!target) throw new ORPCError("BAD_REQUEST", { message: "Only someone in this workspace can be assigned" });
    if (row.assigneeId === assigneeId) return { eventId: null, name: target.name };
    await tx.update(configProject).set({ assigneeId, updatedAt: new Date() }).where(eq(configProject.id, projectId));
    const eventId = await append(tx, {
      tenantId, projectId, kind: "assigned", actor, visibility: "internal",
      payload: { assigneeId, assigneeName: target.name },
    });
    return { eventId, name: target.name };
  });
  if (r.eventId) notifyInBackground(tenantId, r.eventId);
  return { assigneeId, assigneeName: r.name };
}

/**
 * One writer per status (spec §7's side table). Every handler that writes a project's inputs goes
 * through this first — configs.update/calculate/select/remove and their portal counterparts.
 *
 * An internal-only project (portalCardCode null) keeps the old rule: editable until quoted.
 */
export async function assertWritable(
  tenantId: string, projectId: string, actor: Actor, q: DbOrTx = db,
): Promise<Pick<ConfigProject, "status" | "portalCardCode">> {
  const [row] = await q.select({ status: configProject.status, portalCardCode: configProject.portalCardCode })
    .from(configProject).where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))).limit(1);
  const p = fenced(row, actor);
  if (p.portalCardCode === null) {
    if (actor.side === "external") throw new ORPCError("NOT_FOUND");
    if (p.status === "quoted") throw new ORPCError("CONFLICT", { message: "Configuration is quoted and locked" });
    return p;
  }
  if (!canWrite(p, actor.side)) {
    throw new ORPCError("CONFLICT", {
      message: actor.side === "external"
        ? `This project is ${STATUS_LABEL[p.status].toLowerCase()} and can't be changed`
        : p.status === "submitted" ? "Accept the request before editing it"
        : `The request is ${STATUS_LABEL[p.status].toLowerCase()} and can't be changed`,
    });
  }
  return p;
}

/**
 * Move a project from one status to the next, with its events, in one transaction — then, after
 * commit, the event's notifications.
 *
 * `expectCalculatedAt` pins submit/resubmit to the calculation the caller checked its gates
 * against: any input write nulls `calculatedAt`, and a recalculate moves it, so a match proves the
 * inputs under the lock are the ones that passed. `payload` builds the event's payload from the
 * locked row; `set` adds columns to the same UPDATE.
 */
export async function transition(o: {
  tenantId: string; projectId: string; action: Action; actor: Actor;
  note?: string | null;
  expectCalculatedAt?: Date;
  payload?: (row: ConfigProject) => ProjectEventPayload | null;
  set?: Partial<typeof configProject.$inferInsert>;
}): Promise<{ from: ProjectStatus; to: ProjectStatus; eventId: string }> {
  const r = await db.transaction((tx) => step(tx, o));
  notifyInBackground(o.tenantId, r.eventId, r.revisedId);
  return { from: r.from, to: r.to, eventId: r.eventId };
}

async function step(tx: Tx, o: Parameters<typeof transition>[0]) {
  const t = TRANSITIONS[o.action];
  if (o.actor.side !== t.side) throw new ORPCError("FORBIDDEN");
  const [locked] = await tx.select().from(configProject)
    .where(and(eq(configProject.id, o.projectId), eq(configProject.tenantId, o.tenantId)))
    .for("update");
  const row = fenced(locked, o.actor);

  const internalOnly = row.portalCardCode === null;
  const from: readonly ProjectStatus[] = o.action === "quote" && internalOnly ? ["draft"] : t.from;
  if (!from.includes(row.status) || (internalOnly && o.action !== "quote")) {
    throw new ORPCError("CONFLICT", {
      message: `This project is ${STATUS_LABEL[row.status].toLowerCase()} now — reload to see what changed`,
    });
  }
  // Accept is final: it leaves the status `quoted`, so only this check refuses a decline after it.
  // A new `quote` clears the response, which makes the next quotation answerable again.
  if ((o.action === "quoteAccept" || o.action === "quoteDecline") && row.quoteResponse !== null)
    throw new ORPCError("CONFLICT", { message: "This quotation has already been answered" });
  if (o.expectCalculatedAt && row.calculatedAt?.getTime() !== o.expectCalculatedAt.getTime())
    throw new ORPCError("CONFLICT", { message: "The configuration changed while it was being checked — try again" });

  // One `revised` per round, written at the transition that closes it (§7.4) — never per edit.
  // It mails nobody on its own: the transition's own mail lists it.
  let revisedId: string | null = null;
  if ("revise" in t && !internalOnly) {
    const [base] = await tx.select({ payload: configProjectEvent.payload }).from(configProjectEvent)
      .where(and(eq(configProjectEvent.projectId, row.id), inArray(configProjectEvent.kind, INPUT_EVENTS)))
      .orderBy(desc(configProjectEvent.at)).limit(1);
    const inputs = (base?.payload as { inputs?: ProjectInputs } | null)?.inputs;
    const diff = inputs ? revisionDiff(inputs, inputsOf(row)) : null;
    if (diff) revisedId = await append(tx, { tenantId: o.tenantId, projectId: row.id, kind: "revised", actor: o.actor, payload: diff });
  }

  const now = new Date();
  await tx.update(configProject)
    .set({
      status: t.to, updatedAt: now,
      // Accept takes the request only when nobody holds it: one reassigned before anyone accepted stays put.
      ...(o.action === "accept" ? { assigneeId: row.assigneeId ?? o.actor.userId } : {}),
      ...(o.action === "quoteAccept" ? { quoteResponse: "accepted" as const, quoteRespondedAt: now } : {}),
      ...(o.action === "quoteDecline" ? { quoteResponse: "declined" as const, quoteRespondedAt: now } : {}),
      ...(o.action === "quote" ? { quoteResponse: null, quoteRespondedAt: null } : {}),
      ...o.set,
    })
    .where(eq(configProject.id, row.id));
  const eventId = await append(tx, {
    tenantId: o.tenantId, projectId: row.id, kind: t.kind, actor: o.actor,
    note: o.note?.trim() || null, payload: o.payload?.(row) ?? null,
  });
  return { from: row.status, to: t.to, eventId, revisedId };
}
