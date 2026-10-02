import { describe, expect, test } from "bun:test";
import { DslError } from "../src/dsl";
import { computeOutputs } from "../src/output";
import { lookups, model } from "./fixture";

const full = { material: "steel", section: 16, coated: true, color: "black" };

describe("computeOutputs", () => {
  test("coated steel 16mm² at batch 100 — hand-computed", () => {
    const o = computeOutputs(model, lookups, full, 100);
    expect(o.bom.map((l) => l.id)).toEqual(["conductor", "coating"]);
    const [cond, coat] = o.bom;
    expect(cond!.itemCode).toBe("COND-steel");
    expect(cond!.desc).toBe("conductor");
    expect(cond!.qtyPerUnit).toBeCloseTo(0.32);
    expect(cond!.totalQty).toBeCloseTo(32);
    expect(cond!.unitPrice).toBeCloseTo(1.5);
    expect(cond!.lineTotal).toBeCloseTo(48);
    expect(coat!.totalQty).toBeCloseTo(100);
    expect(coat!.unitPrice).toBeCloseTo(0.8); // from lookups.prices, not the model
    expect(o.materialPerUnit).toBeCloseTo(1.28);

    expect(o.ops.map((op) => op.id)).toEqual(["cut", "coat"]);
    const coatOp = o.ops[1]!;
    expect(coatOp.runMinPerUnit).toBeCloseTo(3.2);
    expect(coatOp.totalMin).toBeCloseTo(350);
    expect(coatOp.cost).toBeCloseTo(350);
    expect(o.laborPerUnit).toBeCloseTo(4.1);

    expect(o.unitCost).toBeCloseTo(5.38);
    expect(o.unitPrice).toBeCloseTo(7.532);
    expect(o.batchTotal).toBeCloseTo(753.2);
  });

  test("uncoated: conditional line and op drop out", () => {
    const o = computeOutputs(model, lookups, { material: "steel", section: 16, coated: false }, 100);
    expect(o.bom.map((l) => l.id)).toEqual(["conductor"]);
    expect(o.ops.map((op) => op.id)).toEqual(["cut"]);
  });

  test("setup amortization: bigger batch -> lower unit price", () => {
    const small = computeOutputs(model, lookups, full, 100);
    const big = computeOutputs(model, lookups, full, 1000);
    expect(big.unitPrice).toBeLessThan(small.unitPrice);
    expect(big.batchTotal).toBeGreaterThan(small.batchTotal);
  });

  test("an item the price list does not carry costs 0 and is flagged, not thrown", () => {
    const badLookups = structuredClone(lookups);
    delete badLookups.prices!["COAT-1"];
    const priced = computeOutputs(model, lookups, full, 100);
    const o = computeOutputs(model, badLookups, full, 100);
    const line = o.bom.find((l) => l.itemCode === "COAT-1")!;
    expect(line.unitPrice).toBe(0);
    expect(line.lineTotal).toBe(0);
    expect(line.unpriced).toBe(true);
    expect(o.bom.filter((l) => l.unpriced)).toHaveLength(1);
    expect(o.materialPerUnit).toBeLessThan(priced.materialPerUnit);
  });

  test("batchQty must be >= 1", () => {
    expect(() => computeOutputs(model, lookups, full, 0)).toThrow(RangeError);
  });

  test("non-numeric expr result throws DslError", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = '"5"';
    expect(() => computeOutputs(bad, lookups, full, 100)).toThrow(DslError);
  });
});
