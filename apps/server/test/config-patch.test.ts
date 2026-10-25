import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@confire/config-engine";
import { patchColumns, patchProblems, touchesEngine } from "../src/config-patch.ts";

// The patch validator, both sides (pure). The external rules are what acceptPortalInputs enforced.

const model: ModelDef = {
  name: "Box",
  parameters: [
    { key: "grade", label: "Grade", type: "string", ui: "select", domain: { kind: "options", ref: { source: "manual", options: [{ value: "A" }, { value: 2 }] } } },
    { key: "width", label: "Width", type: "number", ui: "input" },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox" },
    { key: "colors", label: "Colors", type: "string", ui: "multicombo", domain: { kind: "options", ref: { source: "manual", options: [{ value: "red" }] } } },
    { key: "locked", label: "Locked", type: "number", ui: "input", readonly: true },
  ],
  structure: { sections: [] },
  computed: [{ key: "margin", expr: "0.4" }],
  constraints: [], bom: [], routing: [],
  tables: [{
    key: "items", title: "Items", role: "items", basisExpr: "1",
    columns: [
      { key: "itemcode", label: "Code", type: "string", cell: { kind: "input" } },
      { key: "quantity", label: "Qty", type: "number", cell: { kind: "input" } },
      { key: "double", label: "Double", type: "number", cell: { kind: "formula", expr: "quantity * 2" } },
    ],
  }],
  pricing: { priceExpr: "0", quoteItemCode: "X" },
  batchDefaults: [1],
};
const check = (patch: Parameters<typeof patchProblems>[1], side: "internal" | "external" = "internal") => patchProblems(model, patch, side);

describe("patchProblems", () => {
  test("well-typed values pass; null is a value; an options field takes its options' own types", () => {
    expect(check({ set: { grade: 2, width: 1200, coated: true, colors: ["red"] } })).toEqual([]);
    expect(check({ set: { grade: "A", width: null, coated: false, colors: ["red"] }, unset: ["width"] })).toEqual([]);
    // outside the options is not a refusal: the view reports it (not_an_option)
    expect(check({ set: { grade: "Z" } })).toEqual([]);
  });

  test("every problem is named at once: unknown key, read-only, wrong type", () => {
    expect(check({ set: { margin: 1, locked: 3, width: "wide", coated: "yes", colors: "red" }, unset: ["nope"] })).toEqual([
      "margin: not a field of this model",
      "locked: read-only",
      "width: expects a number",
      "coated: expects a boolean",
      "colors: expects a list of strings",
      "nope: not a field of this model",
    ]);
  });

  test("tables: an undeclared table or column, a mistyped cell; a typed price needs 0 or more", () => {
    expect(check({ tables: { other: [] } })).toEqual(["other: not a table of this model"]);
    expect(check({ tables: { items: [{ itemcode: "A", quantity: "two", junk: 1 }, { junk: 2 }] } })).toEqual([
      "Items → quantity: expects a number",
      "Items → junk: not a column of this table",
    ]);
    expect(check({ tables: { items: [{ itemcode: "A", quantity: 1, double: 9, unitprice: 5 }] } })).toEqual([]);
    expect(check({ tables: { items: [{ unitprice: -1 }] } })).toEqual(["Items → unitprice: expects a price of 0 or more"]);
    expect(check({ tables: { items: [{ unitcost: 1 }] } })).toEqual(["Items → unitcost: not a column of this table"]);
  });

  test("external: a client types declared input cells only — no formula override, no price", () => {
    expect(check({ set: { grade: "A" }, tables: { items: [{ itemcode: "X1", quantity: 3 }] } }, "external")).toEqual([]);
    expect(check({ set: { locked: 7 } }, "external")).toEqual(["locked: read-only"]);
    expect(check({ set: { margin: 0.9 } }, "external")).toEqual(["margin: not a field of this model"]);
    expect(check({ tables: { items: [{ itemcode: "X1", quantity: 3, unitprice: 1 }] } }, "external")).toEqual(["Items → unitprice: set by the supplier"]);
    expect(check({ tables: { items: [{ itemcode: "X1", double: 1 }] } }, "external")).toEqual(["Items → double: computed, not editable here"]);
    expect(check({ tables: { other: [] } }, "external")).toEqual(["other: not a table of this model"]);
  });

  test("only an engine input empties the calculation", () => {
    expect(touchesEngine({})).toBe(false);
    expect(touchesEngine({ set: {}, unset: [], tables: {} })).toBe(false);
    expect(touchesEngine({ unset: ["width"] })).toBe(true);
    expect(touchesEngine({ batches: [1] })).toBe(true);
  });
});

describe("patchColumns: sources", () => {
  test("a write that may carry sources gets a sources column; a name-only write none", () => {
    expect(patchColumns({ set: { a: 1 } }, {}).sources).toBeDefined();
    expect(patchColumns({ set: { a: 1 } }).sources).toBeDefined(); // no source: drops a's marker
    expect(patchColumns({}, undefined).sources).toBeUndefined();
  });
});
