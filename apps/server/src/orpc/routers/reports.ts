import { ORPCError } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import { and, eq, sql } from "drizzle-orm";
import { db, configModel, configProject, portalCompany, PROJECT_STATUSES } from "@confire/db";
import { userProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema } from "../../entity-meta.ts";
import { scalarFields } from "../../entity-list.ts";
import { assertReadable } from "../../entity-profiles.ts";
import { bad, readRows } from "../../entity-read.ts";
import { EntityZ, unknownNames } from "../../entity-write.ts";
import { compileQuery, type SqlFields } from "../../list-sql.ts";
import { internalVisible } from "../../project-lifecycle.ts";
import { aggregate, MAX_SCAN, readFields, ReportSpecZ, specProblems, type FieldInfo, type Labels, type ReportSpec } from "../../report.ts";
import { t } from "../../i18n/index.ts";

// The assistant's charts (report.ts): one chart's dataset over SAP's records or Confire's own
// configurations, counted here from rows the server reads, so the card draws the server's figures.
// The same procedures are tools in the chat and over MCP (tools.ts), where a user's own Claude draws
// them its way.

const PAGE = 1000;

/** The engine's own words, in the request's language. */
const labels = (): Labels => ({
  other: t("REPORT_OTHER"), empty: t("REPORT_EMPTY"), count: t("REPORT_COUNT"),
  fn: { count: t("REPORT_COUNT"), sum: t("REPORT_SUM"), avg: t("REPORT_AVG"), min: t("REPORT_MIN"), max: t("REPORT_MAX") },
});

const HOW = "Name the chart, what to group by (a date field with a `bucket` for a trend), what to measure (count, or sum/avg/min/max of a numeric field) and which rows count (`filter`). Answers the chart's `rows` (each category's `values`, in `measures`' order). In Confire's chat the answer is drawn as a chart card the user can switch to a table, drill into and download — so don't repeat its figures there: say in a sentence or two what stands out.";

/** A spec naming a field the source lacks or misusing one: one refusal naming every problem. */
function check(entity: string, s: ReportSpec, fields: Map<string, FieldInfo>): void {
  const names = [...fields.keys()];
  const unknown = [...readFields(s), ...s.filter.map((f) => f.field)].filter((f) => !fields.has(f));
  if (unknown.length) throw unknownNames(entity, [...new Set(unknown)].map((name) => ({ name, among: names })));
  const problems = specProblems(s, fields);
  if (problems.length) throw new ORPCError("BAD_REQUEST", { message: problems.join("; ") });
}

/** Confire's configurations as a report reads them: the workspace's own and its clients' requests
 *  (never a client's draft). `origin` tells them apart; `customer` is the BP of either. */
const configFields = (userId: string): SqlFields & Record<string, { label: string }> => ({
  status: { col: configProject.status, kind: "enum", label: "Status" },
  origin: { col: sql<string>`case when ${configProject.portalCardCode} is null then 'internal' else 'request' end`, kind: "enum", label: "Origin" },
  modelName: { col: configModel.name, kind: "string", label: "Model" },
  customer: { col: sql<string>`coalesce(${configProject.customer}->>'cardName', ${portalCompany.cardName})`, kind: "string", label: "Customer" },
  mine: { col: sql<string>`case when ${configProject.createdBy} = ${userId} then 'yes' else 'no' end`, kind: "enum", label: "Mine" },
  createdAt: { col: configProject.createdAt, kind: "date", label: "Created" },
  updatedAt: { col: configProject.updatedAt, kind: "date", label: "Updated" },
  quotedAt: { col: configProject.quotedAt, kind: "date", label: "Quoted on" },
  quotedValue: { col: sql<number>`${configProject.quotedValue}::float8`, kind: "number", label: "Quoted value" },
  quotedCost: { col: sql<number>`${configProject.quotedCost}::float8`, kind: "number", label: "Quoted cost" },
  quotedMargin: { col: sql<number>`(${configProject.quotedValue} - ${configProject.quotedCost})::float8`, kind: "number", label: "Quoted margin" },
});
export const CONFIG_REPORT_FIELDS = Object.keys(configFields(""));

