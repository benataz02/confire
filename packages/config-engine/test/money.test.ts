import { describe, expect, test } from "bun:test";
import { computeOutputs } from "../src/output";
import { costBreakdown, pairMoney } from "../src/money";
import type { ModelDef, ResolvedLookups, TableRows } from "../src/model";

// unitCost = 10 (one sheet at 10, no routing), unitPrice = unitCost * 2 = 20.
// Rows weigh 2:1 by `area`, both shipping one piece per finished unit.
const model: ModelDef = {
  name: "Merged sheet",
  parameters: [
    {
      key: "thickness", label: "Thickness", type: "number", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: 2 }, { value: 3 }] } },
    },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ table: "parts" }] }] },
  computed: [],
  tables: [{
    role: "items", key: "parts", title: "Parts", basisExpr: "area",
    columns: [
      { key: "itemcode", label: "Code", type: "string", cell: { kind: "input" } },
      { key: "quantity", label: "Pieces", type: "number", cell: { kind: "input" } },
      { key: "area", label: "Area", type: "number", cell: { kind: "input" } },
    ],
  }],
  constraints: [],
  bom: [{ id: "sheet", itemCode: '"SHEET"', qty: "1" }],
  routing: [],
  pricing: { margin: 50, quoteItemCode: "SHEET-CFG", priceList: 1 },
  batchDefaults: [3],
};

const lookups: ResolvedLookups = { domains: {}, tables: {}, prices: { SHEET: 10 } };
const tables: TableRows = {
  parts: [
    { itemcode: "A", quantity: 1, area: 2 },
    { itemcode: "B", quantity: 1, area: 1 },
  ],
};
const candidatesOf = (m: ModelDef, t: TableRows = tables) => [{
  assignment: { thickness: 3 },
  perBatch: [3, 6].map((n) => ({ batchQty: n, outputs: computeOutputs(m, lookups, { thickness: 3 }, n, t) })),
}];
const breakdown = (selection: { candidateIdx: number; batchQty: number }[], m = model, t = tables) =>
  costBreakdown(m, lookups, t, candidatesOf(m, t), selection, [3, 6]);

