import { describe, expect, test } from "bun:test";
import { DslError } from "../src/dsl";
import { computeOutputs } from "../src/output";
import { linkedModel, lookups, model } from "./fixture";

const full = { material: "steel", section: 16, coated: true, color: "black" };

describe("computeOutputs", () => {
  test("coated steel 16mm² at batch 100 — hand-computed", () => {
    const o = computeOutputs(model, lookups, full, 100);
    expect(o.bom.map((l) => l.itemCode)).toEqual(["COND-steel", "COAT-1"]);
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

    expect(o.ops.map((op) => op.resource)).toEqual(["SAW", "COATER"]);
    const coatOp = o.ops[1]!;
    expect(coatOp.runMinPerUnit).toBeCloseTo(3.2);
    expect(coatOp.totalMin).toBeCloseTo(350);
    expect(coatOp.cost).toBeCloseTo(350);
    expect(coatOp.ratePerHour).toBeCloseTo(60);
    expect(coatOp.desc).toBe("");
    expect(o.laborPerUnit).toBeCloseTo(4.1);

    expect(o.other).toEqual([]);
    expect(o.unitCost).toBeCloseTo(5.38);
    // margin 50%: half the price is margin
    expect(o.unitPrice).toBeCloseTo(10.76);
    expect(o.batchTotal).toBeCloseTo(1076);
  });

  test("a priced parameter is cost, a hidden one is not, and the margin is grossed up over it", () => {
    const m = structuredClone(model);
    m.parameters.find((p) => p.key === "coated")!.priceExpr = "coated ? 2 : 0";
    m.parameters.find((p) => p.key === "color")!.priceExpr = "1"; // visibleWhen: coated
    m.pricing.margin = 20;
    const o = computeOutputs(m, lookups, full, 100);
    expect(o.other).toEqual([{ key: "coated", label: "Coated", amount: 2 }, { key: "color", label: "Coating color", amount: 1 }]);
    expect(o.otherPerUnit).toBe(3);
    expect(o.unitCost).toBeCloseTo(8.38);
    expect(o.unitPrice).toBeCloseTo(8.38 / 0.8);
    const bare = computeOutputs(m, lookups, { ...full, coated: false }, 100);
    expect(bare.other).toEqual([{ key: "coated", label: "Coated", amount: 0 }]);
  });

  test("uncoated: conditional line and op drop out", () => {
    const o = computeOutputs(model, lookups, { material: "steel", section: 16, coated: false }, 100);
    expect(o.bom.map((l) => l.itemCode)).toEqual(["COND-steel"]);
    expect(o.ops.map((op) => op.resource)).toEqual(["SAW"]);
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

describe("computeOutputs over the Beas catalog", () => {
  const withOps = { ...lookups, operations: { ACA_AGUJEROS: { desc: "AGUJEROS", resource: "ACA_ACABADO", setupMin: 5, runMinPerUnit: 0.1, ratePerHour: 21 } } };

  test("a linked line costs from the catalog, and its formula may scale a catalog figure", () => {
    const o = computeOutputs(linkedModel(), withOps, full, 100); // full.section = 16
    const op = o.ops[2]!;
    expect(op.operationId).toBe("ACA_AGUJEROS");
    expect(op.resource).toBe("ACA_ACABADO"); // the line's resource is empty
    expect(op.desc).toBe("AGUJEROS");
    expect(op.setupMin).toBe(5);
    expect(op.runMinPerUnit).toBeCloseTo(1.6); // beasRun * section
    expect(op.ratePerHour).toBe(21);
    expect(op.cost).toBeCloseTo(((5 + 1.6 * 100) / 60) * 21);
    expect(op.uncatalogued).toBeUndefined();
  });
  test("the line's own resource and description win over the catalog's", () => {
    const m = linkedModel();
    m.routing[2] = { ...m.routing[2]!, resource: "SAW2", desc: "x" };
    const op = computeOutputs(m, withOps, full, 100).ops[2]!;
    expect(op.resource).toBe("SAW2");
    expect(op.desc).toBe("x");
  });
  test("an operation missing from the catalog is flagged and its names count as 0", () => {
    const o = computeOutputs(linkedModel(), lookups, full, 100); // no `operations`
    expect(o.ops[2]!.uncatalogued).toBe(true);
    expect(o.ops[2]!.cost).toBe(0);
  });
  test("computeOutputs trims an evaluated operation code", () => {
    const m = linkedModel();
    m.routing[2]!.operationId = '"ACA_AGUJEROS  "';
    expect(computeOutputs(m, withOps, full, 100).ops[2]!.uncatalogued).toBeUndefined();
  });
});
