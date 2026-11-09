import { expect, test } from "bun:test";
import { itemsTable, type ModelDef, type Visual } from "@confire/config-engine";
import { addBatch, displayValue, groupVisual, multiItem } from "./formHelpers.ts";

const yn = [
  { value: true, label: "Yes" },
  { value: false, label: "No" },
];
const colors = [
  { value: "red", label: "Crimson" },
  { value: "blue", label: "Azure" },
];

test("displayValue: empty is blank, not a dash", () => {
  expect(displayValue(undefined, [])).toBe("");
  expect(displayValue(null, yn)).toBe("");
});

test("displayValue: domain label, else the raw string; 0 is a value", () => {
  expect(displayValue(true, yn)).toBe("Yes");
  expect(displayValue("red", colors)).toBe("Crimson");
  expect(displayValue("gone", colors)).toBe("gone");
  expect(displayValue(0, [])).toBe("0");
});

test("displayValue: multicombo joins labels", () => {
  expect(displayValue(["red", "blue"], colors)).toBe("Crimson, Azure");
});

test("multiItem: the chip is the label, the stored value is the key", () => {
  expect(multiItem({ value: "red", label: "Crimson", extra: "matte" })).toEqual({ text: "Crimson", value: "red", additionalText: "matte" });
  expect(multiItem({ value: 10, label: "10 mm" })).toEqual({ text: "10 mm", value: "10" });
});

test("addBatch: positive integers only, de-duped, ascending", () => {
  expect(addBatch([10], " 5 ")).toEqual([5, 10]);
  for (const raw of ["", "  ", "-3", "0", "2.5", "abc", "10"]) expect(addBatch([10], raw)).toEqual([10]);
});

// The engine's test model (packages/config-engine/test/fixture.ts `withSheet`), copied.
const SHEET_INPUTS = { sheetLength: "1000", sheetWidth: "500", pieceLength: "120", pieceWidth: "70", gapX: "3", gapY: "3", marginX: "10", marginY: "10" };
const withSheet = (over: Partial<Visual> = {}): ModelDef => ({
  name: "Sheet",
  parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
  structure: { sections: [{ key: "s", title: "S", groups: [
    { key: "g", title: "G", params: ["width", "hoja"] },
    { key: "it", title: "Items", params: ["items"] },
  ] }] },
  computed: [{ key: "perSheet", expr: "hoja_piezas" }],
  tables: [itemsTable()], constraints: [], bom: [], routing: [],
  pricing: { margin: 20, quoteItemCode: "Q", priceList: 1 },
  batchDefaults: [1],
  visuals: [{ key: "hoja", kind: "hera.sheetLayout", inputs: SHEET_INPUTS, ...over }],
});

test("groupVisual finds the visual a group lists, not a parameter or table", () => {
  expect(groupVisual(withSheet(), { key: "g", title: "", params: ["width", "hoja"] })?.key).toBe("hoja");
  expect(groupVisual(withSheet(), { key: "it", title: "", params: ["items"] })).toBeUndefined();
});
