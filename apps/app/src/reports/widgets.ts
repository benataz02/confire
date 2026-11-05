import type { PageMessage } from "@confire/ui/PageMessages.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { cleanValues } from "@confire/ui/views.ts";
import type { Constraints, EntityConstraints } from "@confire/ui/metadata.ts";
import type { CflDialogConfig, FilterField, FilterValue } from "@confire/ui/types.ts";
import type { client } from "../orpc.ts";

// A report's results as UI5 chart props (reports spec §6.2). Pure — the page picks the component by
// name and spreads these. Every figure is the server's (ReportResult); this only formats and maps.

export type Report = Awaited<ReturnType<typeof client.reports.get>>;
export type Result = NonNullable<Report["lastResult"]>;
export type WidgetResult = Result["widgets"][number];
export type ChartResult = Extract<WidgetResult, { kind: "chart" }>;
export type KpiResult = Extract<WidgetResult, { kind: "kpi" }>;
export type TableResult = Extract<WidgetResult, { kind: "table" }>;
export type BarFilter = NonNullable<Result["filters"]>[number];
export type ChartKind = ChartResult["chart"];
export type Format = ChartResult["measures"][number]["format"];

const COMPONENT = {
  column: "ColumnChart", bar: "BarChart", line: "LineChart", composed: "ComposedChart", columnTrend: "ColumnChartWithTrend",
  donut: "DonutChart", pie: "PieChart", radial: "RadialChart", bullet: "BulletChart", scatter: "ScatterChart", radar: "RadarChart",
} as const satisfies Record<ChartKind, string>;
export type ChartComponent = (typeof COMPONENT)[ChartKind];

export const chartComponent = (k: ChartKind): ChartComponent => COMPONENT[k];

const TARGET = "_target";

/** The props a cartesian chart takes: the rows, the one dimension, each measure with its formatter
 *  and, where the chart wants one, its `type` (composed: bar/line/area; with trend: the first a bar;
 *  bullet: the first primary, the rest comparisons; a lone bullet's target a comparison line). */
export function chartProps(r: ChartResult, fmt: (v: number, f: Format) => string) {
  const typeOf = (m: ChartResult["measures"][number], i: number): string | undefined =>
    r.chart === "composed" ? m.as ?? "bar"
      : r.chart === "columnTrend" ? (i === 0 && m.as !== "line" ? "bar" : "line")
      : r.chart === "bullet" ? (i === 0 ? "primary" : "comparison")
      : undefined;
  const target = r.chart === "bullet" && r.target !== undefined && r.measures.length === 1;
  const measures = r.measures.map((m, i) => {
    const type = typeOf(m, i);
    return {
      accessor: m.key, label: m.label, formatter: (v: number) => fmt(v, m.format),
      ...(type ? { type } : {}), ...(m.stackId ? { stackId: m.stackId } : {}),
    };
  });
  return {
    dataset: target ? r.rows.map((x) => ({ ...x, [TARGET]: r.target! })) : r.rows,
    dimensions: [{ accessor: r.dimension }],
    measures: target
      ? [...measures, { accessor: TARGET, label: "Target", formatter: (v: number) => fmt(v, r.measures[0]!.format), type: "comparison" }]
      : measures,
  };
}

/** A grid's sort, done in the browser over rows that are all loaded (the Grid only asks for it). */
export function sortRows<T extends Record<string, unknown>>(rows: T[], by: { field: string; direction: "asc" | "desc" }[]): T[] {
  if (!by.length) return rows;
  return [...rows].sort((a, b) => {
    for (const s of by) {
      const x = a[s.field], y = b[s.field];
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""), undefined, { numeric: true });
      if (c) return s.direction === "desc" ? -c : c;
    }
    return 0;
  });
}

/** The table's rows behind one clicked category. */
export const filterRows = <T extends Record<string, unknown>>(rows: T[], dimension: string, value: unknown): T[] =>
  rows.filter((r) => String(r[dimension] ?? "—") === String(value));

/** A figure as a KPI or an axis shows it: compact, money with its currency, a share as a percent;
 *  null (no data) as a dash. A currency Intl does not know (B1 codes are free text) goes after it. */
