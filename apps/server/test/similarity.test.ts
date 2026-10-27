import { describe, expect, test } from "bun:test";
import { scoreRows, type HistoryDef } from "../src/similarity.ts";

const history: HistoryDef = {
  mappings: [{ param: "material", column: "mat", match: "exact", weight: 1 }],
  display: ["doc"],
};

describe("scoreRows", () => {
  test("omits a past row that matches nothing", () => {
    const scored = scoreRows(history, [{ material: "steel" }], [
      { mat: "steel", doc: "Q1" },
      { mat: "wood", doc: "Q2" },
    ]);
    expect(scored.map((s) => s.row.doc)).toEqual(["Q1"]);
  });

  test("omits a row the panel would label 0%", () => {
    const wide: HistoryDef = {
      mappings: [{ param: "width", column: "w", match: "closeness", weight: 1 }],
      display: ["doc"],
    };
    // Range is 0..1000. 996 against 0 scores 0.004 — Math.round(0.4) is 0%.
    const scored = scoreRows(wide, [{ width: 0 }], [
      { w: 996, doc: "far" },
      { w: 1000, doc: "span" },
      { w: 10, doc: "near" },
    ]);
    expect(scored.map((s) => s.row.doc)).toEqual(["near"]);
    expect(Math.round(scored[0]!.score * 100)).toBeGreaterThan(0);
  });

  test("matches every items-grid row, one row whole", () => {
    const lines: HistoryDef = {
      mappings: [
        { param: "material", column: "mat", match: "exact", weight: 1 },
        { param: "item", table: "items", column: "code", match: "exact", weight: 1 },
        { param: "width", table: "items", column: "w", match: "exact", weight: 1 },
      ],
      display: ["doc"],
    };
    const params = { material: "steel" };
    const scored = scoreRows(lines, [
      { ...params, "items.item": "A", "items.width": 10 },
      params, // an empty grid row: parameters alone would score 100% on Q2
      { ...params, "items.item": "B", "items.width": 20 },
    ], [
      { mat: "steel", code: "B", w: 20, doc: "Q1" }, // the third grid row, whole
      { mat: "steel", code: "A", w: 20, doc: "Q2" }, // A of one row, 20 of another
    ]);
    expect(scored.map((s) => [s.row.doc, s.probe, Math.round(s.score * 100)])).toEqual([["Q1", 2, 100], ["Q2", 0, 67]]);
  });
});
