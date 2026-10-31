import { describe, expect, test } from "bun:test";
import { candidateLabel, mergeSelection, projectStatusText, sortRows, statusUi } from "./runView.ts";

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
