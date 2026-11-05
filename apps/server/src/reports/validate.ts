import type { B1EntitySchema } from "@confire/b1";
import type { Dataset, Measure, ReportDef } from "@confire/db";
import { scalarFields } from "../entity-list.ts";
import { readableBy } from "../entity-profiles.ts";
import { closestNames } from "../entity-write.ts";
import { CONFIRE_FIELDS } from "./confire.ts";
import { SOURCE } from "./plan.ts";

// A report definition checked whole before anything is read (reports spec §3.2): every problem, one
// line each, so the model fixes them all in one turn. Names are SAP's own, held to the cached schema —
// the strict-name rule b1.read has — and reads keep b1.read's scope (ADMIN_ONLY_READS). Pure.

const suggest = (name: string, among: Iterable<string>) => {
  const c = closestNames(name, [...among]);
  return c.length ? ` (did you mean ${c.join(", ")}?)` : "";
};

const intersect = (a: Set<string> | null, b: Set<string>): Set<string> => (a ? new Set([...a].filter((n) => b.has(n))) : b);

const isDateBucket = (ds: Dataset, name: string) => {
  const d = ds.derive.find((x) => x.name === name);
  return !!d && (typeof d.bucket === "string" || "ageDays" in d.bucket);
};

export function checkReport(def: ReportDef, schemas: Map<string, B1EntitySchema | null>, role: string): string[] {
  const out: string[] = [];
  const canRead = readableBy(role);
  /** Each dataset's fields: those every one of its sources has. */
  const raw = new Map<string, Set<string>>();

  const sapSchema = (entity: string): B1EntitySchema | null => {
    const s = schemas.get(entity);
    if (!s) { out.push(`${entity} is not an SAP entity set — find it with b1_find`); return null; }
    if (!canRead(entity)) { out.push(`${entity} is for admins only`); return null; }
    return s;
  };

  for (const [id, ds] of Object.entries(def.datasets)) {
    let shared: Set<string> | null = null;
    for (const s of ds.from) {
      let names: string[] | null = null;
      if (s.source === "confire") {
        const f = CONFIRE_FIELDS[s.entity as keyof typeof CONFIRE_FIELDS];
        if (!f) out.push(`${s.entity} is not a Confire source: Confire's is Configurations`);
        else names = Object.keys(f);
        if (ds.lines) out.push(`Dataset ${id}: lines are an SAP document's only`);
      } else {
        const sc = sapSchema(s.entity);
        if (sc) {
          names = scalarFields(sc).map((f) => f.name);
          if (ds.lines) {
            const lines = sc.fields.find((f) => f.name === "DocumentLines" && f.kind === "collection");
            if (!lines) out.push(`${s.entity} has no DocumentLines: lines are a document's`);
            else names.push(...(lines.fields ?? []).filter((f) => f.kind !== "collection").map((f) => `Lines.${f.name}`));
          }
        }
      }
      if (!names) continue;
      const has = new Set(names);
      const lookupNames = new Set(ds.lookups.map((l) => l.name));
      const need = (name: string) => {
        if (has.has(name)) return;
        const hint = name.startsWith("Lines.") && !ds.lines ? " — set `lines: true` on the dataset to read document lines" : suggest(name, has);
        out.push(`${s.entity} has no field ${name}${hint}`);
      };
      for (const c of [...ds.filter, ...s.filter]) need(c.field);
      ds.lookups.forEach((l, i) => { if (!ds.lookups.slice(0, i).some((x) => x.name === l.field)) need(l.field); });
      for (const d of ds.derive) if (!lookupNames.has(d.field)) need(d.field);
      shared = intersect(shared, has);
    }
    raw.set(id, shared ?? new Set());

    for (const l of ds.lookups) {
      const sc = sapSchema(l.entity);
      if (!sc) continue;
      const fields = new Set(scalarFields(sc).map((f) => f.name));
      for (const n of [l.key, l.value]) if (!fields.has(n)) out.push(`${l.entity} has no field ${n}${suggest(n, fields)}`);
    }
  }

  const known = (id: string) => {
    const ds = def.datasets[id]!;
    return new Set([...(raw.get(id) ?? []), ...ds.lookups.map((l) => l.name), ...ds.derive.map((d) => d.name), SOURCE]);
  };
  const name = (where: string, id: string, n: string) => {
    const k = known(id);
    if (!k.has(n)) out.push(`${where}: ${n} is not a field, lookup or derive of dataset ${id}${suggest(n, k)}`);
  };
  const measure = (where: string, m: Measure | undefined) => {
    if (!m) return;
    if (!def.datasets[m.dataset]) { out.push(`${where}: dataset ${m.dataset} is not defined`); return; }
    const r = raw.get(m.dataset) ?? new Set<string>();
    const field = (n: string) => { if (!r.has(n)) out.push(`${where}: ${n} is not a field of dataset ${m.dataset}${suggest(n, r)}`); };
    if (m.agg !== "count" && !m.field) out.push(`${where}: ${m.agg} needs a field`);
    if (m.field) field(m.field);
    if (m.minus) {
      if (m.agg !== "sum" && m.agg !== "avg") out.push(`${where}: minus works with sum and avg only`);
      field(m.minus);
    }
    // A measure's filter is pushed down with it: fields of the dataset, or `_source`.
    for (const c of m.filter) if (c.field !== SOURCE) field(c.field);
  };

  // A bar filter applies to the datasets whose every source has its field (run.ts' filterBar).
  def.filters.forEach((f, i) => {
    if (def.filters.findIndex((g) => g.field === f.field) !== i) out.push(`Filter ${f.label}: ${f.field} is already a filter`);
    // ponytail: header fields only — a Lines.* filter would need filterBar to read the lines' schema too.
    const all = new Set([...raw.values()].flatMap((r) => [...r]).filter((n) => !n.startsWith("Lines.")));
    if (!all.has(f.field)) out.push(`Filter ${f.label}: ${f.field} is not a field of any dataset (header fields only; lookups and derives are not filters)${suggest(f.field, all)}`);
     // One place says a field's condition: cleared in the bar, it filters nothing.
    for (const [id, ds] of Object.entries(def.datasets)) {
      if ([...ds.filter, ...ds.from.flatMap((s) => s.filter)].some((c) => c.field === f.field)) {
        out.push(`Dataset ${id}: ${f.field} is the filter bar's (${f.label}) — put its condition in that filter's default, not the dataset's or source's filter`);
      }
    }
  });

  def.widgets.forEach((w, i) => {
    const where = `Widget ${i + 1} (${w.title})`;
    if (w.kind === "kpi") {
      measure(where, w.value); measure(where, w.per); measure(where, w.compare);
      return;
    }
    if (w.kind === "table") {
      if (!def.datasets[w.dataset]) { out.push(`${where}: dataset ${w.dataset} is not defined`); return; }
      for (const n of [...w.columns, ...w.groupBy, ...w.sortBy.map((s) => s.field)]) name(where, w.dataset, n);
      return;
    }
    for (const m of w.measures) {
      measure(where, m);
      const ds = def.datasets[m.dataset];
      if (!ds) continue;
      name(where, m.dataset, w.dimension);
      if (w.series) name(where, m.dataset, w.series);
      if (isDateBucket(ds, w.dimension) && w.series && isDateBucket(ds, w.series)) out.push(`${where}: at most one date bucket between the dimension and the series`);
    }
    if (w.series && w.measures.length !== 1) out.push(`${where}: a series chart has exactly one measure`);
    if (["donut", "pie", "radial"].includes(w.chart) && (w.measures.length !== 1 || w.series)) out.push(`${where}: a ${w.chart} chart has exactly one measure and no series`);
    if (w.chart === "scatter" && w.measures.length !== 2) out.push(`${where}: a scatter chart has two measures`);
    if (w.chart === "bullet" && w.target === undefined && w.measures.length < 2) out.push(`${where}: a bullet chart needs a target or a second measure to compare with`);
  });
  return [...new Set(out)];
}
