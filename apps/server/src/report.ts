import { z } from "zod";
import { FilterCondZ } from "@confire/db";

// The assistant's reports (pure, tested): rows in, one chart's dataset out. The model names what to
// group and measure; the server reads the rows and counts — a chart's figures are the server's, never
// the model's, as every card's are. reports.sap feeds it SAP rows, reports.configs Confire's own.
//
// ponytail: the server aggregates at most MAX_SCAN rows it read itself. OData `$apply` (groupby +
// aggregate) would let SAP count instead, once verified on a live Service Layer and the agent's
// allowlist.

/** Rows a report reads at most. Past it the answer says `truncated`, and the card says so. */
export const MAX_SCAN = 5000;
/** Categories a chart shows at most before the rest become "Other" (a time axis is never cut). */
export const TOP_DEFAULT = 12;
const TOP_MAX = 50;
/** Series in one chart at most: past it the legend is noise. */
const SERIES_MAX = 6;
/** Time buckets a gap-filled axis may span: past it the axis keeps only the buckets that have rows. */
const FILL_MAX = 120;

export const BucketZ = z.enum(["day", "month", "quarter", "year"]);
export type Bucket = z.infer<typeof BucketZ>;

const AxisZ = z.object({
  field: z.string().min(1).describe("The field to group by"),
  bucket: BucketZ.optional().describe("For a date field: group by day, month, quarter or year"),
});

export const MeasureZ = z.object({
  fn: z.enum(["count", "sum", "avg", "min", "max"]).describe("count = rows (or rows where `field` is set); the others over the numeric `field`"),
  field: z.string().optional().describe("The numeric field; required except for count"),
  label: z.string().max(60).optional().describe("The measure's name on the chart, in the user's language"),
  money: z.boolean().optional().describe("The values are amounts in the company's currency"),
});
export type Measure = z.infer<typeof MeasureZ>;

export const ChartZ = z.enum(["column", "bar", "line", "donut", "pie", "table", "kpi"]);
export type Chart = z.infer<typeof ChartZ>;

/** What the model asks for, beside the source (the entity set, or Confire's configurations). */
export const ReportSpecZ = z.object({
  title: z.string().min(1).max(120).describe("The chart's title, in the user's language"),
  chart: ChartZ.describe("column (categories or time), bar (long category names, rankings), line (a trend over time), donut/pie (shares of one total, few categories), table, kpi (one number per measure, no groupBy)"),
  groupBy: AxisZ.optional().describe("The categories or time axis; absent = one total (a kpi)"),
  series: AxisZ.optional().describe("A second split, drawn as stacked series (one measure only)"),
  measures: z.array(MeasureZ).min(1).max(3),
  filter: z.array(FilterCondZ).default([]).describe("Which rows count, AND-combined (eq, ne, gt, ge, lt, le, contains, startswith, in). Dates as YYYY-MM-DD"),
  sort: z.enum(["value", "label"]).optional().describe("Categories by the first measure, largest first (default), or by label. A time axis is always in time order"),
  top: z.number().int().min(1).max(TOP_MAX).optional().describe(`Categories shown before the rest become "Other"; default ${TOP_DEFAULT}`),
});
export type ReportSpec = z.infer<typeof ReportSpecZ>;

/** One category or time bucket. `key` is what a drill-down filters on: the value itself, a date range
 *  `from~to` for a bucket, null for "Other" and for rows without a value. */
export type ReportRow = { key: string | null; label: string; values: number[] };
export type Report = {
  title: string;
  chart: Chart;
  dimension: { field: string; label: string; bucket?: Bucket } | null;
  series: { field: string; label: string } | null;
  /** with a series, one per series value (each the one measure, split) */
  measures: { label: string; fn: Measure["fn"]; field?: string; money: boolean }[];
  rows: ReportRow[];
  /** rows read */
  scanned: number;
  /** rows the filter matches, when the source says */
  total: number | null;
  truncated: boolean;
};

/** The fields a report reads, deduplicated: the axes and the measured ones. */
export function readFields(s: Pick<ReportSpec, "groupBy" | "series" | "measures">): string[] {
  return [...new Set([s.groupBy?.field, s.series?.field, ...s.measures.map((m) => m.field)].filter((f): f is string => !!f))];
}

export type FieldInfo = { label?: string; kind: string };

/** The spec's own mistakes, each named, before any row is read: the source's field names, numeric
 *  fields to sum, dates to bucket, one measure with a series. */
export function specProblems(s: ReportSpec, fields: Map<string, FieldInfo>): string[] {
  const out: string[] = [];
  const known = (f: string) => fields.has(f) || !!out.push(`${f}: no such field`);
  for (const a of [s.groupBy, s.series]) {
    if (!a || !known(a.field)) continue;
    if (a.bucket && fields.get(a.field)!.kind !== "date") out.push(`${a.field}: only a date field takes a bucket`);
  }
  for (const m of s.measures) {
    if (m.fn !== "count" && !m.field) out.push(`${m.fn}: needs a numeric field`);
    else if (m.field && known(m.field) && m.fn !== "count" && fields.get(m.field)!.kind !== "number") out.push(`${m.field}: ${m.fn} needs a numeric field`);
  }
  if (s.series && s.measures.length > 1) out.push("series: one measure only");
  if (s.series && !s.groupBy) out.push("series: needs groupBy");
  return out;
}

