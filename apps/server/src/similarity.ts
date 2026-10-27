import { historyKey, type Entries, type ModelDef, type Val } from "@confire/config-engine";

// Weighted per-param similarity over cached historic rows. Pure — no DB, no agent — so it has
// a network-free test. Score = Σ(weight × match) / Σ(weight of params the user filled).
// Each probe is one set of values to match: the parameters plus one items-grid row's cells. A past
// row scores against every probe and keeps its best, so a line matches one grid row whole — never
// the item of one row and the width of another.

export type HistoryDef = NonNullable<ModelDef["history"]>;
export type ParamMatch = {
  param: string; column: string; match: "exact" | "closeness" | "contains";
  weight: number; score: number; value: Val;
};
/** `probe`: the index of the probe that scored best — the items-grid row the past row matched. */
export type Scored = { row: Record<string, Val>; score: number; matches: ParamMatch[]; probe: number };

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const filled = (v: Entries[string] | undefined): v is NonNullable<Entries[string]> =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

export function scoreRows(history: HistoryDef, probes: Entries[], rows: Record<string, Val>[], top = 10): Scored[] {
  const all = probes
    .map((entries, i) => ({ i, entries, active: history.mappings.filter((m) => filled(entries[historyKey(m)])) }))
    .filter((p) => p.active.length);
  // An empty grid row leaves the parameters alone, a smaller denominator: it would outrank every
  // row whose line differs. Once any grid row has a cell, only those count.
  const withCells = all.filter((p) => p.active.some((m) => m.table));
  const live = withCells.length ? withCells : all;
  if (!live.length || !rows.length) return [];

  // closeness auto-normalization: observed numeric range of the column in the historic data
  const ranges = new Map<string, { min: number; max: number }>();
  for (const m of history.mappings) {
    if (m.match !== "closeness") continue;
    let min = Infinity, max = -Infinity;
    for (const r of rows) {
      if (r[m.column] == null) continue; // Skip null/undefined values
      const n = Number(r[m.column]);
      if (Number.isFinite(n)) { min = Math.min(min, n); max = Math.max(max, n); }
    }
    if (min <= max) ranges.set(m.column, { min, max });
  }

  const one = (m: HistoryDef["mappings"][number], entry: Val, hist: Val): number => {
    if (m.match === "exact") return norm(entry) === norm(hist) ? 1 : 0;
    if (m.match === "contains") return norm(entry) && norm(hist).includes(norm(entry)) ? 1 : 0;
    // closeness: null/undefined historic values score as no-match, not as 0
    if (hist == null) return 0;
    const a = Number(entry), b = Number(hist), rg = ranges.get(m.column);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !rg) return 0;
    if (rg.max === rg.min) return a === b ? 1 : 0;
    return Math.max(0, Math.min(1, 1 - Math.abs(a - b) / (rg.max - rg.min)));
  };

  const scoreOne = (row: Record<string, Val>, { i, entries, active }: (typeof live)[number]): Scored => {
    const matches = active.map((m) => {
      const e = entries[historyKey(m)]!;
      // multicombo entries: best match across the selected values
      const vals: Val[] = Array.isArray(e) ? e : [e];
      const score = Math.max(...vals.map((v) => one(m, v, row[m.column] ?? null)));
      return { param: historyKey(m), column: m.column, match: m.match, weight: m.weight, score, value: row[m.column] ?? null };
    });
    const totalWeight = active.reduce((s, m) => s + m.weight, 0);
    return { row, score: matches.reduce((s, x) => s + x.weight * x.score, 0) / totalWeight, matches, probe: i };
  };
  // ponytail: history rows × grid rows; fine for a cached table and a quotation's lines, a prefilter
  // on the exact mappings if a history table grows past a few thousand rows.
  const scored = rows.map((row) =>
    live.reduce<Scored | null>((best, p) => {
      const s = scoreOne(row, p);
      return best && best.score >= s.score ? best : s;
    }, null)!);
  // A row the panel would label 0% matched nothing filled in, so it is not similar.
  // The label is Math.round(score * 100); a closeness under half a percent is the same.
  return scored
    .filter((s) => Math.round(s.score * 100) > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
