import type { AggSpec, ChartWidget, Dataset, Derive, ReportDef } from "@confire/db";
import { SOURCE, sourceLabel, type Plan, type Use } from "./plan.ts";
import type { ChartResult, KpiResult, ReportResult, TableResult, WidgetResult } from "./types.ts";

// The figures (reports spec §3.3). SAP answers partial totals — one row per (day, group) — or, where
// it refuses `$apply`, the runner reads rows and `toParts` makes each a partial of one document. Both
// combine the same way here, so the slow path cannot draw different numbers. Pure.

/** A pushed-down row: its group fields, one number per alias (plan.ts), lookups attached by name. */
export type PartRow = Record<string, unknown>;

const DAY = 864e5;
const pad = (n: number) => String(n).padStart(2, "0");
/** A date's `YYYY-MM-DD` off its text: B1 sends `2026-11-01` or `2026-11-01T00:00:00Z`, and a
 *  `new Date()` in a zone west of UTC would put either in October. */
const ymd = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const utc = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const fin = (x: number): number | null => (Number.isFinite(x) ? x : null);

export function bucketOf(value: unknown, bucket: Derive["bucket"], today: Date): { label: string; order: number } | null {
  if (typeof bucket === "object" && "ranges" in bucket) {
    const v = num(value);
    if (v === null) return null;
    const r = [...bucket.ranges].sort((a, b) => a - b);
    if (v < r[0]!) return { label: `<${r[0]}`, order: 0 };
    for (let i = 1; i < r.length; i++) if (v < r[i]!) return { label: `${r[i - 1]}–${r[i]}`, order: i };
    return { label: `≥${r.at(-1)}`, order: r.length };
  }
  const s = ymd(value);
  if (!s) return null;
  const t = utc(s);
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7));
  if (typeof bucket === "object") {
    const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - t) / DAY);
    const b = [...bucket.ageDays].sort((a, c) => a - c);
    if (days <= b[0]!) return { label: `0–${b[0]}`, order: 0 };
    for (let i = 1; i < b.length; i++) if (days <= b[i]!) return { label: `${b[i - 1]! + 1}–${b[i]}`, order: i };
    return { label: `>${b.at(-1)}`, order: b.length };
  }
  switch (bucket) {
    case "day": return { label: s, order: t / DAY };
    case "month": return { label: s.slice(0, 7), order: y * 12 + m };
    case "quarter": { const q = Math.ceil(m / 3); return { label: `${y}-Q${q}`, order: y * 4 + q }; }
    case "year": return { label: String(y), order: y };
    case "week": {
      // ISO 8601: the week holding the date's Thursday, numbered in that Thursday's year.
      const d = new Date(t);
      d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
      const wy = d.getUTCFullYear();
      const w = Math.ceil(((d.getTime() - Date.UTC(wy, 0, 1)) / DAY + 1) / 7);
      return { label: `${wy}-W${pad(w)}`, order: wy * 53 + w };
    }
  }
}

const ORDER = "#order";

/** Each derive's label under its name (and its sort order beside it). */
export function withDerived(row: PartRow, ds: Dataset, today: Date): PartRow {
  const out = { ...row };
  for (const d of ds.derive) {
    const b = bucketOf(out[d.field], d.bucket, today);
    out[d.name] = b?.label ?? null;
    out[`${d.name}${ORDER}`] = b?.order ?? null;
  }
  return out;
}

/** Raw rows as partials of one row each: what `$apply` would have answered for them. */
export const toParts = (rows: Record<string, unknown>[], agg: AggSpec): PartRow[] => rows.map((r) => {
  const p: PartRow = {};
  for (const g of agg.groupBy) p[g] = r[g] ?? null;
  for (const m of agg.measures) p[m.as] = m.agg === "count" || m.agg === "countDistinct" ? 1 : num(r[m.field ?? ""]);
  return p;
});