// --- time buckets -----------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** A date value's day, read off its text: SAP sends `2026-10-24` or `2026-10-24T00:00:00Z`, Postgres a
 *  Date. Null for anything else. */
export function dayOf(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

/** The bucket a day falls in: its first day, sortable as text. */
function bucketStart(d: Date, b: Bucket): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (b === "day") return d;
  if (b === "month") return new Date(Date.UTC(y, m, 1));
  if (b === "quarter") return new Date(Date.UTC(y, m - (m % 3), 1));
  return new Date(Date.UTC(y, 0, 1));
}

function nextBucket(d: Date, b: Bucket): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (b === "day") return new Date(Date.UTC(y, m, d.getUTCDate() + 1));
  if (b === "month") return new Date(Date.UTC(y, m + 1, 1));
  if (b === "quarter") return new Date(Date.UTC(y, m + 3, 1));
  return new Date(Date.UTC(y + 1, 0, 1));
}

/** A bucket's drill-down key, `from~to` inclusive (the lists' range filter), and its axis label. */
function bucketKey(start: Date, b: Bucket): { key: string; label: string } {
  const last = new Date(nextBucket(start, b).getTime() - 86_400_000);
  const y = start.getUTCFullYear();
  const label = b === "day" ? iso(start)
    : b === "month" ? `${y}-${pad(start.getUTCMonth() + 1)}`
    : b === "quarter" ? `${y} Q${Math.floor(start.getUTCMonth() / 3) + 1}`
    : String(y);
  return { key: `${iso(start)}~${iso(last)}`, label };
}

// --- aggregation ------------------------------------------------------------------------------

type Acc = { n: number; sum: number; min: number; max: number; rows: number };
const acc = (): Acc => ({ n: 0, sum: 0, min: Infinity, max: -Infinity, rows: 0 });
const merge = (a: Acc, b: Acc): Acc => ({ n: a.n + b.n, sum: a.sum + b.sum, min: Math.min(a.min, b.min), max: Math.max(a.max, b.max), rows: a.rows + b.rows });

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

function add(a: Acc, m: Measure, row: Record<string, unknown>): void {
  a.rows++;
  if (m.fn === "count") {
    if (!m.field || (row[m.field] !== null && row[m.field] !== undefined && row[m.field] !== "")) a.n++;
    return;
  }
  const v = num(row[m.field!]);
  if (v === null) return;
  a.n++;
  a.sum += v;
  a.min = Math.min(a.min, v);
  a.max = Math.max(a.max, v);
}

const round = (n: number) => Math.round(n * 100) / 100;

function final(a: Acc, m: Measure): number {
  if (m.fn === "count") return a.n;
  if (!a.n) return 0;
  return round(m.fn === "sum" ? a.sum : m.fn === "avg" ? a.sum / a.n : m.fn === "min" ? a.min : a.max);
}

const OTHER = "\u0000other";
const EMPTY = "\u0000empty";

/** A value as a category's key and label: a bucket for a date axis, the text otherwise. */
function categoryOf(v: unknown, bucket: Bucket | undefined): { key: string; label: string; sort: string } {
  if (bucket) {
    const d = dayOf(v);
    if (!d) return { key: EMPTY, label: "", sort: "" };
    const start = bucketStart(d, bucket);
    return { ...bucketKey(start, bucket), sort: iso(start) };
  }
  if (v === null || v === undefined || v === "") return { key: EMPTY, label: "", sort: "" };
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return { key: s, label: s, sort: s };
}

export type Labels = { other: string; empty: string; count: string; fn: Record<Measure["fn"], string> };
const EN: Labels = { other: "Other", empty: "(none)", count: "Count", fn: { count: "Count", sum: "Sum", avg: "Average", min: "Min", max: "Max" } };

/**
 * The chart's dataset. Categories: by the first measure, largest first (or by label), the first `top`
 * kept and the rest summed into "Other" — a time axis keeps every bucket, in order, its gaps filled
 * with zeros while it spans at most FILL_MAX buckets. A series keeps its SERIES_MAX largest values and
 * sums the rest the same way.
 */
