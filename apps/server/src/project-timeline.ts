import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { db, configModel, configProject, configProjectEvent, user, type ProjectEventPayload } from "@confire/db";
import { tenantConnector, viaB1 } from "./b1.ts";
import { documentChain, furthestSteps, type ChainDoc } from "./doc-chain.ts";
import { modelLabels } from "./config-project.ts";
import { advanceStep, internalVisible, type Actor } from "./project-lifecycle.ts";

// A project's timeline (spec §8), for both sides: the events, and the SAP documents its quotations
// became. The two are separate reads on purpose — events are Postgres and always load; documents
// are live SAP reads, and an agent that is down must cost the document rows, not the timeline.

/** The project, fenced for the actor: a client reads only its company's, staff never a client's
 *  draft. */
async function projectFor(tenantId: string, projectId: string, actor: Actor) {
  if (actor.side === "external" && !actor.cardCode) throw new ORPCError("NOT_FOUND");
  const [p] = await db
    .select({
      modelId: configProject.modelId, b1DocEntry: configProject.b1DocEntry, b1Company: configProject.b1Company,
      portalCardCode: configProject.portalCardCode, customer: configProject.customer,
    })
    .from(configProject)
    .where(and(
      eq(configProject.id, projectId), eq(configProject.tenantId, tenantId),
      actor.side === "external" ? eq(configProject.portalCardCode, actor.cardCode!) : internalVisible,
    ))
    .limit(1);
  if (!p) throw new ORPCError("NOT_FOUND");
  return p;
}

/** What a client may read of an event payload. The frozen inputs stay home — the client has the
 *  revision diff and the configuration itself; a snapshot of every stored cell, salesperson
 *  overrides included, is not theirs to read. Nor is why a document was not emailed: a sent
 *  document's `error` (document-mail spec §5.8) is staff's. */
export function externalPayload(p: ProjectEventPayload | null): ProjectEventPayload | null {
  if (!p) return p;
  if ("inputs" in p) {
    const { inputs: _inputs, ...rest } = p;
    return rest as ProjectEventPayload;
  }
  if ("fileId" in p && "to" in p) {
    const { error: _error, ...rest } = p;
    return rest;
  }
  return p;
}

/** The events, oldest first, with the actor's name, plus the labels to read a revision with —
 *  keys are stored, labels are the model's as it is now (§7.4). The portal reads `external` only:
 *  the SQL filter is the fence, nothing is hidden by the page. */
export async function timelineEvents(tenantId: string, projectId: string, actor: Actor) {
  const p = await projectFor(tenantId, projectId, actor);
  const rows = await db
    .select({
      id: configProjectEvent.id, at: configProjectEvent.at, kind: configProjectEvent.kind,
      actorSide: configProjectEvent.actorSide, actorName: user.name, visibility: configProjectEvent.visibility,
      note: configProjectEvent.note, payload: configProjectEvent.payload, mailedTo: configProjectEvent.mailedTo,
    })
    .from(configProjectEvent)
    .leftJoin(user, eq(user.id, configProjectEvent.actorUserId))
    .where(and(
      eq(configProjectEvent.projectId, projectId),
      eq(configProjectEvent.tenantId, tenantId),
      ...(actor.side === "external" ? [eq(configProjectEvent.visibility, "external")] : []),
    ))
    .orderBy(asc(configProjectEvent.at));
  const [model] = await db.select({ definition: configModel.definition }).from(configModel)
    .where(eq(configModel.id, p.modelId)).limit(1);
  const labels = modelLabels(model?.definition);
  return {
    events: rows.map((r) => ({
      ...r, actorName: r.actorName ?? null,
      payload: actor.side === "external" ? externalPayload(r.payload) : r.payload,
      // A client reads who was mailed only when it was its own side (a staff action's mail); the
      // staff addresses a client's action mailed are not theirs.
      mailedTo: actor.side === "external" && r.actorSide === "external" ? null : r.mailedTo,
    })),
    labels,
  };
}

export type ProjectDocuments = {
  /** one per quotation the project has had, newest first; `current` is the one b1DocEntry names */
  quotations: { quotation: ChainDoc; chain: ChainDoc[]; current: boolean }[];
};

