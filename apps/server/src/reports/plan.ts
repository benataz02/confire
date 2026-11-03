import type { Agg, AggSpec, Dataset, FilterCond, Measure, ReportDef, Widget } from "@confire/db";
import { resolveFilter } from "./dates.ts";

// What to ask SAP for (reports spec §3.3): each widget's measures become pushed-down reads, one per
// (dataset, source, filter, grouping), their totals merged. A time dimension groups by the date
// field itself — one row per day — and is bucketed afterwards (aggregate.ts), so a monthly chart is
// one call however many months it shows. Pure.

/** One `$apply` call: `source` indexes the dataset's `from`. */
export type Read = { key: string; dataset: string; source: number; filter: FilterCond[]; agg: AggSpec };
/** Where one measure's numbers are: its reads (one per source it covers) and the aliases holding its
 *  total, `minus`'s sum, the count an average divides by, and for countDistinct the field counted. */
export type Use = { agg: Agg; reads: string[]; value: string; minus?: string; count?: string; distinct?: string };
export type Plan = { reads: Read[]; uses: (Use | undefined)[][] };

export const SOURCE = "_source";

/** The dataset field a widget's name stands on: a derive's field, a lookup's key, followed back;
 *  null for `_source`, which is no field. A cycle stops at the name. */
export function rootField(ds: Dataset, name: string, seen = new Set<string>()): string | null {
  if (name === SOURCE) return null;
  if (seen.has(name)) return name;
  seen.add(name);
  const d = ds.derive.find((x) => x.name === name);
  if (d) return rootField(ds, d.field, seen);
  const l = ds.lookups.find((x) => x.name === name);
  if (l) return rootField(ds, l.field, seen);
  return name;
}

/** A widget's measures in a fixed order: a KPI's value, per, compare; a chart's in order. */
export const measuresOf = (w: Widget): (Measure | undefined)[] =>
  w.kind === "kpi" ? [w.value, w.per, w.compare] : w.kind === "chart" ? w.measures : [];

const groupNamesOf = (w: Widget): string[] =>
  w.kind === "chart" ? [w.dimension, ...(w.series ? [w.series] : [])] : [];

export const sourceLabel = (ds: Dataset, i: number): string => ds.from[i]!.label ?? ds.from[i]!.entity;

/** Whether a source passes a measure's `_source` conditions (eq, ne, in). */
function sourcePasses(label: string, conds: FilterCond[]): boolean {
  return conds.every((c) => {
    const vs = Array.isArray(c.value) ? c.value.map(String) : [String(c.value)];
    return c.op === "ne" ? !vs.includes(label) : vs.includes(label);
  });
}

export function planReads(def: ReportDef, today: Date): Plan {
  const reads = new Map<string, Read>();
  // An alias names its total (`sum_DocTotal`), so it is the same in every read: a measure covering two
  // sources finds its number under one name in both, whatever else each read was asked.
  const alias = (r: Read, agg: "sum" | "min" | "max", field: string): string => {
    const as = `${agg}_${field.replace(/\W/g, "_")}`;
    if (!r.agg.measures.some((m) => m.as === as)) r.agg.measures.push({ agg, field, as });
    return as;
  };
  const count = (r: Read): string => {
    if (!r.agg.measures.some((m) => m.agg === "count")) r.agg.measures.push({ agg: "count", as: "n" });
    return "n";
  };

  const uses = def.widgets.map((w) => measuresOf(w).map((m): Use | undefined => {
    if (!m) return undefined;
    const ds = def.datasets[m.dataset];
    if (!ds) return undefined;
    const groupBy = [...new Set([
      ...groupNamesOf(w).map((n) => rootField(ds, n)).filter((x): x is string => !!x),
      ...(m.agg === "countDistinct" && m.field ? [m.field] : []),
    ])];
    const bySource = m.filter.filter((c) => c.field === SOURCE);
    const own = m.filter.filter((c) => c.field !== SOURCE);
    let use: Use | undefined;
    const keys: string[] = [];
    ds.from.forEach((src, i) => {
      if (!sourcePasses(sourceLabel(ds, i), bySource)) return;
      const filter = resolveFilter([...ds.filter, ...src.filter, ...own], today);
      const key = JSON.stringify([m.dataset, i, filter, groupBy]);
      let r = reads.get(key);
      if (!r) reads.set(key, (r = { key, dataset: m.dataset, source: i, filter, agg: { groupBy, measures: [] } }));
      keys.push(key);
      const value = m.agg === "count" || m.agg === "countDistinct" ? count(r)
        : alias(r, m.agg === "avg" ? "sum" : m.agg, m.field ?? "");
      const minus = m.minus && (m.agg === "sum" || m.agg === "avg") ? alias(r, "sum", m.minus) : undefined;
      const n = m.agg === "avg" ? count(r) : undefined;
      use ??= { agg: m.agg, reads: keys, value, ...(minus ? { minus } : {}), ...(n ? { count: n } : {}),
        ...(m.agg === "countDistinct" && m.field ? { distinct: m.field } : {}) };
    });
    // A `_source` filter no source passes: the measure reads nothing.
    return use ?? { agg: m.agg, reads: [], value: "n" };
  }));
  return { reads: [...reads.values()], uses };
}
