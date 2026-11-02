import type { CardLink } from "./data.ts";

// The chart card's rules (pure): which charts a report may switch to, the list a bar opens, and the
// figures as CSV. The report is the server's (apps/server/src/report.ts); nothing here computes a figure.

export type Chart = "column" | "bar" | "line" | "donut" | "pie" | "table" | "kpi";
export type ReportOut = {
  entity: string;
  title: string;
  chart: Chart;
  dimension: { field: string; label: string; bucket?: "day" | "month" | "quarter" | "year" } | null;
  series: { field: string; label: string } | null;
  measures: { label: string; fn: string; field?: string; money: boolean }[];
  rows: { key: string | null; label: string; values: number[] }[];
  scanned: number;
  total: number | null;
  truncated: boolean;
};

/** The charts that fit the report, the one asked for first: a time axis is a line or columns, categories
 *  columns, bars or (one measure) a donut, a total a KPI. Each can be a table. */
export function chartChoices(r: Pick<ReportOut, "chart" | "dimension" | "measures">): Chart[] {
  const fit: Chart[] = !r.dimension ? ["kpi"]
    : r.dimension.bucket ? ["line", "column"]
    : r.measures.length === 1 ? ["column", "bar", "donut"] : ["column", "bar"];
  const all = [...fit, "table" as const];
  // A pie asked for stays a pie; anything that does not fit is shown as the first that does.
  if (r.chart === "pie" && fit.includes("donut")) return ["pie", ...all.filter((c) => c !== "donut")];
  return all.includes(r.chart) ? [r.chart, ...all.filter((c) => c !== r.chart)] : all;
}

/** The SAP list behind a chart (`key` null) or behind one of its bars, in the list's URL format (`a,b`
 *  lists, `from~to` ranges): the tool's `eq`/`in` filters, its date bounds (ge/gt, le/lt) as a range,
 *  and the bar's own value — each only where the list can filter on that field (`pool`), as a field it
 *  cannot filter on would quietly open more rows than the chart counted. Null: the bar's field is not
 *  one of the list's filters, so the bar opens nothing.
 *  ponytail: an `lt` bound is taken as `le`; a day off at the range's end when a model writes one. */
export function drillLink(
  route: string, filter: { field: string; op: string; value: unknown }[], field: string | null, key: string | null, pool: ReadonlySet<string>,
): CardLink | null {
  const has = (f: string) => pool.has(f.toLowerCase());
  if (field && key && !has(field)) return null;
  const search: Record<string, string> = {};
  const ranges: Record<string, [string, string]> = {};
  for (const f of filter) {
    if (!has(f.field)) continue;
    if (f.op === "eq" || f.op === "in") search[f.field] = (Array.isArray(f.value) ? f.value : [f.value]).map(String).join(",");
    else if (typeof f.value === "string" && /^\d{4}-\d{2}-\d{2}/.test(f.value) && ["ge", "gt", "le", "lt"].includes(f.op)) {
      const r = (ranges[f.field] ??= ["", ""]);
      r[f.op.startsWith("g") ? 0 : 1] = f.value.slice(0, 10);
    }
  }
  for (const [k, [from, to]] of Object.entries(ranges)) search[k] = `${from}~${to}`;
  if (field && key) search[field] = key;
  return { to: route, search };
}

/** One quoted CSV cell: a quote doubled, and a leading = + - @ defused so a spreadsheet never runs it. */
const cell = (v: string | number) => {
  const s = String(v);
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The figures as CSV: the dimension, then a column per measure; raw numbers, so a spreadsheet sums them. */
export function chartCsv(r: ReportOut, label: (row: ReportOut["rows"][number]) => string = (x) => x.label): string {
  const head = [r.dimension?.label ?? "", ...r.measures.map((m) => m.label)];
  return [head, ...r.rows.map((x) => [label(x), ...x.values])].map((line) => line.map(cell).join(",")).join("\r\n");
}