/** Every quotation in the project's `quoted` events, and what SAP made of each (§8). Live. A client
 *  sees a document only when its CardCode is the company's; nobody sees one posted in another SAP
 *  company than the agent serves now — its DocEntry would name a stranger's document here. */
export async function projectDocuments(tenantId: string, projectId: string, actor: Actor): Promise<ProjectDocuments> {
  const p = await projectFor(tenantId, projectId, actor);
  const quoted = await db.select({ payload: configProjectEvent.payload }).from(configProjectEvent)
    .where(and(eq(configProjectEvent.projectId, projectId), eq(configProjectEvent.kind, "quoted")))
    .orderBy(asc(configProjectEvent.at));
  const { b1, companyDb } = await tenantConnector(tenantId);
  const entries = [...new Set(quoted
    .map((q) => q.payload as { docEntry?: number; company?: string | null } | null)
    .filter((q) => (q?.company ?? p.b1Company) === companyDb)
    .map((q) => q?.docEntry)
    .filter((d): d is number => typeof d === "number"))].reverse();
  if (!entries.length) return { quotations: [] };

  const cardCode = p.customer?.cardCode;
  const mine = (d: ChainDoc) => actor.side === "internal" || d.cardCode === cardCode;
  return viaB1(async () => {
    const quotations: ProjectDocuments["quotations"] = [];
    for (const docEntry of entries) {
      // ponytail: one read + three crossjoins per quotation, sequential, on every timeline open.
      // Cache on the event row if it ever shows up in a trace.
      const q = (await b1.readEntity("Quotations", docEntry, {
        select: ["DocEntry", "DocNum", "DocDate", "DocTotal", "DocumentStatus", "CardCode"],
      })).data as Record<string, unknown>;
      const quotation: ChainDoc = {
        entity: "Quotations", docEntry, docNum: Number(q.DocNum ?? 0), docDate: String(q.DocDate ?? ""),
        docTotal: Number(q.DocTotal ?? 0), docStatus: String(q.DocumentStatus ?? ""), cardCode: String(q.CardCode ?? ""),
      };
      if (!mine(quotation)) continue;
      quotations.push({
        quotation, chain: (await documentChain(b1, docEntry)).filter(mine), current: docEntry === p.b1DocEntry && p.b1Company === companyDb,
      });
    }
    return { quotations };
  });
}

/** How far SAP has taken the tenant's projects `fence` selects — internal configurations and client
 *  requests alike: walks the document chains of their quotations in the agent's company (a DocEntry
 *  means nothing in another) and moves each status SAP took further (advanceStep: forward only, with
 *  its event). An invoiced project is never walked again. `userId`: whoever made the document through
 *  Confire, null for a read that only found it. Answers how many moved. The portal home runs it over
 *  the company, each project page over itself, and a copy over the projects behind its sources. */
export async function advanceSapSteps(tenantId: string, fence: SQL | undefined, userId: string | null = null): Promise<number> {
  const { b1, companyDb } = await tenantConnector(tenantId);
  if (!companyDb) return 0;
  const open = await db.select({ id: configProject.id, docEntry: configProject.b1DocEntry })
    .from(configProject)
    .where(and(
      eq(configProject.tenantId, tenantId), fence, inArray(configProject.status, ["quoted", "ordered", "delivered"]),
      isNotNull(configProject.b1DocEntry), eq(configProject.b1Company, companyDb),
    ));
  if (!open.length) return 0;
  const found = await viaB1(() => furthestSteps(b1, open.map((p) => p.docEntry!)));
  let changed = 0;
  for (const p of open) {
    const f = found.get(p.docEntry!);
    if (!f) continue;
    const doc = { entity: f.entity, docEntry: f.docEntry, docNum: f.docNum, docDate: f.at, company: companyDb };
    if (await advanceStep(tenantId, p.id, f.step, doc, userId)) changed++;
  }
  return changed;
}

/** advanceSapSteps for the one project a page opens, fenced like its timeline (a client's own
 *  company; staff never a client's draft). The page refetches the project when it moved. */
export async function projectProgress(tenantId: string, projectId: string, actor: Actor): Promise<{ changed: boolean }> {
  await projectFor(tenantId, projectId, actor);
  const n = await advanceSapSteps(tenantId, eq(configProject.id, projectId));
  return { changed: n > 0 };
}
