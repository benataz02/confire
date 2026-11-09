import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, assistantReport, assistantThread, type ReportDef } from "@confire/db";
import { forget, header, put, type Tx } from "../sap-cache.ts";
import type { ReportResult } from "./types.ts";

// A user's reports and their chats (reports spec §4): personal — every read and write is on
// (tenant, user). A report has one chat, the one that built it; deleting the report deletes the chat.
// Its last run — the home tile's figure — is a `report` entry in sap_cache: SAP's data, of the
// company it read, so a company switch hides it as it does every other entry.

/** A general chat's first report_set (reports spec §4): the chat becomes a new report's. Under the
 *  run's lease; `report_id is null` keeps a second adoption from relinking a chat that has one. */
export async function adoptReport(tenantId: string, userId: string, threadId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [r] = await tx.insert(assistantReport).values({ tenantId, userId }).returning({ id: assistantReport.id });
    const linked = await tx.update(assistantThread).set({ reportId: r!.id })
      .where(and(eq(assistantThread.id, threadId), eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId), isNull(assistantThread.reportId), isNull(assistantThread.projectId)))
      .returning({ id: assistantThread.id });
    if (!linked.length) throw new ORPCError("CONFLICT");
    return r!.id;
  });
}

export type StoredReport = {
  id: string; title: string; saved: boolean; definition: ReportDef | null;
  lastResult: ReportResult | null; lastRunAt: Date | null; updatedAt: Date; threadId: string;
};

const columns = (tenantId: string) => {
  const last = header(tenantId, "report", sql`${assistantReport.id}::text`);
  return {
    id: assistantReport.id, title: assistantReport.title, saved: assistantReport.saved, definition: assistantReport.definition,
    lastResult: last.data, lastRunAt: last.fetchedAt, updatedAt: assistantReport.updatedAt, threadId: assistantThread.id,
  };
};

/** One of the user's reports, or NOT_FOUND. */
export async function getReport(tenantId: string, userId: string, id: string): Promise<StoredReport> {
  const [r] = await db.select(columns(tenantId)).from(assistantReport)
    .innerJoin(assistantThread, eq(assistantThread.reportId, assistantReport.id))
    .where(and(eq(assistantReport.id, id), eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId)))
    .limit(1);
  if (!r) throw new ORPCError("NOT_FOUND");
  return r as StoredReport;
}

/** The user's saved reports, latest first: the home's tiles. */
export async function savedReports(tenantId: string, userId: string): Promise<StoredReport[]> {
  return await db.select(columns(tenantId)).from(assistantReport)
    .innerJoin(assistantThread, eq(assistantThread.reportId, assistantReport.id))
    .where(and(eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId), eq(assistantReport.saved, true)))
    .orderBy(desc(assistantReport.updatedAt)) as StoredReport[];
}

/** The chat's `set`: the definition and its run. The title follows the definition's until the user
 *  renames the report (a title that is neither empty nor the stored definition's is theirs). */
export async function storeRun(tenantId: string, id: string, result: ReportResult, def: ReportDef): Promise<void> {
  await db.update(assistantReport).set({
    definition: def, updatedAt: new Date(),
    title: sql`case when ${assistantReport.title} = '' or ${assistantReport.title} = coalesce(${assistantReport.definition}->>'title', '')
      then ${def.title} else ${assistantReport.title} end`,
  }).where(eq(assistantReport.id, id));
  await keep(tenantId, id, result);
}

const keep = (tenantId: string, id: string, result: ReportResult, tx?: Tx) =>
  put(tenantId, "report", [{ key: id, data: result }], { company: result.company ?? null, fetchedAt: new Date(result.readAt) }, tx);

/** A live or background run's result — only while the report still has the definition that ran: a
 *  refresh that started before the chat changed the report never overwrites the newer result. */
export async function storeResult(tenantId: string, id: string, result: ReportResult, ran: ReportDef): Promise<void> {
  await db.transaction(async (tx) => {
    const [still] = await tx.select({ id: assistantReport.id }).from(assistantReport)
      .where(and(eq(assistantReport.id, id), sql`${assistantReport.definition} = ${JSON.stringify(ran)}::jsonb`))
      .for("update");
    if (still) await keep(tenantId, id, result, tx);
  });
}

export async function setReport(tenantId: string, userId: string, id: string, set: { saved?: boolean; title?: string }): Promise<void> {
  const r = await db.update(assistantReport).set(set)
    .where(and(eq(assistantReport.id, id), eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId)))
    .returning({ id: assistantReport.id });
  if (!r.length) throw new ORPCError("NOT_FOUND");
}

export async function deleteReport(tenantId: string, id: string): Promise<void> {
  await db.delete(assistantReport).where(eq(assistantReport.id, id));
  await forget(tenantId, { kind: "report", keys: [id] });
}
