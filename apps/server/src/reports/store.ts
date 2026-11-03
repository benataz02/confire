import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db, assistantReport, assistantThread, type ReportDef } from "@confire/db";
import type { ReportResult } from "./types.ts";

// A user's reports and their chats (reports spec §4): personal — every read and write is on
// (tenant, user). A report has one chat, made with it; deleting the report deletes the chat.

/** The user's report nothing was drafted on yet, its chat still empty and not answering — opening
 *  New report over and over leaves no trail of empty reports. Else a new one, with its chat. */
export async function blankReport(tenantId: string, userId: string): Promise<{ id: string; threadId: string }> {
  const [found] = await db.select({ id: assistantReport.id, threadId: assistantThread.id })
    .from(assistantReport)
    .innerJoin(assistantThread, eq(assistantThread.reportId, assistantReport.id))
    .where(and(
      eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId), isNull(assistantReport.definition),
      sql`jsonb_array_length(${assistantThread.messages}) = 0`,
      or(isNull(assistantThread.busyUntil), lt(assistantThread.busyUntil, sql`now()`)),
    ))
    .orderBy(desc(assistantReport.updatedAt)).limit(1);
  if (found) {
    await db.update(assistantReport).set({ updatedAt: new Date() }).where(eq(assistantReport.id, found.id));
    return found;
  }
  return db.transaction(async (tx) => {
    const [r] = await tx.insert(assistantReport).values({ tenantId, userId }).returning({ id: assistantReport.id });
    const [t] = await tx.insert(assistantThread).values({ tenantId, userId, reportId: r!.id }).returning({ id: assistantThread.id });
    return { id: r!.id, threadId: t!.id };
  });
}

export type StoredReport = {
  id: string; title: string; saved: boolean; definition: ReportDef | null;
  lastResult: ReportResult | null; lastRunAt: Date | null; updatedAt: Date; threadId: string;
};

const columns = {
  id: assistantReport.id, title: assistantReport.title, saved: assistantReport.saved, definition: assistantReport.definition,
  lastResult: assistantReport.lastResult, lastRunAt: assistantReport.lastRunAt, updatedAt: assistantReport.updatedAt,
  threadId: assistantThread.id,
};

/** One of the user's reports, or NOT_FOUND. */
export async function getReport(tenantId: string, userId: string, id: string): Promise<StoredReport> {
  const [r] = await db.select(columns).from(assistantReport)
    .innerJoin(assistantThread, eq(assistantThread.reportId, assistantReport.id))
    .where(and(eq(assistantReport.id, id), eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId)))
    .limit(1);
  if (!r) throw new ORPCError("NOT_FOUND");
  return r as StoredReport;
}

/** The user's saved reports, latest first: the home's tiles. */
export async function savedReports(tenantId: string, userId: string): Promise<StoredReport[]> {
  return await db.select(columns).from(assistantReport)
    .innerJoin(assistantThread, eq(assistantThread.reportId, assistantReport.id))
    .where(and(eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId), eq(assistantReport.saved, true)))
    .orderBy(desc(assistantReport.updatedAt)) as StoredReport[];
}

/** A run's result, and with `def` the definition it ran (the chat's `set`). */
export async function storeRun(id: string, result: ReportResult, def?: ReportDef): Promise<void> {
  await db.update(assistantReport).set({
    lastResult: result, lastRunAt: new Date(result.readAt),
    ...(def ? { definition: def, title: def.title, updatedAt: new Date() } : {}),
  }).where(eq(assistantReport.id, id));
}

export async function setReport(tenantId: string, userId: string, id: string, set: { saved?: boolean; title?: string }): Promise<void> {
  const r = await db.update(assistantReport).set(set)
    .where(and(eq(assistantReport.id, id), eq(assistantReport.tenantId, tenantId), eq(assistantReport.userId, userId)))
    .returning({ id: assistantReport.id });
  if (!r.length) throw new ORPCError("NOT_FOUND");
}

export async function deleteReport(id: string): Promise<void> {
  await db.delete(assistantReport).where(eq(assistantReport.id, id));
}
