import type { Entries, ModelDef, Outputs } from "@confire/config-engine";
import type { GridState } from "@confire/ui/list-report/Grid.tsx";
import type { Row } from "@confire/ui/types.ts";

// Pure view logic for the configuration wizard. Client-side mirrors of the server's
// ConfigCandidate/ConfigSelection jsonb shapes (web doesn't depend on @confire/db; structural match).
export type Candidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type Sel = { candidateIdx: number; batchQty: number };

// What the price analysis needs. Absent `unitCost` means no margin row.
export type PricedCandidate = {
  assignment: Entries;
  perBatch: { batchQty: number; unitPrice: number; total: number; unitCost?: number }[];
};

export const toPriced = (c: Candidate): PricedCandidate => ({
  assignment: c.assignment,
  perBatch: c.perBatch.map((b) => ({
    batchQty: b.batchQty, unitPrice: b.outputs.unitPrice, total: b.outputs.batchTotal, unitCost: b.outputs.unitCost,
  })),
});

export const fmt = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const statusUi = {
  draft: { state: "None", text: "Draft" },
  quoted: { state: "Positive", text: "Quoted" },
} as const;

// Params the calculation left open (assigned per candidate, not fixed in the project's entries),
// in model parameter order so labels are stable across candidates.
export function openKeys(model: ModelDef, entries: Entries, candidates: { assignment: Entries }[]): string[] {
  const assigned = new Set<string>();
  for (const c of candidates) for (const k of Object.keys(c.assignment)) if (!(k in entries)) assigned.add(k);
  return model.parameters.map((p) => p.key).filter((k) => assigned.has(k));
}

export const candidateLabel = (keys: string[], assignment: Entries): string =>
  keys.length ? keys.map((k) => String(assignment[k] ?? "—")).join(" · ") : "Configuration";

// Lowest unit price per batch column -> candidate index (first wins on ties).
export function bestByBatch(candidates: PricedCandidate[]): Record<number, number> {
  const best: Record<number, { idx: number; price: number }> = {};
  candidates.forEach((c, idx) => {
    for (const b of c.perBatch) {
      const cur = best[b.batchQty];
      if (!cur || b.unitPrice < cur.price) best[b.batchQty] = { idx, price: b.unitPrice };
    }
  });
  return Object.fromEntries(Object.entries(best).map(([q, v]) => [q, v.idx]));
}

/** A price line's grid row id: the pair a Sel names. */
export const lineKey = (s: Sel): string => `${s.candidateIdx}:${s.batchQty}`;

/** The selection after a grid change. The grid only knows the lines on screen, so a pick a filter
 *  hides is kept and the rest follow the grid. Pick order holds: kept picks first, new ones after. */
export function mergeSelection(selection: Sel[], shown: Set<string>, picked: Sel[]): Sel[] {
  const on = new Set(picked.map(lineKey));
  const had = new Set(selection.map(lineKey));
  return [
    ...selection.filter((s) => !shown.has(lineKey(s)) || on.has(lineKey(s))),
    ...picked.filter((p) => !had.has(lineKey(p))),
  ];
}

const compare = (a: unknown, b: unknown): number =>
  typeof a === "number" || typeof b === "number"
    ? Number(a ?? -Infinity) - Number(b ?? -Infinity)
    : String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });

/** Grid's sort is a server's job; every candidate is already here, so this is that server.
 *  Numbers numerically (an empty one lowest), text with its digits compared as numbers. */
export const sortRows = (rows: Row[], sortBy: GridState["sortBy"]): Row[] =>
  [...rows].sort((x, y) => {
    for (const s of sortBy) {
      const d = compare(x[s.field], y[s.field]);
      if (d) return s.direction === "desc" ? -d : d;
    }
    return 0;
  });

// Rows the price chart draws: every configuration with a picked cell, in pick order — or, before
// anything is picked, the cheapest one at the first quantity, so the chart is never empty.
export function chartRows(candidates: PricedCandidate[], selection: Sel[]): number[] {
  if (selection.length) return [...new Set(selection.map((s) => s.candidateIdx))];
  const first = candidates[0]?.perBatch[0]?.batchQty;
  return first === undefined ? [] : [bestByBatch(candidates)[first]!];
}

/** Share of the price that is margin; null where there is no price to take a share of. */
export const margin = (unitPrice: number, unitCost: number): number | null =>
  unitPrice === 0 ? null : (unitPrice - unitCost) / unitPrice;

/** BOM items the engine costed at 0 because the price list had no line for them, each once. Read
 *  off the stored candidates, so the warning is exactly as current as the prices it is about. */
export const unpricedItems = (candidates: Candidate[]): string[] => [
  ...new Set(candidates.flatMap((c) =>
    c.perBatch.flatMap((b) => b.outputs.bom.filter((l) => l.unpriced).map((l) => l.itemCode)))),
];
