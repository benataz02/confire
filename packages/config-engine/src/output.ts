import { z } from "zod";
import { DslError, evaluate, type Scope } from "./dsl";
import type { Entries, ModelDef, ResolvedLookups, TableRows } from "./model";
import { bindings, paramPrices, type CostElement } from "./propagate";

export type BomResult = {
  id: string;
  itemCode: string;
  desc: string;
  qtyPerUnit: number;
  totalQty: number;
  unitPrice: number;
  lineTotal: number;
  /** the price list has no line for this item, so it was costed at 0 — the page warns about it */
  unpriced?: true;
};
export type OpResult = {
  id: string;
  resource: string;
  desc: string;
  setupMin: number;
  runMinPerUnit: number;
  totalMin: number;
  ratePerHour: number;
  cost: number;
};
export type Outputs = {
  bom: BomResult[];
  ops: OpResult[];
  /** the priced parameters' per-unit costs (Param.priceExpr) */
  other: CostElement[];
  materialPerUnit: number;
  laborPerUnit: number;
  otherPerUnit: number;
  unitCost: number;
  unitPrice: number;
  batchTotal: number;
};

export function computeOutputs(
  model: ModelDef,
  lookups: ResolvedLookups,
  assignment: Entries,
  batchQty: number,
  tableRows?: TableRows,
): Outputs {
  if (batchQty < 1) throw new RangeError(`batchQty must be >= 1, got ${batchQty}`);
  const b = bindings(model, lookups, assignment, tableRows);
  const { values } = b;
  const scope: Scope = { vars: { ...values, qty: batchQty }, tables: lookups.tables };
  const numeric = (src: string, what: string): number => {
    const v = evaluate(src, scope);
    if (typeof v !== "number") throw new DslError(`${what} did not evaluate to a number`, 0, src.length);
    return v;
  };
  const included = (condition: string | undefined) => condition === undefined || evaluate(condition, scope) === true;

  const bom: BomResult[] = [];
  let materialPerUnit = 0;
  for (const l of model.bom) {
    if (!included(l.condition)) continue;
    const qtyPerUnit = numeric(l.qty, `bom '${l.id}' qty`);
    const itemCode = String(evaluate(l.itemCode, scope) ?? "");
    // An item the resolve could not price (not in the price list, not synced yet, or a code only
    // decidable here) costs 0 and is flagged rather than stopping the calculation — so a cache
    // missing one price still quotes, and the process page names the item in its messages.
    const listed = lookups.prices?.[itemCode];
    const unitPrice = listed ?? 0;
    const desc = l.desc ?? "";
    const totalQty = qtyPerUnit * batchQty;
    bom.push({
      id: l.id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal: totalQty * unitPrice,
      ...(listed === undefined ? { unpriced: true as const } : {}),
    });
    materialPerUnit += qtyPerUnit * unitPrice;
  }
  const ops: OpResult[] = [];
  let laborPerUnit = 0;
  const pushOp = (id: string, resource: string, desc: string, setupMin: number, runMinPerUnit: number, rate: number) => {
    const totalMin = setupMin + runMinPerUnit * batchQty;
    ops.push({ id, resource, desc, setupMin, runMinPerUnit, totalMin, ratePerHour: rate, cost: (totalMin / 60) * rate });
    laborPerUnit += ((setupMin / batchQty + runMinPerUnit) / 60) * rate;
  };
  for (const o of model.routing) {
    if (!included(o.condition)) continue;
    pushOp(
      o.id,
      o.resource,
      o.desc ?? "",
      numeric(o.setupMin, `routing '${o.id}' setupMin`),
      numeric(o.runMinPerUnit, `routing '${o.id}' runMinPerUnit`),
      numeric(o.ratePerHour, `routing '${o.id}' ratePerHour`),
    );
  }

  const other = paramPrices(model, b, lookups.tables);
  const otherPerUnit = other.reduce((n, c) => n + c.amount, 0);
  const unitCost = materialPerUnit + laborPerUnit + otherPerUnit;
  // The margin is a share of the price, so the price is the cost grossed up by it.
  const unitPrice = unitCost / (1 - model.pricing.margin / 100);
  // A definition saved before the margin existed has none: refuse it rather than quote NaN to SAP.
  if (!Number.isFinite(unitPrice)) throw new DslError("pricing.margin is not set — set the model's margin", 0, 0);
  // ponytail: raw floats end to end; currency rounding happens at the UI/quote edge
  return { bom, ops, other, materialPerUnit, laborPerUnit, otherPerUnit, unitCost, unitPrice, batchTotal: unitPrice * batchQty };
}
