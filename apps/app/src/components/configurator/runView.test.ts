import { describe, expect, test } from "bun:test";
import { boolText, candidateLabel, latestDocument, mergeSelection, sortRows } from "./runView.ts";

/** English sentences, not the properties file — `{n}` is filled in order. */
const EN: Record<string, string> = {
  CONFIG_CANDIDATE: "Configuration",
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
  test("a boolean reads as the caller's yes or no, including the filter's string form", () => {
    expect(boolText(true, "Yes", "No")).toBe("Yes");
    expect(boolText(false, "Bai", "Ez")).toBe("Ez");
    expect(boolText("true", "Sí", "No")).toBe("Sí");
    expect(boolText("false", "Yes", "No")).toBe("No");
    expect(boolText("wide", "Yes", "No")).toBeUndefined();
    expect(boolText(null, "Yes", "No")).toBeUndefined();
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

describe("latestDocument", () => {
  const step = (kind: string, entity: string, docEntry: number) => ({ kind, payload: { entity, docEntry, docNum: docEntry, docDate: "2026-11-08", company: "C" } });
  const quoted = { kind: "quoted", payload: { docEntry: 5 } };
  test("the quotation until SAP moves the project on", () => {
    expect(latestDocument({ status: "quoted", b1DocEntry: 5 }, undefined)).toEqual({ entity: "Quotations", docEntry: 5 });
    expect(latestDocument({ status: "quoted", b1DocEntry: 5 }, [quoted])).toEqual({ entity: "Quotations", docEntry: 5 });
  });
  test("the newest SAP step's document; nothing while the events load past Quoted", () => {
    const events = [quoted, step("ordered", "Orders", 7), step("invoiced", "Invoices", 9)];
    expect(latestDocument({ status: "invoiced", b1DocEntry: 5 }, events)).toEqual({ entity: "Invoices", docEntry: 9 });
    expect(latestDocument({ status: "invoiced", b1DocEntry: 5 }, undefined)).toBeNull();
  });
  test("a status the migration set, with no step event, opens the quotation", () => {
    expect(latestDocument({ status: "ordered", b1DocEntry: 5 }, [quoted])).toEqual({ entity: "Quotations", docEntry: 5 });
  });
});
