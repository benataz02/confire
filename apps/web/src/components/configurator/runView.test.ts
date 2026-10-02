import { describe, expect, test } from "bun:test";
import type { Outputs } from "@confire/config-engine";
import { chartRows, margin, unpricedItems, type Candidate, type PricedCandidate } from "./runView.ts";

const cand = (...prices: number[]): PricedCandidate => ({
  assignment: {},
  perBatch: prices.map((unitPrice, i) => ({ batchQty: (i + 1) * 10, unitPrice, total: unitPrice * (i + 1) * 10 })),
});
const cands = [cand(12, 9), cand(11, 10), cand(13, 8)];

describe("chartRows", () => {
  test("one line per picked configuration, in pick order", () => {
    expect(chartRows(cands, [
      { candidateIdx: 2, batchQty: 10 }, { candidateIdx: 0, batchQty: 10 }, { candidateIdx: 2, batchQty: 20 },
    ])).toEqual([2, 0]);
  });
  test("nothing picked → the cheapest at the first quantity", () => {
    expect(chartRows(cands, [])).toEqual([1]);
  });
  test("no candidates → no lines", () => {
    expect(chartRows([], [])).toEqual([]);
  });
});

describe("margin", () => {
  test("share of the price", () => expect(margin(10, 7.5)).toBeCloseTo(0.25));
  test("negative when cost exceeds price", () => expect(margin(10, 12)).toBeCloseTo(-0.2));
  test("no price, no margin", () => expect(margin(0, 5)).toBeNull());
});

describe("unpricedItems", () => {
  const out = (bom: Partial<Outputs["bom"][number]>[]) => ({ bom }) as Outputs;
  const c = (...perBatch: Outputs[]): Candidate => ({ assignment: {}, perBatch: perBatch.map((outputs, i) => ({ batchQty: i + 1, outputs })) });

  test("every flagged item code once, across candidates and batches", () => {
    expect(unpricedItems([
      c(out([{ itemCode: "A", unpriced: true }, { itemCode: "B" }]), out([{ itemCode: "A", unpriced: true }])),
      c(out([{ itemCode: "C", unpriced: true }])),
    ])).toEqual(["A", "C"]);
  });
  test("all priced → nothing", () => {
    expect(unpricedItems([c(out([{ itemCode: "A" }]))])).toEqual([]);
  });
});