export const reportsRouter = {
  sap: userProcedure
    .meta(openapi({
      summary: "Chart SAP records",
      description: `A chart of SAP Business One records, counted by Confire from SAP itself: \`entity\` is SAP's entity set name (Invoices, Orders, Quotations, DeliveryNotes, BusinessPartners, Items… as in b1_read), fields by SAP's names (DocDate, DocTotal, CardName, DocumentStatus, SalesPersonCode…). ${HOW} Reads at most ${MAX_SCAN} records; \`truncated\` says when more match — narrow the filter (a date range) then.`,
    }))
    .input(ReportSpecZ.extend({ entity: EntityZ.describe("SAP's entity set name") }))
    .handler(async ({ input, context }) => {
      const { entity, ...spec } = input;
      assertReadable(entity, context.role);
      const b1 = (await tenantConnector(context.tenantId)).b1;
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, entity)).catch(bad);
      const fields = new Map<string, FieldInfo>(scalarFields(schema).map((f) => [f.name, { label: f.label ?? f.name, kind: f.kind }]));
      check(schema.name, spec, fields);

      const fence = { tenantId: context.tenantId, key: "b1-report" };
      // A plain count is SAP's own $count: one row read, however many match.
      if (!spec.groupBy && spec.measures.every((m) => m.fn === "count" && !m.field)) {
        const page = await readRows(b1, schema, entity, { query: { select: schema.keys, filter: spec.filter, orderby: [] }, pageSize: 1, count: true }, fence);
        const n = page.total;
        // A Service Layer that sends no count gets the scan below.
        if (typeof n === "number") {
          const r = aggregate([], spec, fields, { total: n, truncated: false }, labels());
          return { entity: schema.name, ...r, rows: [{ key: "", label: spec.title, values: spec.measures.map(() => n) }], scanned: page.rows.length };
        }
      }

      // Narrow rows, page by page, until SAP says there are no more or the scan cap is reached. The
      // keys stand in for a select that names no field.
      const named = readFields(spec);
      const query = { select: named.length ? named : schema.keys, filter: spec.filter, orderby: [] };
      const rows: Record<string, unknown>[] = [];
      let total: number | null = null;
      let cursor: string | undefined;
      do {
        const page = await readRows(b1, schema, entity, { query, pageSize: PAGE, cursor, count: !cursor }, fence);
        if (!cursor) total = page.total ?? null;
        rows.push(...page.rows);
        cursor = page.nextCursor;
      } while (cursor && rows.length < MAX_SCAN);
      return { entity: schema.name, ...aggregate(rows.slice(0, MAX_SCAN), spec, fields, { total, truncated: !!cursor || rows.length > MAX_SCAN }, labels()) };
    }),

  configs: userProcedure
    .meta(openapi({
      summary: "Chart configurations",
      description: `A chart of Confire's own configurations: the workspace's and its clients' requests. Fields: status (${PROJECT_STATUSES.join(", ")}), origin (internal, request), modelName, customer, mine (yes when the caller started it), createdAt, updatedAt, quotedAt (dates), quotedValue, quotedCost, quotedMargin (amounts, set once quoted). ${HOW}`,
    }))
    .input(ReportSpecZ)
    .handler(async ({ input, context }) => {
      const all = configFields(context.userId);
      const fields = new Map<string, FieldInfo>(Object.entries(all).map(([k, f]) => [k, { label: f.label, kind: f.kind }]));
      check("configurations", input, fields);
      const { where } = compileQuery(all, { select: [], filter: input.filter, orderby: [] });
      // A plain count reads no field: one constant column stands in, as a select needs one.
      const named = readFields(input);
      const select = Object.fromEntries((named.length ? named : ["_"]).map((k) => [k, k === "_" ? sql`1`.as(k) : sql`${all[k]!.col}`.as(k)]));
      const rows = await db.select(select).from(configProject)
        .innerJoin(configModel, eq(configModel.id, configProject.modelId))
        .leftJoin(portalCompany, and(eq(portalCompany.tenantId, configProject.tenantId), eq(portalCompany.cardCode, configProject.portalCardCode)))
        .where(and(eq(configProject.tenantId, context.tenantId), internalVisible, where))
        .limit(MAX_SCAN + 1);
      return { entity: "configurations", ...aggregate(rows.slice(0, MAX_SCAN), input, fields, { total: null, truncated: rows.length > MAX_SCAN }, labels()) };
    }),
};
