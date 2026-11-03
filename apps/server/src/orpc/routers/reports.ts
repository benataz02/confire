import { ORPCError } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import * as Sentry from "@sentry/bun";
import { z } from "zod";
import { ReportDefZ, type ReportDef } from "@confire/db";
import { userProcedure } from "../base.ts";
import { tenantCompany, viaB1 } from "../../b1.ts";
import { ownThread, withThread } from "../../assistant/threads.ts";
import { summarize } from "../../reports/aggregate.ts";
import { ReportInvalid, runReport } from "../../reports/run.ts";
import { deleteReport, getReport, savedReports, setReport, storeResult, storeRun, blankReport, type StoredReport } from "../../reports/store.ts";
import type { KpiResult, ReportResult } from "../../reports/types.ts";
import { t } from "../../i18n/index.ts";

// Reports (reports spec §7): the page's procedures, and `set` — the chat's `report_set` tool, which
// only a chat run can call (its `assistantThreadId` is the call's context, never a request's), so a
// definition is only ever written by the assistant. Every figure comes from runReport.

/** A run, its refusal a BAD_REQUEST naming every problem; SAP's errors as every SAP call maps them. */
async function run(ctx: { tenantId: string; role: string }, def: ReportDef): Promise<ReportResult> {
  return viaB1(() => runReport(ctx, def).catch((e: unknown) => {
    if (e instanceof ReportInvalid) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }));
}

/** A tile refreshes once its result is older than this; opening a report always runs it live. */
const STALE_MS = 60 * 60_000;
const refreshing = new Set<string>();

/** Re-run stale saved reports off the request path (masterdata-sync's `ensureFresh` pattern): the
 *  home never waits on SAP, and the next visit has fresh figures. As the caller — the owner — with
 *  the role the request just proved. ponytail: one process's Set; two server processes may both run one. */
function refreshStale(ctx: { tenantId: string; role: string }, reports: StoredReport[]): void {
  const stale = reports.filter((r) => r.definition && !refreshing.has(r.id) && (!r.lastRunAt || Date.now() - r.lastRunAt.getTime() > STALE_MS));
  if (!stale.length) return;
  for (const r of stale) refreshing.add(r.id);
  void (async () => {
    for (const r of stale) {
      try {
        await storeResult(r.id, await runReport(ctx, r.definition!), r.definition!);
      } catch (e) {
        if (!(e instanceof ReportInvalid)) Sentry.captureException(e);
      } finally {
        refreshing.delete(r.id);
      }
    }
  })();
}

const Id = z.object({ id: z.uuid() });

export const reportsRouter = {
  set: userProcedure
    .meta(openapi({
      summary: "Build or change this report",
      description: "Build or change the report of this chat: send the whole definition each time (the report guide says how). Confire checks it, reads SAP and Confire, and computes every figure; the page beside the chat shows the report. The answer is a summary — each KPI's value, each chart's first categories, each table's row count, partial reads and warnings — never the rows: describe the report from it. A refusal lists every problem with the closest real names: fix them all and call again.",
    }))
    .input(z.object({ definition: ReportDefZ }))
    .handler(async ({ input, context }) => {
      if (!context.assistantThreadId) throw new ORPCError("FORBIDDEN", { message: t("REPORT_CHAT_ONLY") });
      const thread = await ownThread(context.tenantId, context.userId, context.assistantThreadId);
      if (!thread.reportId) throw new ORPCError("FORBIDDEN", { message: t("REPORT_CHAT_ONLY") });
      const result = await run(context, input.definition);
      await storeRun(thread.reportId, result, input.definition);
      return summarize(result);
    }),

  create: userProcedure.handler(({ context }) => blankReport(context.tenantId, context.userId)),

  get: userProcedure.input(Id).handler(async ({ input, context }) => {
    const r = await getReport(context.tenantId, context.userId, input.id);
    return { id: r.id, title: r.title, saved: r.saved, definition: r.definition, lastResult: r.lastResult, lastRunAt: r.lastRunAt, threadId: r.threadId };
  }),

  /** Live: the page's open and its Refresh. */
  run: userProcedure.input(Id).handler(async ({ input, context }): Promise<ReportResult> => {
    const r = await getReport(context.tenantId, context.userId, input.id);
    if (!r.definition) throw new ORPCError("BAD_REQUEST", { message: t("REPORT_NOT_DRAFTED") });
    const result = await run(context, r.definition);
    await storeResult(r.id, result, r.definition);
    return result;
  }),

  save: userProcedure.input(Id.extend({ saved: z.boolean() })).handler(async ({ input, context }) => {
    await setReport(context.tenantId, context.userId, input.id, { saved: input.saved });
  }),

  rename: userProcedure.input(Id.extend({ title: z.string().trim().min(1).max(120) })).handler(async ({ input, context }) => {
    await setReport(context.tenantId, context.userId, input.id, { title: input.title });
  }),

  /** Under the chat's lease: never while it answers (THREAD_BUSY). The chat goes with the report. */
  delete: userProcedure.input(Id).handler(async ({ input, context }) => {
    const r = await getReport(context.tenantId, context.userId, input.id);
    await withThread(r.threadId, () => deleteReport(r.id));
  }),

  /** The home's Reports group: each saved report's headline (its first KPI) from its last run — no
   *  SAP call here — hidden when that run read another company than the agent serves now. */
  tiles: userProcedure.handler(async ({ context }) => {
    const reports = await savedReports(context.tenantId, context.userId);
    refreshStale(context, reports);
    const company = await tenantCompany(context.tenantId);
    return reports.map((r) => {
      const kpi = r.lastResult?.widgets.find((w): w is KpiResult => w.kind === "kpi");
      const fresh = !!r.lastResult && r.lastResult.company === company;
      return {
        id: r.id, title: r.title, subtitle: r.definition?.subtitle ?? null,
        // No good/bad colour: whether a figure going down is bad depends on the measure (overdue
        // invoices falling is good news), which the definition does not say.
        value: fresh ? kpi?.value ?? null : null, format: kpi?.format ?? "number", currency: r.lastResult?.currency ?? null,
      };
    });
  }),
};
