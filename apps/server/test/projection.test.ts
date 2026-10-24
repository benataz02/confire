import { describe, expect, test } from "bun:test";
import { formState, propagate, type ModelDef, type ResolvedLookups } from "@confire/config-engine";
import {
  toPortalForm, toPortalLookups, toPortalModelDef, toPortalPage, toPortalPrices, toPortalRows,
} from "../src/portal/projection.ts";

// The portal fence (spec §7.1), both directions. Pure: no database, no agent.

const model: ModelDef = {
  name: "Box",
  description: "A box",
  parameters: [
    {
      key: "grade", label: "Grade", type: "string", ui: "select", mandatory: true,
      domain: { kind: "options", ref: { source: "table", table: "grades" } },
      priceExpr: "grade_cost * 2",
    },
    { key: "secret", label: "Internal", type: "number", ui: "input", visibleWhen: "grade == \"X\"", defaultExpr: "41 + 1" },
    { key: "locked", label: "Locked", type: "number", ui: "input", readonly: true, defaultExpr: "3" },
  ],
  structure: { sections: [{ key: "s", title: "S", groups: [{ key: "g", title: "G", params: ["grade", "secret", "locked"] }, { table: "items" }] }] },
  computed: [{ key: "margin", expr: "0.4" }],
  constraints: [{ kind: "expr", assert: "grade != \"Z\"", message: "Z is out" }],
  bom: [{ id: "b", itemCode: '"BODY"', qty: "1" }],
  routing: [{ id: "r", resource: "SAW", setupMin: "1", runMinPerUnit: "1", ratePerHour: "60" }],
  tables: [{
    key: "items", title: "Items", role: "items", basisExpr: "quantity * margin", map: { itemcode: "U_CF_ItemCode" },
    columns: [
      { key: "itemcode", label: "Code", type: "string", cell: { kind: "input" } },
      { key: "quantity", label: "Qty", type: "number", cell: { kind: "input" } },
      { key: "double", label: "Double", type: "number", cell: { kind: "formula", expr: "quantity * 2" } },
    ],
  }],
  pricing: { priceExpr: "unitCost * 1.4", quoteItemCode: "CFG", priceList: 1, itemTable: "catalog" },
  batchDefaults: [10],
};

const lookups: ResolvedLookups = {
  domains: { grade: [{ value: "A", label: "Alpha" }, { value: "B", label: "Beta" }] },
  tables: {
    // `cost` is hidden: it feeds the price badge and must never reach the client
    grades: { columns: ["code", "name", "cost"], rows: [["A", "Alpha", 5], ["B", "Beta", 7]], hidden: ["cost", "code"] },
    catalog: { columns: ["ItemCode"], rows: [["BODY"]] },
  },
  prices: { BODY: 3 },
};

const tables = { items: [{ itemcode: "X1", quantity: 2, unitprice: 99 }, { itemcode: "X2", quantity: 1, double: 50 }] };

describe("toPortalModelDef", () => {
  const out = toPortalModelDef(model);
  const json = JSON.stringify(out);

  test("keeps the form, drops every expression and everything that prices", () => {
    expect(out.parameters.map((p) => p.key)).toEqual(["grade", "secret", "locked"]);
    expect(out.structure).toEqual(model.structure);
    for (const leak of ["grade_cost", "41 + 1", "visibleWhen", "quantity * 2", "quantity * margin", "U_CF_ItemCode", "BODY", "SAW", "unitCost", "catalog", "Z is out"])
      expect(json).not.toContain(leak);
    expect(out.computed).toEqual([]);
    expect(out.bom).toEqual([]);
    expect(out.routing).toEqual([]);
  });
});

describe("toPortalForm / toPortalLookups", () => {
  const prop = propagate(model, lookups, { grade: "A" }, tables);
  const form = formState(model, lookups, prop, tables);
  const pf = toPortalForm(form, true);
  const json = JSON.stringify(pf);

  test("fields are parameter keys only — no computed, no derived <param>_<column>", () => {
    expect(prop.values.grade_cost).toBe(5); // the engine has it…
    expect(prop.values.margin).toBe(0.4);
    expect(Object.keys(pf.fields)).toEqual(["grade", "secret", "locked"]); // …the client does not
    expect(json).not.toContain("grade_cost");
  });

  test("a hidden field is visible: false and nothing else — its default stays home", () => {
    expect(form.fields.secret!.value).toBe(42);
    expect(pf.fields.secret).toEqual({ visible: false, required: false });
    expect(pf.fields.grade).toMatchObject({ value: "A", required: true });
  });

  test("tables arrive evaluated, declared columns only — a typed unit price stays home", () => {
    expect(pf.tables.items).toEqual([
      { itemcode: "X1", quantity: 2, double: 4 },
      { itemcode: "X2", quantity: 1, double: 50 }, // an override shows as its value
    ]);
    expect(json).not.toContain("99");
  });

  test("badges are amounts, and only on an indicative model; the expression stays home", () => {
    expect(pf.fields.grade!.price).toBe(10);
    expect(toPortalForm(form, false).fields.grade!.price).toBeUndefined();
  });

  test("lookups: the named option tables, hidden columns out but the key kept; no prices, no domains", () => {
    const lk = toPortalLookups(model, pf, lookups);
    expect(lk).not.toHaveProperty("prices");
    expect(lk).not.toHaveProperty("domains");
    expect(Object.keys(lk.tables)).toEqual(["grades"]); // not the item-price catalog
    expect(lk.tables.grades!.columns).toEqual(["code", "name"]); // `code` is the key: kept though hidden
    expect(lk.tables.grades!.rows).toEqual([["A", "Alpha"], ["B", "Beta"]]);
    expect(lk.tables.grades!.hidden).toBeUndefined();
  });

  test("a value-help page follows the same column rule", () => {
    const page = toPortalPage(model, "grades", { columns: ["code", "name", "cost"], rows: [["C", "Gamma", 9]], hidden: ["cost"] });
    expect(page).toEqual({ columns: ["code", "name"], rows: [["C", "Gamma"]] });
  });
});

describe("toPortalPrices", () => {
  const out = (unitPrice: number, batchTotal: number) => ({ unitPrice, batchTotal }) as never;
  test("one candidate is exact, several are 'from' the cheapest", () => {
    expect(toPortalPrices([{ assignment: {}, perBatch: [{ batchQty: 10, outputs: out(5, 50) }] }], [10])).toEqual([
      { batchQty: 10, unitPrice: 5, total: 50, from: false },
    ]);
    expect(toPortalPrices([
      { assignment: {}, perBatch: [{ batchQty: 10, outputs: out(5, 50) }, { batchQty: 20, outputs: out(4, 80) }] },
      { assignment: {}, perBatch: [{ batchQty: 10, outputs: out(3, 30) }, { batchQty: 20, outputs: out(6, 120) }] },
    ], [10, 20])).toEqual([
      { batchQty: 10, unitPrice: 3, total: 30, from: true },
      { batchQty: 20, unitPrice: 4, total: 80, from: true },
    ]);
  });
});

describe("toPortalRows", () => {
  test("a stored table goes out with its writable cells only: no override, no typed price", () => {
    expect(toPortalRows(model, tables)).toEqual({ items: [{ itemcode: "X1", quantity: 2 }, { itemcode: "X2", quantity: 1 }] });
  });
});
