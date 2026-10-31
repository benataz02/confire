import { describe, expect, test } from "bun:test";
import { formState } from "../src/form-state";
import { propagate } from "../src/propagate";
import type { ModelDef, ResolvedLookups } from "../src/model";

const model: ModelDef = {
  name: "Box",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "table", table: "sizes" } },
    },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox", defaultExpr: "false", priceExpr: "coated ? 5 : 0" },
    { key: "color", label: "Color", type: "string", ui: "input", visibleWhen: "coated", mandatory: true },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "coated", "color"] }, { table: "holes" }] }] },
  computed: [{ key: "area", expr: "size_w * 2" }],
  tables: [{
    role: "calc", key: "holes", title: "Holes",
    columns: [
      { key: "d", label: "Diameter", type: "number", cell: { kind: "input" } },
      { key: "r", label: "Radius", type: "number", cell: { kind: "formula", expr: "d / 2" } },
    ],
  }],
  constraints: [{ kind: "expr", assert: 'size != "L" || !coated', message: "L comes uncoated" }],
  bom: [], routing: [],
  pricing: { margin: 0, quoteItemCode: "X" },
  batchDefaults: [1],
};
const lookups: ResolvedLookups = {
  domains: { size: [{ value: "S", label: "Small" }, { value: "L", label: "Large" }] },
  tables: { sizes: { columns: ["code", "name", "w"], rows: [["S", "Small", 1], ["L", "Large", 2]] } },
};
const state = (entries: Record<string, string | boolean>, rows = {}) =>
  formState(model, lookups, propagate(model, lookups, entries, rows), rows);

describe("formState", () => {
  test("is plain JSON: what goes over the wire is what was built", () => {
    const f = state({ size: "S" }, { holes: [{ d: 4 }] });
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  test("parameter keys only: no computed value, no derived column", () => {
    const f = state({ size: "S" });
    expect(Object.keys(f.fields)).toEqual(["size", "coated", "color"]);
    expect(f.fields.size).toMatchObject({ value: "S", visible: true, required: false });
  });

  test("a default says so, a hidden field is not required, a price badge is evaluated", () => {
    const f = state({});
    expect(f.fields.coated).toMatchObject({ value: false, defaulted: true, price: 0 });
    expect(f.fields.color).toMatchObject({ visible: false, required: false });
    expect(state({ coated: true }).fields.color).toMatchObject({ visible: true, required: true });
    expect(state({ coated: true }).fields.coated!.price).toBe(5);
  });

  test("SELECTED hides a field until its select is picked", () => {
    const m: ModelDef = {
      ...model,
      parameters: model.parameters.map((p) => (p.key === "color" ? { ...p, visibleWhen: "SELECTED(size)" } : p)),
    };
    const at = (entries: Record<string, string>) => formState(m, lookups, propagate(m, lookups, entries, {}), {});
    expect(at({}).fields.color).toMatchObject({ visible: false, required: false });
    expect(at({ size: "S" }).fields.color).toMatchObject({ visible: true, required: true });
  });

  test("options carry the reason they are out, and a table ref's extra columns", () => {
    const f = state({ coated: true });
    expect(f.fields.size!.options).toEqual([
      { value: "S", label: "Small", extra: "Small · 1" },
      { value: "L", label: "Large", unavailable: "L comes uncoated", extra: "Large · 2" },
    ]);
  });

  test("a broken rule marks each field it involves, and is listed once", () => {
    const f = state({ size: "L", coated: true });
    expect(f.conflicts).toEqual([{ message: "L comes uncoated", params: ["size", "coated"] }]);
    expect(f.fields.size!.conflicts).toEqual(["L comes uncoated"]);
    expect(f.fields.coated!.conflicts).toEqual(["L comes uncoated"]);
  });

  test("tables arrive evaluated, declared columns only", () => {
    expect(state({}, { holes: [{ d: 4, junk: 1 }] }).tables).toEqual({ holes: [{ d: 4, r: 2 }] });
  });
});
