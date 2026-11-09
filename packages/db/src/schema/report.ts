import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AggZ, FilterCondZ, FilterValueZ } from "./variant.ts";

// Reports the assistant builds (docs/superpowers/specs/2026-11-03-assistant-reports-design.md). A
// report is a definition — data, filters, grouping, measures, widgets — written by the chat's
// `report_set` and run by the server (apps/server/src/reports/), which computes every figure. Stored
// whole, like a model; every open runs it again, so "last 12 months" stays the last 12 months.

const Name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const Filters = z.array(FilterCondZ).default([]).describe("ANDed conditions with SAP's field names; dates may be @today, @today-12M, @startOfMonth, @startOfYear-1Y (D, W, M, Y)");

export const FormatZ = z.enum(["money", "number", "percent"]);
export type Format = z.infer<typeof FormatZ>;
export const ChartKindZ = z.enum(["column", "bar", "line", "composed", "columnTrend", "donut", "pie", "radial", "bullet", "scatter", "radar"]);
export type ChartKind = z.infer<typeof ChartKindZ>;

export const MeasureZ = z.object({
  dataset: z.string().describe("The dataset's id"),
  agg: AggZ,
  field: z.string().optional().describe("The field to total; none for count"),
  minus: z.string().optional().describe("sum/avg only: a field subtracted, e.g. DocTotal minus VatSum = net"),
  filter: Filters,
  label: z.string(),
  format: FormatZ.default("number"),
});
export type Measure = z.infer<typeof MeasureZ>;

export const LookupZ = z.object({
  name: Name.describe("The looked-up value's name in the dataset, e.g. country"),
  field: z.string().describe("The dataset field (or an earlier lookup's name) holding the key"),
  entity: z.string().describe("The related SAP entity set, e.g. BusinessPartners"),
  key: z.string().describe("Its key field, e.g. CardCode"),
  value: z.string().describe("Its field to take, e.g. Country"),
});
export type Lookup = z.infer<typeof LookupZ>;

export const BucketZ = z.union([
  z.enum(["day", "week", "month", "quarter", "year"]),
  z.object({ ranges: z.array(z.number()).min(1).max(10).describe("Value bounds, e.g. [1000, 10000]") }),
  z.object({ ageDays: z.array(z.number().int().positive()).min(1).max(10).describe("Days since the date, e.g. [30, 60, 90]") }),
]);
export const DeriveZ = z.object({ name: Name, field: z.string(), bucket: BucketZ });
export type Derive = z.infer<typeof DeriveZ>;

export const SourceZ = z.object({
  source: z.enum(["b1", "confire"]),
  entity: z.string().describe("An SAP entity set (Quotations, Orders, Invoices…) or Confire's Configurations"),
  label: z.string().optional().describe("The source's name in `_source`, e.g. Quotation"),
  filter: Filters,
});

export const DatasetZ = z.object({
  from: z.array(SourceZ).min(1).max(4).describe("Sources with the same fields, read as one; each row's `_source` is its label"),
  lines: z.boolean().default(false).describe("Document lines: line fields are Lines.ItemCode, Lines.LineTotal…"),
  filter: Filters,
  lookups: z.array(LookupZ).max(8).default([]),
  derive: z.array(DeriveZ).max(8).default([]),
});
export type Dataset = z.infer<typeof DatasetZ>;

const ChartMeasureZ = MeasureZ.extend({ as: z.enum(["bar", "line", "area"]).optional(), stackId: z.string().optional() });

export const KpiWidgetZ = z.object({
  kind: z.literal("kpi"),
  title: z.string(),
  value: MeasureZ,
  per: MeasureZ.optional().describe("A ratio: value ÷ per"),
  compare: MeasureZ.optional().describe("What the value is compared with: the trend and deviation"),
  target: z.number().optional(),
});
export const ChartWidgetZ = z.object({
  kind: z.literal("chart"),
  title: z.string(),
  note: z.string().optional(),
  size: z.enum(["wide", "normal"]).default("normal"),
  chart: ChartKindZ,
  dimension: z.string().describe("A field, lookup or derive of every measure's dataset, or _source"),
  measures: z.array(ChartMeasureZ).min(1).max(6),
  series: z.string().optional().describe("Pivot: one stacked measure per value of this field; needs exactly one measure"),
  sort: z.enum(["dimension", "value"]).optional(),
  top: z.number().int().min(1).max(50).optional().describe("Keep the N largest, the rest summed as Other"),
  target: z.number().optional(),
});
export const TableWidgetZ = z.object({
  kind: z.literal("table"),
  title: z.string(),
  dataset: z.string(),
  columns: z.array(z.string()).min(1).max(12),
  groupBy: z.array(z.string()).max(3).default([]),
  sortBy: z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) })).max(3).default([]),
});
export const WidgetZ = z.discriminatedUnion("kind", [KpiWidgetZ, ChartWidgetZ, TableWidgetZ]);
export type Widget = z.infer<typeof WidgetZ>;
export type KpiWidget = z.infer<typeof KpiWidgetZ>;
export type ChartWidget = z.infer<typeof ChartWidgetZ>;
export type TableWidget = z.infer<typeof TableWidgetZ>;

/** The report's filter bar: a field the user filters the whole report by, as on a list. */
export const ReportFilterZ = z.object({
  field: z.string().describe("A field of the datasets (SAP's own name, e.g. DocDate, CardCode, SalesPersonCode, or a Configurations field), applied to every dataset that has it"),
  label: z.string().describe("The filter's label, in the user's language"),
  default: FilterValueZ.optional().describe("The value on open: a date field takes a range { from: \"@startOfYear\", to: \"@today\" }, a code or enum field a list of values, a text field a text"),
});
export type ReportFilter = z.infer<typeof ReportFilterZ>;

export const ReportDefZ = z.object({
  title: z.string().min(1).max(120),
  subtitle: z.string().max(200).optional(),
  assumptions: z.array(z.object({ label: z.string(), value: z.string() })).max(8).default([])
    .describe("How you read the request, one chip each, in the user's language"),
  filters: z.array(ReportFilterZ).max(8).default([])
    .describe("The filter bar over the whole report. A value set there replaces the datasets' and sources' own conditions on that field; a measure's own filter on it (a compare period) stays"),
  datasets: z.record(Name, DatasetZ),
  widgets: z.array(WidgetZ).min(1).max(20),
});
export type ReportDef = z.infer<typeof ReportDefZ>;

/** A user's report. `definition` null: a New report page nothing was drafted on yet. `saved`: on the
 *  home page. Its last run, the tile's figure, is its `report` entry in sap_cache. */
export const assistantReport = pgTable("assistant_report", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title").notNull().default(""),
  definition: jsonb("definition").$type<ReportDef>(),
  saved: boolean("saved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("assistant_report_user_idx").on(t.tenantId, t.userId, t.updatedAt)]);
