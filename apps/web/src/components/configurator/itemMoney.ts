import {
  bindings, computeOutputs, itemSplit,
  type ItemsTable, type ModelDef, type ResolvedLookups, type TableRows,
} from "@confire/config-engine";
import type { Candidate, Sel } from "./runView.ts";

// Per-unit cost and price for each row of the items grid, derived on every render and stored
// nowhere.
//
// A stored cell IS an override in this engine, so writing these back would mark every row as
// hand-typed, and — because a `tables` write empties `candidates` in the same statement — would
// retrigger the calculation that produced them. The grid therefore asks for the numbers rather
// than keeping them.
//
// The split is `itemSplit`, the same function buildQuoteLines calls, against the same scope, so
// what the salesperson reads here is what the server posts. `computeOutputs` runs rather than
// `candidate.perBatch[].outputs` being read off the row: a selection may carry BOM/routing
// overrides, and the engine is the only thing that knows what they do to the cost.

export type RowMoney = {
  unitCost: number;
  unitPrice: number;
  /** pieces this row ships across every selected batch — unitCost x quantity is the line cost */
  quantity: number;
};
export type ItemMoney = {
  /** the quantity the figures are priced at — null when several batches are selected at once */
  batchQty: number | null;
  /** indexed by position in the unfiltered grid; a row that ships nothing has no share */
  rows: (RowMoney | undefined)[];
};

/** Accumulated share of one row across every (candidate, batch) pair that ships it. */
type Acc = { cost: number; price: number; quantity: number };

export function itemMoney(args: {
  model: ModelDef;
  lookups: ResolvedLookups;
  items: ItemsTable;
  tables: TableRows;
  candidates: Candidate[];
  selection: Sel[];
  batches: number[];
}): ItemMoney | null {
  const { model, lookups, items, tables, candidates, selection, batches } = args;
  const rows = tables[items.key] ?? [];
  if (!candidates.length || !rows.length) return null;

  // What is actually being quoted, or — before anything is picked — the first candidate at the
  // first batch quantity, so the grid shows money while the form is still being filled in. The
  // header names the quantity, because setup cost spread over a batch makes "the price" meaningless
  // without one.
  const pairs: Sel[] = selection.length
    ? selection
    : [{ candidateIdx: 0, batchQty: batches[0] ?? candidates[0]!.perBatch[0]?.batchQty ?? 1 }];

  const acc = new Map<number, Acc>();
  let any = false;
  for (const s of pairs) {
    const cand = candidates[s.candidateIdx];
    if (!cand) continue;
    let out;
    try {
      out = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides, tables);
    } catch {
      continue; // undecidable while an input is open — same silence the price badges give
    }
    const scope = { ...bindings(model, lookups, cand.assignment, tables).values, qty: s.batchQty };
    for (const l of itemSplit(items, rows, scope, lookups.tables, s.batchQty, {
      cost: out.unitCost * s.batchQty,
      price: out.unitPrice * s.batchQty,
    })) {
      any = true;
      const a = acc.get(l.index) ?? { cost: 0, price: 0, quantity: 0 };
      acc.set(l.index, { cost: a.cost + l.cost, price: a.price + l.price, quantity: a.quantity + l.quantity });
    }
  }
  if (!any) return null;

  const qtys = new Set(pairs.map((s) => s.batchQty));
  return {
    batchQty: qtys.size === 1 ? [...qtys][0]! : null,
    rows: rows.map((_, i) => {
      const a = acc.get(i);
      // several pairs -> a quantity-weighted per-unit figure, which is what the document averages to
      return a && a.quantity > 0
        ? { unitCost: a.cost / a.quantity, unitPrice: a.price / a.quantity, quantity: a.quantity }
        : undefined;
    }),
  };
}
