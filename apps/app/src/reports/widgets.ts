import type { client } from "../orpc.ts";

// A report's results as UI5 chart props (reports spec §6.2). Pure — the page picks the component by
// name and spreads these. Every figure is the server's (ReportResult); this only formats and maps.

export type Report = Awaited<ReturnType<typeof client.reports.get>>;
export type Result = NonNullable<Report["lastResult"]>;
export type WidgetResult = Result["widgets"][number];
export type ChartResult = Extract<WidgetResult, { kind: "chart" }>;
export type KpiResult = Extract<WidgetResult, { kind: "kpi" }>;
export type TableResult = Extract<WidgetResult, { kind: "table" }>;
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