export function aggregate(
  rows: Record<string, unknown>[],
  s: ReportSpec,
  fields: Map<string, FieldInfo>,
  meta: { total: number | null; truncated: boolean },
  labels: Labels = EN,
): Report {
  const g = s.groupBy;
  const sr = s.series;
  const ms = s.measures;
  // cells[category][series][measure]
  const cells = new Map<string, { label: string; sort: string; by: Map<string, Acc[]> }>();
  const seriesTotals = new Map<string, Acc>();
  const seriesNames = new Map<string, string>();
  for (const r of rows) {
    const c = g ? categoryOf(r[g.field], g.bucket) : { key: "", label: s.title, sort: "" };
    const sv = sr ? categoryOf(r[sr.field], sr.bucket) : { key: "", label: "", sort: "" };
    let cell = cells.get(c.key);
    if (!cell) cells.set(c.key, (cell = { label: c.label, sort: c.sort, by: new Map() }));
    let accs = cell.by.get(sv.key);
    if (!accs) cell.by.set(sv.key, (accs = ms.map(acc)));
    ms.forEach((m, i) => add(accs![i]!, m, r));
    if (sr) {
      const t = seriesTotals.get(sv.key) ?? acc();
      add(t, ms[0]!, r);
      seriesTotals.set(sv.key, t);
      seriesNames.set(sv.key, sv.label);
    }
  }

  // The series kept: the largest by the measure, the rest one "Other".
  const seriesKeys = sr
    ? [...seriesTotals].sort((a, b) => final(b[1], ms[0]!) - final(a[1], ms[0]!) || a[0].localeCompare(b[0])).map(([k]) => k)
    : [""];
  const keptSeries = seriesKeys.length > SERIES_MAX ? seriesKeys.slice(0, SERIES_MAX - 1) : seriesKeys;
  const seriesOther = seriesKeys.length > keptSeries.length;
  const seriesLabel = (k: string) => (k === EMPTY ? labels.empty : seriesNames.get(k) ?? k);

  /** One category's values, in the measures' (or series') order. */
  const valuesOf = (by: Map<string, Acc[]>): number[] => {
    if (!sr) return ms.map((m, i) => final([...by.values()].map((a) => a[i]!).reduce(merge, acc()), m));
    const m = ms[0]!;
    const of = (k: string) => by.get(k)?.[0] ?? acc();
    const kept = keptSeries.map((k) => final(of(k), m));
    if (!seriesOther) return kept;
    const rest = seriesKeys.slice(keptSeries.length).map(of).reduce(merge, acc());
    return [...kept, final(rest, m)];
  };

  type Cat = Sorted & { by: Map<string, Acc[]> };
  const cats: Cat[] = [...cells].map(([key, c]) => ({
    key: key === EMPTY ? null : key,
    label: key === EMPTY ? labels.empty : c.label,
    values: valuesOf(c.by),
    // Rows without a value sort last on every axis.
    sort: key === EMPTY ? "￿" : c.sort,
    by: c.by,
  }));
  cats.sort((a, b) => (g?.bucket || s.sort === "label" ? 0 : (b.values[0] ?? 0) - (a.values[0] ?? 0)) || a.sort.localeCompare(b.sort));

  let out: ReportRow[] = cats;
  if (g?.bucket) {
    out = fillGaps(cats, g.bucket, valuesOf(new Map()));
  } else if (g && cats.length > (s.top ?? TOP_DEFAULT)) {
    const top = s.top ?? TOP_DEFAULT;
    const merged = new Map<string, Acc[]>();
    for (const [k, a] of cats.slice(top).flatMap((c) => [...c.by]))
      merged.set(k, merged.has(k) ? merged.get(k)!.map((x, i) => merge(x, a[i]!)) : a);
    out = [...cats.slice(0, top), { key: OTHER, label: labels.other, values: valuesOf(merged) }];
  }

  const label = (f: string) => fields.get(f)?.label ?? f;
  return {
    title: s.title,
    chart: s.chart,
    dimension: g ? { field: g.field, label: label(g.field), ...(g.bucket ? { bucket: g.bucket } : {}) } : null,
    series: sr ? { field: sr.field, label: label(sr.field) } : null,
    measures: sr
      ? [...keptSeries.map(seriesLabel), ...(seriesOther ? [labels.other] : [])].map((l) => ({
        label: l, fn: ms[0]!.fn, ...(ms[0]!.field ? { field: ms[0]!.field } : {}), money: !!ms[0]!.money,
      }))
      : ms.map((m) => ({
        label: m.label ?? (m.fn === "count" ? labels.count : `${labels.fn[m.fn]} ${label(m.field!)}`),
        fn: m.fn, ...(m.field ? { field: m.field } : {}), money: !!m.money,
      })),
    rows: out.map((r) => ({ key: r.key === OTHER ? null : r.key, label: r.label, values: r.values })),
    scanned: rows.length,
    total: meta.total,
    truncated: meta.truncated,
  };
}

/** A time axis without holes: every bucket from the first to the last, an empty one at zero. Rows
 *  without a date stay last. Past FILL_MAX buckets the axis keeps only those with rows. */
type Sorted = ReportRow & { sort: string };
function fillGaps(rows: Sorted[], b: Bucket, zero: number[]): ReportRow[] {
  const dated = rows.filter((r) => r.key !== null);
  const undated = rows.filter((r) => r.key === null);
  if (dated.length < 2) return rows;
  const first = dayOf(dated[0]!.sort)!;
  const last = dayOf(dated.at(-1)!.sort)!;
  const all: Date[] = [];
  for (let d = first; d <= last && all.length <= FILL_MAX; d = nextBucket(d, b)) all.push(d);
  if (all.length > FILL_MAX) return rows;
  const have = new Map<string, ReportRow>(dated.map((r) => [r.sort, r]));
  return [...all.map((d) => have.get(iso(d)) ?? { ...bucketKey(d, b), values: zero.map(() => 0) }), ...undated];
}
