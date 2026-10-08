import type { Entries, ModelDef, Outputs } from "@confire/config-engine";

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

export const isSelected = (sel: Sel[], candidateIdx: number, batchQty: number): boolean =>
  sel.some((s) => s.candidateIdx === candidateIdx && s.batchQty === batchQty);

export const toggleSelection = (sel: Sel[], candidateIdx: number, batchQty: number): Sel[] =>
  isSelected(sel, candidateIdx, batchQty)
    ? sel.filter((s) => !(s.candidateIdx === candidateIdx && s.batchQty === batchQty))
    : [...sel, { candidateIdx, batchQty }];

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
