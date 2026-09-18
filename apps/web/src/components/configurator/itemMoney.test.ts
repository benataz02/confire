import { describe, expect, test } from "bun:test";
import { computeOutputs, type ModelDef, type ResolvedLookups, type TableRows } from "@confire/config-engine";
import { itemMoney } from "./itemMoney.ts";
import type { Candidate } from "./runView.ts";

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
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "SHEET-CFG", priceList: 1 },
  batchDefaults: [3],
};

const items = model.tables![0]! as Extract<(typeof model.tables)[number], { role: "items" }>;
const lookups: ResolvedLookups = { domains: {}, tables: {}, prices: { SHEET: 10 } };
const tables: TableRows = {
  parts: [
    { itemcode: "A", quantity: 1, area: 2 },
    { itemcode: "B", quantity: 1, area: 1 },
  ],
};
const batchOf = (n: number) => ({
  batchQty: n,
  outputs: computeOutputs(model, lookups, { thickness: 3 }, n, undefined, tables),
});
const candidates: Candidate[] = [{ assignment: { thickness: 3 }, perBatch: [batchOf(3), batchOf(6)] }];
const call = (selection: Parameters<typeof itemMoney>[0]["selection"], batches = [3]) =>
  itemMoney({ model, lookups, items, tables, candidates, selection, batches });

describe("itemMoney", () => {
  test("previews the first candidate at the first batch before anything is selected", () => {
    const m = call([]);
    // total price 20 * 3 = 60, split 2:1 -> 40 and 20, over 3 pieces each
    expect(m!.batchQty).toBe(3);
    expect(m!.rows[0]!.unitPrice).toBeCloseTo(40 / 3, 8);
    expect(m!.rows[1]!.unitPrice).toBeCloseTo(20 / 3, 8);
    // cost splits on the same weights: total cost 10 * 3 = 30 -> 20 and 10
    expect(m!.rows[0]!.unitCost).toBeCloseTo(20 / 3, 8);
    expect(m!.rows[1]!.unitCost).toBeCloseTo(10 / 3, 8);
  });

  test("the per-unit figures reconstruct the line totals the quotation carries", () => {
    const m = call([{ candidateIdx: 0, batchQty: 3 }]);
    const lineTotals = m!.rows.map((r) => r!.unitPrice * r!.quantity);
    expect(lineTotals.reduce((a, b) => a + b, 0)).toBeCloseTo(60, 8);
    expect(m!.rows.map((r) => r!.quantity)).toEqual([3, 3]);
  });

  test("several selected batches average per unit and drop the header's quantity", () => {
    const m = call([{ candidateIdx: 0, batchQty: 3 }, { candidateIdx: 0, batchQty: 6 }]);
    // no single quantity the figures are priced at, so the column header stops claiming one
    expect(m!.batchQty).toBeNull();
    expect(m!.rows[0]!.quantity).toBe(9); // 1 * 3 + 1 * 6
    // unit price is unchanged here (no setup cost to spread), but the weighting must still hold
    expect(m!.rows[0]!.unitPrice).toBeCloseTo(40 / 3, 8);
  });

  test("a row that ships nothing gets no figures, and the rest still add up", () => {
    const withBlank: TableRows = {
      parts: [tables.parts![0]!, { itemcode: "C", quantity: 0, area: 5 }, tables.parts![1]!],
    };
    const m = itemMoney({
      model, lookups, items, tables: withBlank, candidates,
      selection: [{ candidateIdx: 0, batchQty: 3 }], batches: [3],
    });
    expect(m!.rows[1]).toBeUndefined();
    expect(m!.rows.filter(Boolean).reduce((a, r) => a + r!.unitPrice * r!.quantity, 0)).toBeCloseTo(60, 8);
  });

  test("the cost lines say what the money is made of, by description", () => {
    // desc when the builder filled one in, the item code when it did not; routing lands under the
    // resource. unitCost = 10 material + 16 labor, so the lines must add up to 26 * 3.
    const withOps: ModelDef = {
      ...model,
      bom: [{ id: "sheet", itemCode: '"SHEET"', qty: "1", desc: "Steel sheet" }],
      routing: [{ id: "cut", resource: "Laser", setupMin: "30", runMinPerUnit: "6", ratePerHour: "60" }],
    };
    const m = itemMoney({
      model: withOps, lookups, items, tables, candidates,
      selection: [{ candidateIdx: 0, batchQty: 3 }], batches: [3],
    });
    expect(m!.lines).toEqual([
      { kind: "material", label: "Steel sheet", amount: 30 },
      { kind: "operation", label: "Laser", amount: 48 },
    ]);
    // same total the Items block splits over the grid
    expect(m!.lines.reduce((a, l) => a + l.amount, 0))
      .toBeCloseTo(m!.rows.reduce((a, r) => a + (r ? r.unitCost * r.quantity : 0), 0), 8);
  });

  test("an unnamed BOM line falls back to its item code, and repeats merge", () => {
    const m = call([{ candidateIdx: 0, batchQty: 3 }, { candidateIdx: 0, batchQty: 6 }]);
    expect(m!.lines).toEqual([{ kind: "material", label: "SHEET", amount: 90 }]); // 3 + 6 sheets
  });

  test("no candidates yet means no money at all, not a zero", () => {
    expect(itemMoney({ model, lookups, items, tables, candidates: [], selection: [], batches: [3] })).toBeNull();
  });
});