describe("costBreakdown", () => {
  test("prices the first candidate at every batch before anything is selected", () => {
    const [at3, at6] = breakdown([]);
    // total price 20 * 3 = 60, split 2:1 -> 40 and 20, over 3 pieces each
    expect(at3!.batchQty).toBe(3);
    expect(at3!.items[0]!.unitPrice).toBeCloseTo(40 / 3, 8);
    expect(at3!.items[1]!.unitPrice).toBeCloseTo(20 / 3, 8);
    // cost splits on the same weights: total cost 10 * 3 = 30 -> 20 and 10
    expect(at3!.items[0]!.unitCost).toBeCloseTo(20 / 3, 8);
    expect(at3!.items[1]!.unitCost).toBeCloseTo(10 / 3, 8);
    expect(at3!.items[0]!.lineCost).toBeCloseTo(20, 8);
    expect(at6!.items[0]!.quantity).toBe(6); // every quantity at once
  });

  test("the per-unit figures reconstruct the line totals the quotation carries", () => {
    const [m] = breakdown([{ candidateIdx: 0, batchQty: 3 }]);
    const lineTotals = m!.items.map((r) => r!.unitPrice * r!.quantity);
    expect(lineTotals.reduce((a, b) => a + b, 0)).toBeCloseTo(60, 8);
    expect(m!.items.map((r) => r!.quantity)).toEqual([3, 3]);
    expect(m!.price).toBeCloseTo(60, 8);
    expect(m!.cost).toBeCloseTo(30, 8);
    expect(m!.margin).toBeCloseTo(0.5, 8);
  });

  test("each quantity prices its own picks, or the first picked configuration", () => {
    const [, at6] = breakdown([{ candidateIdx: 0, batchQty: 3 }]);
    // nothing picked at 6: the configuration picked at 3 previews it
    expect(at6!.items[0]!.quantity).toBe(6);
  });

  test("a row that ships nothing gets no figures, and the rest still add up", () => {
    const withBlank: TableRows = { parts: [tables.parts![0]!, { itemcode: "C", quantity: 0, area: 5 }, tables.parts![1]!] };
    const [m] = breakdown([{ candidateIdx: 0, batchQty: 3 }], model, withBlank);
    expect(m!.items[1]).toBeNull();
    expect(m!.items.filter(Boolean).reduce((a, r) => a + r!.unitPrice * r!.quantity, 0)).toBeCloseTo(60, 8);
  });

  test("the cost lines say what the money is made of, by description", () => {
    // desc when the builder filled one in, the item code when it did not; routing lands under the
    // resource. unitCost = 10 material + 16 labor, so the lines must add up to 26 * 3.
    const withOps: ModelDef = {
      ...model,
      bom: [{ id: "sheet", itemCode: '"SHEET"', qty: "1", desc: "Steel sheet" }],
      routing: [{ id: "cut", resource: "Laser", setupMin: "30", runMinPerUnit: "6", ratePerHour: "60" }],
    };
    const [m] = breakdown([{ candidateIdx: 0, batchQty: 3 }], withOps);
    expect(m!.materials).toEqual([{ kind: "material", label: "Steel sheet", amount: 30 }]);
    expect(m!.operations).toEqual([{ kind: "operation", label: "Laser", amount: 48 }]);
    // same total the Items block splits over the grid
    expect(m!.cost).toBeCloseTo(78, 8);
    expect(m!.items.reduce((a, r) => a + (r ? r.lineCost : 0), 0)).toBeCloseTo(78, 8);
  });

  test("an unnamed BOM line falls back to its item code, and repeats merge", () => {
    const twice: ModelDef = { ...model, bom: [{ id: "a", itemCode: '"SHEET"', qty: "1" }, { id: "b", itemCode: '"SHEET"', qty: "2" }] };
    const [m] = breakdown([], twice);
    expect(m!.materials).toEqual([{ kind: "material", label: "SHEET", amount: 90 }]); // (1 + 2) x 3 sheets
  });

  test("a typed unit price wins over the split, the way the quotation does", () => {
    // cost 30 either way; price 40 (split) + 3 pieces typed at 5 = 55 instead of 40 + 20
    const typed: TableRows = { parts: [tables.parts![0]!, { ...tables.parts![1]!, unitprice: 5 }] };
    const [m] = breakdown([{ candidateIdx: 0, batchQty: 3 }], model, typed);
    expect(m!.items[1]).toMatchObject({ unitPrice: 5, typed: true });
    expect(m!.items[0]!.typed).toBeUndefined();
    expect(m!.cost).toBeCloseTo(30, 8);
    expect(m!.price).toBeCloseTo(55, 8);
  });

  test("a model without an items grid still has its breakdown", () => {
    const plain: ModelDef = { ...model, tables: [], structure: { sections: [] } };
    const [m] = breakdown([], plain, {});
    expect(m!.items).toEqual([]);
    expect(m!.price).toBeCloseTo(60, 8);
    expect(m!.materials).toHaveLength(1);
  });

  test("no candidates means no breakdown at all, not a zero", () => {
    expect(costBreakdown(model, lookups, tables, [], [], [3])).toEqual([]);
  });
});

describe("pairMoney", () => {
  test("stored outputs and a fresh computation price the same", () => {
    const stored = computeOutputs(model, lookups, { thickness: 3 }, 3, tables);
    expect(pairMoney(model, lookups, { thickness: 3 }, 3, tables, stored)).toEqual(pairMoney(model, lookups, { thickness: 3 }, 3, tables));
  });
  test("no shipping rows is one line at the configuration's own price", () => {
    const pm = pairMoney(model, lookups, { thickness: 3 }, 3, { parts: [] });
    expect(pm.lines).toEqual([]);
    expect(pm.value).toBeCloseTo(60, 8);
  });
});
