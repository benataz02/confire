import type { Entries, ItemsTable, ModelDef, ResolvedLookups, TableRows, Val } from "./model";
import { computeOutputs, type Outputs } from "./output";
import { bindings } from "./propagate";
import { itemSplit, typedPrice } from "./tables";

// The configuration's money, in one place: what one (candidate, batch quantity) pair costs and sells
// for, line by line, and the per-quantity breakdown the process page draws. The quotation's lines
// (config-quote.ts) and the page's Cost elements pane both go through pairMoney, so the pane, the
// items grid and the posted document cannot disagree.

/** One items-grid row's share at one batch quantity. Per unit; `lineCost` is the row's whole cost. */
export type RowMoney = {
  unitCost: number;
  /** a hand-typed price when there is one (`typed`), else the split's */
  unitPrice: number;
  /** pieces this row ships across every pair at the quantity — unitCost x quantity is the line cost */
  quantity: number;
  lineCost: number;
  typed?: true;
};
/** One element of what the cost is made of: a BOM line under its description, an operation under
 *  its resource, a priced parameter under its label. Batch totals, so they add up to the same cost
 *  the items rows split. */
export type CostLine = { kind: "material" | "operation" | "other"; label: string; amount: number };

/** What the process page shows for one batch quantity. */
export type CostBreakdown = {
  batchQty: number;
  materials: CostLine[];
  operations: CostLine[];
  other: CostLine[];
  cost: number;
  /** what the quotation would total — a typed price wins, each line in whole cents */
  price: number;
  /** share of the price that is margin; null without a price */
  margin: number | null;
  /** per items-grid row, by position in the unfiltered grid; null = ships nothing here. Empty for a
   *  model without an items grid. */
  items: (RowMoney | null)[];
};

/** One priced line of a pair: an items row that ships. */
export type PairLine = {
  index: number;
  /** the evaluated row — where an items map reads its DocumentLine fields */
  row: Record<string, Val>;
  /** row quantity x batch — what rides to SAP as DocumentLine.Quantity */
  quantity: number;
  cost: number;
  unitPrice: number;
  typed: boolean;
};
export type PairMoney = {
  outputs: Outputs;
  /** the items grid's shipping rows; empty = the pair is one line at outputs.unitPrice */
  lines: PairLine[];
  /** what the pair adds to the quotation's total */
  value: number;
  cost: number;
};

/** Whole cents, the way B1 rounds a line total. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The one items table a model may declare, if it declared one. checkModel caps it at one. */
export const itemsTableOf = (model: ModelDef): ItemsTable | undefined =>
  (model.tables ?? []).find((t): t is ItemsTable => t.role === "items");

export const marginOf = (price: number, cost: number): number | null => (price === 0 ? null : (price - cost) / price);

/**
 * The money unit: outputs, then the items split, then a typed price wins.
 *
 * `outputs` defaults to a fresh computeOutputs — the quotation prices live. The page passes the
 * outputs stored on its candidate instead, which staleness (config-project.ts) keeps current.
 *
 * `value` rounds each item line to cents: B1 re-derives LineTotal as round(Quantity * UnitPrice), so
 * rounding the same way is what keeps DocTotal equal to the stored quotedValue once a hand-typed
 * price has moved the total off splitShares' whole-cent guarantee.
 */
export function pairMoney(
  model: ModelDef, lookups: ResolvedLookups, assignment: Entries, batchQty: number, tableRows: TableRows,
  outputs: Outputs = computeOutputs(model, lookups, assignment, batchQty, tableRows),
): PairMoney {
  const items = itemsTableOf(model);
  const cost = outputs.unitCost * batchQty;
  // itemSplit drops the rows that ship nothing, or the shares would not sum to the total.
  const split = !items ? [] : itemSplit(
    items, tableRows[items.key] ?? [], { ...bindings(model, lookups, assignment, tableRows).values, qty: batchQty },
    lookups.tables, batchQty, { cost, price: outputs.unitPrice * batchQty },
  );
  if (!split.length) return { outputs, lines: [], value: outputs.unitPrice * batchQty, cost };
  const lines = split.map((l): PairLine => {
    // read off `raw`: the price is not a declared column, so the evaluated row never carries it
    const typed = typedPrice(l.raw);
    return { index: l.index, row: l.row, quantity: l.quantity, cost: l.cost, unitPrice: typed ?? l.price / l.quantity, typed: typed !== undefined };
  });
  return { outputs, lines, value: lines.reduce((a, l) => a + round2(l.unitPrice * l.quantity), 0), cost };
}

type Candidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
type Pick = { candidateIdx: number; batchQty: number };

/** The same description twice — two BOM lines of the same part, or one line across two candidates
 *  picked at the same quantity — is one row: this reads as a cost breakdown, not a line dump. */
function addLine(m: Map<string, CostLine>, kind: CostLine["kind"], label: string, amount: number) {
  const cur = m.get(`${kind}|${label}`);
  if (cur) cur.amount += amount;
  else m.set(`${kind}|${label}`, { kind, label, amount });
}

/**
 * Every batch quantity's breakdown at once, so switching the shown quantity needs no call.
 *
 * Priced on what is being quoted at that quantity, or — when nothing is picked there — the first
 * picked configuration (else the first candidate) at it, so the page shows money while the user is
 * still choosing. Reads the candidates' stored outputs: nothing is recomputed per read.
 */
export function costBreakdown(
  model: ModelDef, lookups: ResolvedLookups, tableRows: TableRows,
  candidates: Candidate[], selection: Pick[], batches: number[],
): CostBreakdown[] {
  if (!candidates.length) return [];
  const items = itemsTableOf(model);
  const rows = items ? tableRows[items.key] ?? [] : [];
  return batches.map((batchQty) => {
    const at = selection.filter((s) => s.batchQty === batchQty);
    const pairs = at.length ? at : [{ candidateIdx: selection[0]?.candidateIdx ?? 0, batchQty }];
    const lines = new Map<string, CostLine>();
    const acc = new Map<number, { cost: number; price: number; quantity: number; typed: boolean }>();
    let cost = 0;
    let price = 0;
    for (const s of pairs) {
      const cand = candidates[s.candidateIdx];
      const outputs = cand?.perBatch.find((b) => b.batchQty === batchQty)?.outputs;
      if (!cand || !outputs) continue;
      const pm = pairMoney(model, lookups, cand.assignment, batchQty, tableRows, outputs);
      for (const b of outputs.bom) addLine(lines, "material", b.desc.trim() || b.itemCode, b.lineTotal);
      for (const o of outputs.ops) addLine(lines, "operation", o.resource, o.cost);
      for (const o of outputs.other) addLine(lines, "other", o.label, o.amount * batchQty);
      cost += pm.cost;
      price += pm.value;
      for (const l of pm.lines) {
        const a = acc.get(l.index) ?? { cost: 0, price: 0, quantity: 0, typed: false };
        acc.set(l.index, { cost: a.cost + l.cost, price: a.price + l.unitPrice * l.quantity, quantity: a.quantity + l.quantity, typed: a.typed || l.typed });
      }
    }
    const all = [...lines.values()];
    return {
      batchQty,
      materials: all.filter((l) => l.kind === "material"),
      operations: all.filter((l) => l.kind === "operation"),
      other: all.filter((l) => l.kind === "other"),
      cost, price, margin: marginOf(price, cost),
      // several candidates at this quantity -> a quantity-weighted per-unit figure, which is what
      // the document averages to
      items: rows.map((_, i) => {
        const a = acc.get(i);
        return a && a.quantity > 0
          ? { unitCost: a.cost / a.quantity, unitPrice: a.price / a.quantity, quantity: a.quantity, lineCost: a.cost, ...(a.typed ? { typed: true as const } : {}) }
          : null;
      }),
    };
  });
}