/** One measure over partial rows. No row with a number: null for a sum/avg/min/max, 0 for a count. */
function combine(rows: PartRow[], use: Use): number | null {
  if (use.agg === "countDistinct")
    return new Set(rows.map((r) => r[use.distinct ?? ""]).filter((v) => v !== null && v !== undefined)).size;
  const total = (alias: string) => rows.reduce((s, r) => s + (num(r[alias]) ?? 0), 0);
  if (use.agg === "count") return total(use.value);
  const vals = rows.map((r) => num(r[use.value])).filter((v): v is number => v !== null);
  if (!vals.length) return null;
  if (use.agg === "min") return vals.reduce((a, b) => Math.min(a, b));
  if (use.agg === "max") return vals.reduce((a, b) => Math.max(a, b));
  const sum = vals.reduce((a, b) => a + b, 0) - (use.minus ? total(use.minus) : 0);
  if (use.agg === "avg") {
    const n = total(use.count ?? "n");
    return n ? fin(sum / n) : null;
  }
  return fin(sum);
}

const OTHER = "Other";
const NONE = "—";
const MAX_SERIES = 8;
const labelOf = (v: unknown): string => (v === null || v === undefined || v === "" ? NONE : String(v));

type Group = { label: string; order: number | null; rows: PartRow[][] };

function chartOf(w: ChartWidget, uses: (Use | undefined)[], gather: (u: Use | undefined) => PartRow[]): ChartResult {
  const groups = new Map<string, Group>();
  uses.forEach((u, i) => {
    for (const r of gather(u)) {
      const label = labelOf(r[w.dimension]);
      let g = groups.get(label);
      if (!g) groups.set(label, (g = { label, order: num(r[`${w.dimension}${ORDER}`]), rows: uses.map(() => []) }));
      g.rows[i]!.push(r);
    }
  });

  // Columns: one per measure, or with a series one per series value of the one measure.
  type Col = { key: string; label: string; cell: (rows: PartRow[][]) => number | null; m: ChartWidget["measures"][number] };
  let cols: Col[];
  if (w.series) {
    const u = uses[0]!;
    const m = w.measures[0]!;
    const series = w.series;
    const of = (rows: PartRow[][], keep: (s: string) => boolean) => rows[0]!.filter((r) => keep(labelOf(r[series])));
    const totals = new Map<string, number>();
    for (const r of gather(u)) totals.set(labelOf(r[series]), 0);
    for (const s of totals.keys()) totals.set(s, combine(gather(u).filter((r) => labelOf(r[series]) === s), u) ?? 0);
    const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)!);
    const shown = new Set(ranked.slice(0, MAX_SERIES));
    cols = ranked.slice(0, MAX_SERIES).map((s) => ({ key: `s:${s}`, label: s, m, cell: (rows) => combine(of(rows, (x) => x === s), u) }));
    if (ranked.length > MAX_SERIES)
      cols.push({ key: `s:${OTHER}`, label: OTHER, m, cell: (rows) => combine(of(rows, (x) => !shown.has(x)), u) });
  } else {
    cols = w.measures.map((m, i) => ({ key: `m${i}`, label: m.label, m, cell: (rows) => (uses[i] ? combine(rows[i]!, uses[i]!) : null) }));
  }

  const rowOf = (label: string, rows: PartRow[][]) => {
    const out: Record<string, string | number | null> = { [w.dimension]: label };
    for (const c of cols) out[c.key] = c.cell(rows);
    return out;
  };
  const weight = (rows: PartRow[][]) => cols.reduce((s, c) => s + Math.abs(c.cell(rows) ?? 0), 0);
  const byValue = (a: Group, b: Group) => (w.series ? weight(b.rows) - weight(a.rows) : (cols[0]!.cell(b.rows) ?? -Infinity) - (cols[0]!.cell(a.rows) ?? -Infinity));
  const byDimension = (a: Group, b: Group) => (a.order !== null && b.order !== null ? a.order - b.order
    : a.label.localeCompare(b.label, undefined, { numeric: true }));
  const sort = w.sort ?? (["bar", "donut", "pie"].includes(w.chart) ? "value" : "dimension");

  let kept = [...groups.values()];
  let rest: Group[] = [];
  if (w.top && kept.length > w.top) {
    const ranked = kept.sort(byValue);
    kept = ranked.slice(0, w.top);
    rest = ranked.slice(w.top);
  }
  kept.sort(sort === "value" ? byValue : byDimension);
  const rows = kept.map((g) => rowOf(g.label, g.rows));
  // "Other" is every left-out group's rows combined again, so an average stays an average.
  if (rest.length) rows.push(rowOf(OTHER, uses.map((_, i) => rest.flatMap((g) => g.rows[i]!))));

  return {
    kind: "chart", title: w.title, ...(w.note ? { note: w.note } : {}), size: w.size, chart: w.chart, dimension: w.dimension,
    rows,
    measures: cols.map((c) => ({
      key: c.key, label: c.label, format: c.m.format,
      ...(c.m.as ? { as: c.m.as } : {}), ...(w.series ? { stackId: "s" } : c.m.stackId ? { stackId: c.m.stackId } : {}),
    })),
    ...(w.target !== undefined ? { target: w.target } : {}),
  };
}

