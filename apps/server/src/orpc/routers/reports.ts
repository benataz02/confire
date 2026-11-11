import { ORPCError } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import { z } from "zod";
import { FilterValueZ, ReportDefZ, type FilterValue, type ReportDef } from "@confire/db";
import { userProcedure } from "../base.ts";
import { viaB1 } from "../../b1.ts";
import { ownThread, withThread } from "../../assistant/threads.ts";
import { summarize } from "../../reports/aggregate.ts";
import { ReportInvalid, runReport } from "../../reports/run.ts";
import { adoptReport, deleteReport, getReport, reportRows, savedReports, setReport, storeResult, storeRun } from "../../reports/store.ts";
import { ListPageZ } from "../../list-sql.ts";
import type { KpiResult, ReportResult } from "../../reports/types.ts";
import { t } from "../../i18n/index.ts";

// Reports (reports spec §7): the page's procedures, and `set` — the chat's `report_set` tool, which
// only a chat run can call (its `assistantThreadId` is the call's context, never a request's), so a
// definition is only ever written by the assistant. A report is made by its chat's first `set`. Every figure comes from runReport.

/** A run, its refusal a BAD_REQUEST naming every problem; SAP's errors as every SAP call maps them. */
async function run(ctx: { tenantId: string; role: string }, def: ReportDef, values?: Record<string, FilterValue>): Promise<ReportResult> {
  return viaB1(() => runReport(ctx, def, values).catch((e: unknown) => {
    if (e instanceof ReportInvalid) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }));
}

const Id = z.object({ id: z.uuid() });

export const reportsRouter = {
  set: userProcedure
    .meta(openapi({
      summary: "Build or change this report",
      description: "Build or change the report of this chat: send the whole definition each time (the report skill says how). The first call makes this chat the new report's chat. Confire checks it, reads SAP and Confire, and computes every figure; the page beside the chat shows the report. The answer is a summary — each KPI's value, each chart's first categories, each table's row count, partial reads and warnings — never the rows: describe the report from it. A refusal lists every problem with the closest real names: fix them all and call again.",
    }))
    .input(z.object({ definition: ReportDefZ }))
    .handler(async ({ input, context }) => {
      if (!context.assistantThreadId) throw new ORPCError("FORBIDDEN", { message: t("REPORT_CHAT_ONLY") });
      const thread = await ownThread(context.tenantId, context.userId, context.assistantThreadId);
      if (thread.projectId) throw new ORPCError("FORBIDDEN", { message: t("REPORT_NOT_IN_CONFIG") });
      // Run first: a refused definition leaves a general chat general (no empty report behind it).
      const result = await run(context, input.definition);
      const reportId = thread.reportId ?? await adoptReport(context.tenantId, context.userId, thread.id);
      await storeRun(context.tenantId, reportId, result, input.definition);
      return summarize(result);
    }),

  get: userProcedure.input(Id).handler(async ({ input, context }) => {
    const r = await getReport(context.tenantId, context.userId, input.id);
    return { id: r.id, title: r.title, saved: r.saved, definition: r.definition, lastResult: r.lastResult, lastRunAt: r.lastRunAt, threadId: r.threadId };
  }),

  /** Live: the page's open, its Refresh and its filter bar's Go (`filters`, by field — any header
   *  field of the report's data; none = the defaults). Only a run on the defaults is stored: the tile shows the report as defined. */
  run: userProcedure.input(Id.extend({ filters: z.record(z.string(), FilterValueZ).optional() })).handler(async ({ input, context }): Promise<ReportResult> => {
    const r = await getReport(context.tenantId, context.userId, input.id);
    if (!r.definition) throw new ORPCError("BAD_REQUEST", { message: t("REPORT_NOT_DRAFTED") });
    const result = await run(context, r.definition, input.filters);
    if (!input.filters) await storeResult(context.tenantId, r.id, result, r.definition);
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
    await withThread(r.threadId, () => deleteReport(context.tenantId, r.id));
  }),

  /** The Reports list (side nav, AI): the user's own, paged and filtered like every SQL list. */
  rows: userProcedure.input(ListPageZ).handler(({ input, context }) => reportRows(context.tenantId, context.userId, input)),

  /** The home's Reports group: each saved report's headline (its first KPI) from its last run — no
   *  SAP call here, nor behind it: a report reads SAP only when its page opens or Refreshes, which
   *  stores the run the tile shows — none when that run read another company than the agent serves now
   *  (sap_cache's company rule). */
  tiles: userProcedure.handler(async ({ context }) => {
    const reports = await savedReports(context.tenantId, context.userId);
    return reports.map((r) => {
      const kpi = r.lastResult?.widgets.find((w): w is KpiResult => w.kind === "kpi");
      return {
        id: r.id, title: r.title, subtitle: r.definition?.subtitle ?? null,
        // No good/bad colour: whether a figure going down is bad depends on the measure (overdue
        // invoices falling is good news), which the definition does not say.
        value: kpi?.value ?? null, format: kpi?.format ?? "number", currency: r.lastResult?.currency ?? null,
      };
    });
  }),
};
