import { z } from "zod";
import { DslError, evaluate, type Scope } from "./dsl";
import type { Entries, ModelDef, ResolvedLookups, TableRows } from "./model";
import { bindings } from "./propagate";

export type BomResult = {
  id: string;
  itemCode: string;
  desc: string;
  qtyPerUnit: number;
  totalQty: number;
  unitPrice: number;
  lineTotal: number;
};
export type OpResult = {
  id: string;
  resource: string;
  setupMin: number;
  runMinPerUnit: number;
  totalMin: number;
  cost: number;
};
export type Outputs = {
  bom: BomResult[];
  ops: OpResult[];
  materialPerUnit: number;
  laborPerUnit: number;
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
  const { values } = bindings(model, lookups, assignment, tableRows);
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
    // No stored price to fall back on: an item whose code the resolve could not price (not in the
    // price list, or a code only decidable here) stops the calculation rather than costing zero.
    const unitPrice = lookups.prices?.[itemCode];
    if (unitPrice === undefined)
      throw new DslError(
        model.pricing.priceList
          ? `bom '${l.id}': item '${itemCode}' has no price in price list ${model.pricing.priceList}`
          : `bom '${l.id}': the model has no price list, so '${itemCode}' cannot be priced`,
        0, 0,
      );
    const desc = l.desc ?? "";
    const totalQty = qtyPerUnit * batchQty;
    bom.push({ id: l.id, itemCode, desc, qtyPerUnit, totalQty, unitPrice, lineTotal: totalQty * unitPrice });
    materialPerUnit += qtyPerUnit * unitPrice;
  }
  const ops: OpResult[] = [];
  let laborPerUnit = 0;
  const pushOp = (id: string, resource: string, setupMin: number, runMinPerUnit: number, rate: number) => {
    const totalMin = setupMin + runMinPerUnit * batchQty;
    ops.push({ id, resource, setupMin, runMinPerUnit, totalMin, cost: (totalMin / 60) * rate });
    laborPerUnit += ((setupMin / batchQty + runMinPerUnit) / 60) * rate;
  };
  for (const o of model.routing) {
    if (!included(o.condition)) continue;
    pushOp(
      o.id,
      o.resource,
      numeric(o.setupMin, `routing '${o.id}' setupMin`),
      numeric(o.runMinPerUnit, `routing '${o.id}' runMinPerUnit`),
      numeric(o.ratePerHour, `routing '${o.id}' ratePerHour`),
    );
  }

  const unitCost = materialPerUnit + laborPerUnit;
  const priceScope: Scope = { vars: { ...scope.vars, unitCost }, tables: lookups.tables };
  const unitPrice = evaluate(model.pricing.priceExpr, priceScope);
  if (typeof unitPrice !== "number")
    throw new DslError("pricing.priceExpr did not evaluate to a number", 0, model.pricing.priceExpr.length);
  // ponytail: raw floats end to end; currency rounding happens at the UI/quote edge
  return { bom, ops, materialPerUnit, laborPerUnit, unitCost, unitPrice, batchTotal: unitPrice * batchQty };
}
