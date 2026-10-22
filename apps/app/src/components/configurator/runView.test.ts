import { describe, expect, test } from "bun:test";
import type { Outputs } from "@confire/config-engine";
import {
  candidateLabel, chartRows, margin, mergeSelection, projectStatusText, sortRows, statusUi, unpricedItems,
  type Candidate, type PricedCandidate,
} from "./runView.ts";

/** English sentences, not the properties file — `{n}` is filled in order. */
const EN: Record<string, string> = {
  CONFIG_CANDIDATE: "Configuration",
  CONFIG_STATUS_DRAFT: "Draft",
  CONFIG_STATUS_QUOTED: "Quoted",
  CONFIG_STATUS_SUBMITTED: "Submitted",
  CONFIG_STATUS_IN_REVIEW: "In review",
  CONFIG_STATUS_RETURNED: "Changes requested",
  CONFIG_STATUS_DECLINED: "Declined",
};
const t = (key: string, ...params: string[]) => {
  const template = EN[key];
  if (template === undefined) throw new Error(`missing English text for ${key}`);
  return template.replace(/\{(\d+)\}/g, (_, i: string) => params[Number(i)] ?? "");
};

const cand = (...prices: number[]): PricedCandidate => ({
  assignment: {},
  perBatch: prices.map((unitPrice, i) => ({ batchQty: (i + 1) * 10, unitPrice, total: unitPrice * (i + 1) * 10 })),
});
const cands = [cand(12, 9), cand(11, 10), cand(13, 8)];

describe("labels", () => {
  test("a candidate with nothing open is just the configuration", () => {
    expect(candidateLabel(t, [], {})).toBe("Configuration");
    expect(candidateLabel(t, ["width"], { width: 12 })).toBe("12");
    expect(candidateLabel(t, ["width"], {})).toBe("—");
  });
  test("list statuses and the request tag read as sentences", () => {
    expect(statusUi(t).draft).toEqual({ state: "None", text: "Draft" });
    expect(statusUi(t).quoted).toEqual({ state: "Positive", text: "Quoted" });
    expect(projectStatusText(t, "in_review")).toBe("In review");
    expect(projectStatusText(t, "custom")).toBe("custom");
  });
});

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

describe("mergeSelection", () => {
  const s = (candidateIdx: number, batchQty: number) => ({ candidateIdx, batchQty });
  test("a pick hidden by a filter survives a change to the visible ones", () => {
    // 0:10 is filtered out; 1:10 was picked and is unticked; 2:10 is newly ticked
    expect(mergeSelection([s(0, 10), s(1, 10)], new Set(["1:10", "2:10"]), [s(2, 10)]))
      .toEqual([s(0, 10), s(2, 10)]);
  });
  test("pick order holds", () => {
    expect(mergeSelection([s(2, 10), s(0, 10)], new Set(["0:10", "2:10", "1:10"]), [s(0, 10), s(1, 10), s(2, 10)]))
      .toEqual([s(2, 10), s(0, 10), s(1, 10)]);
  });
});

describe("sortRows", () => {
  const rows = [{ q: 100, m: "B", p: 2 }, { q: 10, m: "a10", p: null }, { q: 10, m: "a9", p: 1 }];
  test("multi-key, numbers numerically, text with numeric digits", () => {
    expect(sortRows(rows, [{ field: "q", direction: "asc" }, { field: "m", direction: "asc" }]).map((r) => r.m))
      .toEqual(["a9", "a10", "B"]);
  });
  test("an empty number sorts lowest; desc flips", () => {
    expect(sortRows(rows, [{ field: "p", direction: "desc" }]).map((r) => r.p)).toEqual([2, 1, null]);
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