export function formatValue(v: number | null | undefined, f: Format, currency: string | null, locale: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (f === "percent") return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(v);
  const compact = { notation: "compact", maximumFractionDigits: 1 } as const;
  if (f === "money" && currency) {
    try {
      return new Intl.NumberFormat(locale, { ...compact, style: "currency", currency }).format(v);
    } catch {
      return `${new Intl.NumberFormat(locale, compact).format(v)} ${currency}`;
    }
  }
  return new Intl.NumberFormat(locale, compact).format(v);
}

/** The page's messages (reports spec §3.3: never a silent part of the data): a failed run, each
 *  dataset read partly or totalled by Confire, each table cut at its 2,000 rows. */
export function reportMessages(result: Result | null, failed: string | null, group: string, t: (k: string, ...a: string[]) => string): PageMessage[] {
  const out: PageMessage[] = [];
  if (failed) out.push({ id: "failed", type: "Negative", text: t("REPORT_FAILED"), detail: failed, group });
  for (const [id, st] of Object.entries(result?.datasets ?? {})) {
    if (st.partial) out.push({ id: `p:${id}`, type: "Critical", text: t("REPORT_PARTIAL", id), detail: t("REPORT_PARTIAL_DETAIL", String(st.partial.read), st.partial.total === null ? "…" : String(st.partial.total)), group });
    if (st.fellBack) out.push({ id: `f:${id}`, type: "Information", text: t("REPORT_FELL_BACK", id), detail: t("REPORT_FELL_BACK_DETAIL"), group });
  }
  (result?.widgets ?? []).forEach((w, i) => {
    if (w.kind === "table" && w.partial)
      out.push({ id: `t:${i}`, type: "Critical", text: t("REPORT_TABLE_PARTIAL", w.title), detail: t("REPORT_TABLE_PARTIAL_DETAIL", String(w.rows.length), w.total === null ? "…" : String(w.total)), group });
  });
  return out;
}

/** The value helps a bar filter gets, by the entity set its field points to (B1's metadata). Any
 *  other coded field is typed: ponytail — add a set here once a report wants its value help. */
const VALUE_HELP: Record<string, () => CflDialogConfig> = {
  BusinessPartners: () => cfl.businessPartners(), Items: () => cfl.items(), SalesPersons: () => cfl.salesPersons(),
  Warehouses: () => cfl.warehouses(), PriceLists: () => cfl.priceLists(), Currencies: () => cfl.currencies(),
};

/** The report's fields as a list's metadata, so its grid, bar and axes read like a List Report's
 *  (labels in the reader's language, enum names): every SAP set it reads merged, the first to name a
 *  field winning (a dataset's sources share their fields), and a document's lines as the dataset
 *  names them, `Lines.ItemCode`. */
export function reportConstraints(list: (EntityConstraints | undefined)[]): Constraints {
  const out: Constraints = {};
  for (const c of list) {
    for (const [name, f] of Object.entries(c?.fields ?? {})) {
      if (name === "DocumentLines") for (const [ln, lf] of Object.entries(f.Fields ?? {})) out[`Lines.${ln}`] ??= lf;
      else out[name] ??= f;
    }
  }
  return out;
}

/** The report's filter bar as a list's filters (FilterHeader's pool: the definition's shown, with
 *  their defaults for Clear; every other field in Adapt Filters), and the values its run applied.
 *  A declared filter keeps the definition's label; the rest, and every enum's options, are the
 *  metadata's — an option's value is B1's member name, what the Service Layer filters on. */
export function filterBar(filters: BarFilter[], meta: Constraints = {}): { pool: FilterField[]; values: Record<string, FilterValue> } {
  const pool = filters.map((f): FilterField => {
    const help = f.lookup ? VALUE_HELP[f.lookup.entitySet] : undefined;
    const m = meta[f.field];
    const options = m?.Options ?? f.options;
    return {
      key: f.field, label: f.declared ? f.label : m?.Label ?? f.label, type: f.type, visible: f.declared,
      ...(f.default !== undefined ? { defaultValue: f.default } : {}),
      ...(options ? { options } : {}),
      ...(help ? { cfl: { dialogConfig: help() } } : {}),
    };
  });
  return { pool, values: cleanValues(Object.fromEntries(filters.map((f) => [f.field, f.value]))) };
}