export type TableData = Pick<TableResult, "rows" | "total" | "partial">;

export function evaluate(def: ReportDef, plan: Plan, data: Map<string, PartRow[]>, tables: Map<number, TableData>, today: Date): WidgetResult[] {
  const readOf = new Map(plan.reads.map((r) => [r.key, r]));
  const decorated = new Map<string, PartRow[]>();
  const rowsOf = (key: string): PartRow[] => {
    const cached = decorated.get(key);
    if (cached) return cached;
    const r = readOf.get(key)!;
    const ds = def.datasets[r.dataset]!;
    const label = sourceLabel(ds, r.source);
    const rows = (data.get(key) ?? []).map((p) => withDerived({ ...p, [SOURCE]: label }, ds, today));
    decorated.set(key, rows);
    return rows;
  };
  const gather = (u: Use | undefined): PartRow[] => (u ? u.reads.flatMap(rowsOf) : []);
  const total = (u: Use | undefined) => (u ? combine(gather(u), u) : null);

  return def.widgets.map((w, wi): WidgetResult => {
    const uses = plan.uses[wi] ?? [];
    if (w.kind === "table") {
      const t = tables.get(wi) ?? { rows: [], total: null, partial: false };
      return { kind: "table", title: w.title, columns: w.columns, groupBy: w.groupBy, ...t };
    }
    if (w.kind === "chart") return chartOf(w, uses, gather);
    let value = total(uses[0]);
    if (w.per) {
      const per = total(uses[1]);
      value = value !== null && per ? fin(value / per) : null;
    }
    const compare = w.compare ? total(uses[2]) : null;
    const kpi: KpiResult = {
      kind: "kpi", title: w.title, format: w.value.format, value, compare,
      deviation: value !== null && compare ? fin((value - compare) / Math.abs(compare)) : null,
      target: w.target ?? null,
    };
    return kpi;
  });
}

/** What the chat gets back from a run (reports spec §5.1): enough to describe the draft and see
 *  that it is wrong (0 rows, a fallback), never the rows. */
export function summarize(r: ReportResult) {
  return {
    widgets: r.widgets.map((w) => w.kind === "kpi" ? { kpi: w.title, value: w.value, compare: w.compare }
      : w.kind === "chart" ? { chart: w.title, categories: w.rows.length, top: w.rows.slice(0, 5) }
      : { table: w.title, total: w.total ?? w.rows.length }),
    // Without `rows`: it adds up every grouped read's rows (one per customer, per month…), which the
    // model took for the documents read ("397 rows, 481 invoices counted — I don't know why").
    datasets: Object.fromEntries(Object.entries(r.datasets).map(([id, d]) => [id, { partial: d.partial, fellBack: d.fellBack }])),
    warnings: r.warnings,
  };
}
