import { ORPCError } from "@orpc/server";
import { and, asc, eq } from "drizzle-orm";
import { db, configModel, configProject, configProjectEvent, user, type ProjectEventPayload } from "@confire/db";
import { tenantConnector, viaB1 } from "./b1.ts";
import { documentChain, type ChainDoc } from "./doc-chain.ts";
import { modelLabels } from "./config-project.ts";
import { internalVisible, type Actor } from "./project-lifecycle.ts";

// A project's timeline (spec §8), for both sides: the events, and the SAP documents its quotations
// became. The two are separate reads on purpose — events are Postgres and always load; documents
// are live SAP reads, and an agent that is down must cost the document rows, not the timeline.

/** The project, fenced for the actor: a client reads only its company's, staff never a client's
 *  draft. */
async function projectFor(tenantId: string, projectId: string, actor: Actor) {
  if (actor.side === "external" && !actor.cardCode) throw new ORPCError("NOT_FOUND");
  const [p] = await db
    .select({
      modelId: configProject.modelId, b1DocEntry: configProject.b1DocEntry,
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
 *  overrides included, is not theirs to read. */
function externalPayload(p: ProjectEventPayload | null): ProjectEventPayload | null {
  if (!p || !("inputs" in p)) return p;
  const { inputs: _inputs, ...rest } = p;
  return rest as ProjectEventPayload;
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
      note: configProjectEvent.note, payload: configProjectEvent.payload,
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
    })),
    labels,
  };
}

export type ProjectDocuments = {
  /** one per quotation the project has had, newest first; `current` is the one b1DocEntry names */
  quotations: { quotation: ChainDoc; chain: ChainDoc[]; current: boolean }[];
};

/** Every quotation in the project's `quoted` events, and what SAP made of each (§8). Live. A client
 *  sees a document only when its CardCode is the company's. */
export async function projectDocuments(tenantId: string, projectId: string, actor: Actor): Promise<ProjectDocuments> {
  const p = await projectFor(tenantId, projectId, actor);
  const quoted = await db.select({ payload: configProjectEvent.payload }).from(configProjectEvent)
    .where(and(eq(configProjectEvent.projectId, projectId), eq(configProjectEvent.kind, "quoted")))
    .orderBy(asc(configProjectEvent.at));
  const entries = [...new Set(quoted.map((q) => (q.payload as { docEntry?: number } | null)?.docEntry)
    .filter((d): d is number => typeof d === "number"))].reverse();
  if (!entries.length) return { quotations: [] };

  const cardCode = p.customer?.cardCode;
  const mine = (d: ChainDoc) => actor.side === "internal" || d.cardCode === cardCode;
  const { b1 } = await tenantConnector(tenantId);
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
        quotation, chain: (await documentChain(b1, docEntry)).filter(mine), current: docEntry === p.b1DocEntry,
      });
    }
    return { quotations };
  });
}
