import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  db, configProject, configProjectEvent,
  type ConfigProject, type ProjectEventKind, type ProjectEventPayload, type ProjectInputs, type ProjectStatus,
  type RevisionDiff,
} from "@confire/db";
import type { Val } from "@confire/config-engine";
import { sameJson } from "./canon.ts";

// A project's lifecycle (spec §7): the ONLY writer of config_project.status and of
// config_project_event. Both processes import it — the portal's buyer actions and the internal
// Requests inbox — so the two sides cannot enforce different rules (the portal/members.ts pattern).
//
// Every transition locks the row, checks where it stands, and writes the new status and its
// events in one transaction. The side that loses a race reads the status the winner left and gets
// a message naming it, instead of a lost write.

export type Side = "internal" | "external";
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Who acts. `companyId` is the portal seat's company — the external fence. */
export type Actor = { userId: string; side: Side; companyId?: string };

/** An internal read never sees a client's draft (spec §10): it is private until the first submit. */
export const internalVisible = or(isNull(configProject.portalCompanyId), ne(configProject.status, "draft"));

/** assertWritable's rule again, as the WHERE of the input UPDATE that follows it — so an edit that
 *  races a submit or a send-back writes nothing rather than landing on the other side's status. */
export const writableBy = (side: Side) => side === "external"
  ? inArray(configProject.status, ["draft", "returned"])
  : and(ne(configProject.status, "quoted"), or(isNull(configProject.portalCompanyId), eq(configProject.status, "in_review")));

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
function fenced<T extends { portalCompanyId: string | null; status: ProjectStatus }>(row: T | undefined, actor: Actor): T {
  if (!row) throw new ORPCError("NOT_FOUND");
  if (actor.side === "external" && (!actor.companyId || row.portalCompanyId !== actor.companyId))
    throw new ORPCError("NOT_FOUND");
  if (actor.side === "internal" && row.portalCompanyId !== null && row.status === "draft")
    throw new ORPCError("NOT_FOUND");
  return row;
}

/** The project's `created` event — internal configurations too. */
export const recordCreated = (q: DbOrTx, tenantId: string, projectId: string, actor: Actor) =>
  append(q, { tenantId, projectId, kind: "created", actor });

/** A comment, both ways (§8). A client's is always external; staff choose. */
export async function addComment(tenantId: string, projectId: string, actor: Actor, note: string, internalOnly: boolean) {
  const [row] = await db.select({ portalCompanyId: configProject.portalCompanyId, status: configProject.status })
    .from(configProject).where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))).limit(1);
  fenced(row, actor);
  return append(db, {
    tenantId, projectId, kind: "comment", actor, note,
    visibility: actor.side === "internal" && internalOnly ? "internal" : "external",
  });
}

/**
 * One writer per status (spec §7's side table). Every handler that writes a project's inputs goes
 * through this first — configs.update/calculate/select/remove and their portal counterparts.
 *
 * An internal-only project (portalCompanyId null) keeps the old rule: editable until quoted.
 */
export async function assertWritable(
  tenantId: string, projectId: string, actor: Actor, q: DbOrTx = db,
): Promise<Pick<ConfigProject, "status" | "portalCompanyId">> {
  const [row] = await q.select({ status: configProject.status, portalCompanyId: configProject.portalCompanyId })
    .from(configProject).where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))).limit(1);
  const p = fenced(row, actor);
  if (p.portalCompanyId === null) {
    if (actor.side === "external") throw new ORPCError("NOT_FOUND");
    if (p.status === "quoted") throw new ORPCError("CONFLICT", { message: "Configuration is quoted and locked" });
    return p;
  }
  const ok = actor.side === "external" ? p.status === "draft" || p.status === "returned" : p.status === "in_review";
  if (!ok) {
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
 * Move a project from one status to the next, with its events, in one transaction.
 *
 * `expectCalculatedAt` pins submit/resubmit to the calculation the caller checked its gates
 * against: any input write nulls `calculatedAt`, and a recalculate moves it, so a match proves the
 * inputs under the lock are the ones that passed. `payload` builds the event's payload from the
 * locked row; `set` adds columns to the same UPDATE.
 */
export async function transition(tx: Tx, o: {
  tenantId: string; projectId: string; action: Action; actor: Actor;
  note?: string | null;
  expectCalculatedAt?: Date;
  payload?: (row: ConfigProject) => ProjectEventPayload | null;
  set?: Partial<typeof configProject.$inferInsert>;
}): Promise<{ from: ProjectStatus; to: ProjectStatus; eventId: string }> {
  const t = TRANSITIONS[o.action];
  if (o.actor.side !== t.side) throw new ORPCError("FORBIDDEN");
  const [locked] = await tx.select().from(configProject)
    .where(and(eq(configProject.id, o.projectId), eq(configProject.tenantId, o.tenantId)))
    .for("update");
  const row = fenced(locked, o.actor);

  const internalOnly = row.portalCompanyId === null;
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
  if ("revise" in t && !internalOnly) {
    const [base] = await tx.select({ payload: configProjectEvent.payload }).from(configProjectEvent)
      .where(and(eq(configProjectEvent.projectId, row.id), inArray(configProjectEvent.kind, INPUT_EVENTS)))
      .orderBy(desc(configProjectEvent.at)).limit(1);
    const inputs = (base?.payload as { inputs?: ProjectInputs } | null)?.inputs;
    const diff = inputs ? revisionDiff(inputs, inputsOf(row)) : null;
    if (diff) await append(tx, { tenantId: o.tenantId, projectId: row.id, kind: "revised", actor: o.actor, payload: diff });
  }

  const now = new Date();
  await tx.update(configProject)
    .set({
      status: t.to, updatedAt: now,
      ...(o.action === "accept" ? { assigneeId: o.actor.userId } : {}),
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
  return { from: row.status, to: t.to, eventId };
}
