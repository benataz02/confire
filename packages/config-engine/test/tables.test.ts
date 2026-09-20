import { describe, expect, test } from "bun:test";
import { checkModel } from "../src/check";
import type { ModelDef, TableDef } from "../src/model";
import { bindings } from "../src/propagate";
import { placedTables } from "../src/model";
import { evalTableRows, itemSplit, splitShares, splitWeights, tableAggregates } from "../src/tables";
import { fieldGroup, lookups, model as base } from "./fixture";

const known = [{ name: "items", columns: [] }, { name: "prices", columns: ["code", "price"] }];

/** n machined holes: an options column, then two formula columns chained in declaration order. */
const holes: TableDef = {
  role: "calc",
  key: "holes",
  title: "Machined holes",
  columns: [
    {
      key: "shape",
      label: "Shape",
      type: "string",
      cell: {
        kind: "options",
        ref: { source: "manual", options: [{ value: "circular" }, { value: "rectangular" }] },
      },
    },
    { key: "size", label: "Size", type: "number", unit: "mm", cell: { kind: "input" } },
    {
      key: "perimeter",
      label: "Perimeter",
      type: "number",
      unit: "mm",
      cell: { kind: "formula", expr: 'shape == "circular" ? 3.14159 * size : 4 * size' },
    },
    {
      key: "minutes",
      label: "Machining time",
      type: "number",
      unit: "min",
      cell: { kind: "formula", expr: "perimeter / 50" },
    },
  ],
};

/** Merge production: n items out of one configuration, each its own quotation line. */
const parts: TableDef = {
  role: "items",
  key: "parts",
  title: "Items",
  basisExpr: "area",
  map: { code: "U_CF_ItemCode", name: "ItemDescription" },
  columns: [
    { key: "code", label: "Item code", type: "string", cell: { kind: "input" } },
    { key: "name", label: "Description", type: "string", cell: { kind: "input" } },
    { key: "width", label: "Width", type: "number", unit: "mm", cell: { kind: "input" } },
    { key: "quantity", label: "Pieces", type: "number", cell: { kind: "input" } },
    // reads a model parameter as well as its own row
    { key: "area", label: "Area", type: "number", cell: { kind: "formula", expr: "width * section" } },
  ],
};

/** An options column over masterdata: the picked row's other columns come along as
 *  `<column>_<source column>`, exactly as a parameter's options domain does. */
const bought: TableDef = {
  role: "calc",
  key: "bought",
  title: "Bought-in parts",
  columns: [
    {
      key: "item",
      label: "Item",
      type: "string",
      cell: { kind: "options", ref: { source: "table", table: "prices", valueCol: "code" } },
    },
    { key: "pieces", label: "Pieces", type: "number", cell: { kind: "input" } },
    { key: "cost", label: "Cost", type: "number", cell: { kind: "formula", expr: "item_price * pieces" } },
  ],
};

const model: ModelDef = {
  ...base,
  tables: [holes, parts],
  structure: {
    sections: [{
      ...base.structure.sections[0]!,
      groups: [...base.structure.sections[0]!.groups, { table: "holes" }],
    }],
  },
};

const entries = { material: "steel", section: 10, coated: false };
const rows = {
  holes: [
    { shape: "circular", size: 10 },
    { shape: "rectangular", size: 20 },
  ],
};

describe("evalTableRows", () => {
  test("formula columns chain in declaration order", () => {
    const out = evalTableRows(holes, rows.holes, {}, lookups.tables);
    expect(out[0]!.perimeter).toBeCloseTo(31.4159, 6);
    expect(out[0]!.minutes).toBeCloseTo(0.628318, 6);
    expect(out[1]!.perimeter).toBe(80);
    expect(out[1]!.minutes).toBe(1.6);
  });

  test("a row formula reads model values, and row cells shadow them", () => {
    const out = evalTableRows(parts, [{ width: 3, quantity: 1 }], { section: 10 }, lookups.tables);
    expect(out[0]!.area).toBe(30);

    // a column named after a parameter: the row's own `section` wins over the model's 10
    const shadowing: TableDef = {
      role: "calc",
      key: "cuts",
      title: "Cuts",
      columns: [
        { key: "section", label: "Section", type: "number", cell: { kind: "input" } },
        { key: "twice", label: "Twice", type: "number", cell: { kind: "formula", expr: "section * 2" } },
      ],
    };
    expect(evalTableRows(shadowing, [{ section: 3 }], { section: 10 }, lookups.tables)[0]!.twice).toBe(6);
    // a declared column shadows even while empty — the cell reads as zero, not as the model's 10
    expect(evalTableRows(shadowing, [{}], { section: 10 }, lookups.tables)[0]!.twice).toBe(0);
  });

  test("an options cell derives its source row's other columns into the row scope", () => {
    const out = evalTableRows(bought, [{ item: "COND-alu", pieces: 2 }], {}, lookups.tables);
    expect(out[0]!.item_price).toBe(2.5);
    expect(out[0]!.cost).toBe(5);
    // the derived key is the row's, not the model's: nothing leaks out of the table
    expect(bindings(base, lookups, entries).values).not.toHaveProperty("item_price");
  });

  test("a value with no source row leaves the derived key absent, like an unbound parameter", () => {
    // an off-page query pick before enrichLookups re-appends it, or a stale code
    const out = evalTableRows(bought, [{ item: "COND-gone", pieces: 2 }], {}, lookups.tables);
    expect(out[0]!).not.toHaveProperty("item_price");
    expect(out[0]!.cost).toBeNull();
  });

  test("a stored cell on a computed column overrides the formula, and null hands it back", () => {
    // the salesperson typed 40 over a perimeter of 31.4159 — and the columns downstream follow it
    const out = evalTableRows(holes, [{ shape: "circular", size: 10, perimeter: 40 }], {}, lookups.tables);
    expect(out[0]!.perimeter).toBe(40);
    expect(out[0]!.minutes).toBe(0.8);
    // cleared: back to the formula, so an override cannot be sticky-by-accident
    const back = evalTableRows(holes, [{ shape: "circular", size: 10, perimeter: null }], {}, lookups.tables);
    expect(back[0]!.perimeter).toBeCloseTo(31.4159, 6);
  });

  test("a missing cell reads as the type's zero rather than blanking the row", () => {
    const out = evalTableRows(holes, [{ shape: "rectangular" }], {}, lookups.tables);
    expect(out[0]!.size).toBe(0);
    expect(out[0]!.perimeter).toBe(0);
  });
});

describe("tableAggregates", () => {
  test("sums numeric and numeric-formula columns, and counts rows", () => {
    const agg = tableAggregates(model, rows, { section: 10 }, lookups);
    expect(agg.holes_count).toBe(2);
    expect(agg.holes_size).toBe(30);
    expect(agg.holes_perimeter).toBeCloseTo(111.4159, 6);
    expect(agg.holes_minutes).toBeCloseTo(2.228318, 6);
    expect(agg.parts_count).toBe(0);
    expect(agg.parts_area).toBe(0);
    // string columns contribute nothing
    expect(agg).not.toHaveProperty("holes_shape");
  });

  test("aggregates land in the binding scope, so model formulas can read them", () => {
    const withTable: ModelDef = {
      ...model,
      computed: [...model.computed, { key: "drillMin", expr: "holes_minutes * 2" }],
    };
    const b = bindings(withTable, lookups, entries, rows);
    expect(b.values.holes_count).toBe(2);
    expect(b.values.drillMin as number).toBeCloseTo(4.456636, 6);
  });

  test("a model with no tables is untouched", () => {
    const b = bindings(base, lookups, entries);
    expect(Object.keys(b.values).some((k) => k.startsWith("holes_"))).toBe(false);
  });
});

describe("splitShares", () => {
  // the reconciliation guard: the quotation's line sum has to equal the stored quotedValue
  const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

  test("a total that does not divide evenly still sums to the total", () => {
    const shares = splitShares([1, 1, 1], 100);
    expect(sum(shares)).toBe(100);
    expect(shares).toEqual([33.34, 33.33, 33.33]);
  });

  test("weights by basis x qty", () => {
    expect(splitShares([2, 1], 10)).toEqual([6.67, 3.33]);
    expect(sum(splitShares([2, 1], 10))).toBe(10);
  });

  test("zero weights degenerate to an equal split, not a division by zero", () => {
    expect(splitShares([0, 0], 9)).toEqual([4.5, 4.5]);
  });

  test("no rows, no shares", () => {
    expect(splitShares([], 10)).toEqual([]);
  });
});

describe("splitWeights", () => {
  test("basis is evaluated per row, then weighted by that row's quantity", () => {
    // rows arrive already evaluated, so the computed `area` column is there for basisExpr to read
    const rows = [{ area: 20, quantity: 3 }, { area: 50, quantity: 1 }];
    expect(splitWeights(parts, rows, {})).toEqual([60, 50]);
  });

  test("an undecidable basis weighs nothing rather than throwing", () => {
    expect(splitWeights({ ...parts, basisExpr: "nope" }, [{ area: 2, quantity: 3 }], {})).toEqual([0]);
  });
});

describe("itemSplit", () => {
  // width * section, with section = 2 from the fixture scope -> areas 20 and 50, weights 60 and 50.
  const rows = [
    { code: "A", name: "Bracket", width: 10, quantity: 3 },
    { code: "B", name: "Plate", width: 25, quantity: 1 },
  ];
  const scope = { section: 2 };

  test("cost and price divide on the same weights, and the shares add up exactly", () => {
    const out = itemSplit(parts, rows, scope, undefined, 10, { cost: 600, price: 1100 });
    expect(out.map((l) => l.cost)).toEqual([327.27, 272.73]);
    expect(out.reduce((n, l) => n + l.cost, 0)).toBeCloseTo(600, 10);
    expect(out.reduce((n, l) => n + l.price, 0)).toBeCloseTo(1100, 10);
    // one basis, so the two splits hold the same proportions — to the cent splitShares rounds to
    expect(out[0]!.cost / 600).toBeCloseTo(out[0]!.price / 1100, 4);
  });

  test("quantity is the row's pieces times the batch", () => {
    const out = itemSplit(parts, rows, scope, undefined, 10, { cost: 600, price: 1100 });
    expect(out.map((l) => l.quantity)).toEqual([30, 10]);
  });

  test("a row that ships nothing gets no share, and index still points at the grid", () => {
    const withBlank = [rows[0]!, { code: "C", name: "Offcut", width: 5, quantity: 0 }, rows[1]!];
    const out = itemSplit(parts, withBlank, scope, undefined, 1, { cost: 600, price: 1100 });
    expect(out.map((l) => l.index)).toEqual([0, 2]);
    expect(out.reduce((n, l) => n + l.cost, 0)).toBeCloseTo(600, 10);
  });

  test("raw keeps the stored row, so a hand-typed price survives evaluation", () => {
    const priced = [{ ...rows[0]!, unitprice: 42 }, rows[1]!];
    const out = itemSplit(parts, priced, scope, undefined, 1, { cost: 600, price: 1100 });
    expect(out[0]!.raw.unitprice).toBe(42);
    // ...and never reaches the evaluated row, so it cannot feed basisExpr or the aggregates
    expect(out[0]!.row.unitprice).toBeUndefined();
  });
});

describe("checkModel", () => {
  const msgs = (m: ModelDef) => checkModel(m, known).map((i) => i.message);

  test("the fixture with tables is clean", () => {
    expect(checkModel(model, known)).toEqual([]);
  });

  test("a cell formula and a cost basis may read a derived source column", () => {
    const m: ModelDef = { ...model, tables: [...model.tables!, bought] };
    expect(checkModel(m, known)).toEqual([]);

    const typo: ModelDef = {
      ...model,
      tables: [...model.tables!, {
        ...bought,
        columns: [bought.columns[0]!, bought.columns[1]!,
          { ...bought.columns[2]!, cell: { kind: "formula", expr: "item_prive * pieces" } }],
      }],
    };
    expect(msgs(typo)).toContain("unknown identifier 'item_prive'");
  });

  test("a table key colliding with a parameter", () => {
    const m: ModelDef = { ...model, tables: [{ ...holes, key: "material" }], structure: base.structure };
    expect(msgs(m)).toContain("table key 'material' collides with an existing key");
  });

  test("an aggregate colliding with a computed value", () => {
    const m: ModelDef = { ...model, computed: [...model.computed, { key: "holes_size", expr: "1" }] };
    expect(msgs(m)).toContain("aggregate 'holes_size' collides with an existing key");
  });

  test("a cell formula referencing a later column of its own table", () => {
    const m: ModelDef = {
      ...model,
      tables: [
        {
          ...holes,
          columns: [
            { key: "early", label: "Early", type: "number", cell: { kind: "formula", expr: "late + 1" } },
            { key: "late", label: "Late", type: "number", cell: { kind: "input" } },
          ],
        },
      ],
      structure: base.structure,
    };
    expect(msgs(m)).toContain("unknown identifier 'late'");
  });

  test("a map target the price split owns", () => {
    const m: ModelDef = { ...model, tables: [holes, { ...parts, map: { code: "ItemCode" } }] };
    expect(msgs(m)).toContain("'ItemCode' is set by the price split and cannot be mapped");
  });

  test("a basis expression referencing a column the table does not have", () => {
    const m: ModelDef = { ...model, tables: [holes, { ...parts, basisExpr: "width * depth" }] };
    expect(msgs(m)).toContain("unknown identifier 'depth'");
  });

  test("an items table without a number 'quantity' column", () => {
    const m: ModelDef = { ...model, tables: [holes, { ...parts, basisExpr: "1", columns: parts.columns.slice(0, 3) }] };
    expect(msgs(m)).toContain("an items table needs a number column 'quantity'");
  });

  test("two items tables", () => {
    const m: ModelDef = { ...model, tables: [parts, { ...parts, key: "more" }] };
    expect(msgs(m)).toContain("at most one items table per model");
  });

  test("a group placing a key that is neither parameter nor table", () => {
    const m: ModelDef = {
      ...model,
      structure: {
        sections: [{
          ...base.structure.sections[0]!,
          groups: [{ ...fieldGroup(base), params: ["nope"] }],
        }],
      },
    };
    expect(msgs(m)).toContain("structure references unknown parameter 'nope'");
  });

  test("a table group naming no TableDef", () => {
    const m: ModelDef = {
      ...model,
      structure: { sections: [{ ...base.structure.sections[0]!, groups: [{ table: "ghost" }] }] },
    };
    expect(msgs(m)).toContain("structure references unknown table 'ghost'");
  });

  test("the same table placed as two groups", () => {
    const m: ModelDef = {
      ...model,
      structure: {
        sections: [{ ...base.structure.sections[0]!, groups: [{ table: "holes" }, { table: "holes" }] }],
      },
    };
    expect(msgs(m)).toContain("table 'holes' is placed more than once");
  });

  // A model saved before tables became groups. It still parses (the field arm is unchanged), but
  // placedTables() no longer sees the table, so the form would drop it into the catch-all section.
  test("a legacy table key still sitting in a group's params", () => {
    const m: ModelDef = {
      ...model,
      structure: {
        sections: [{
          ...base.structure.sections[0]!,
          groups: [{ ...fieldGroup(base), params: [...fieldGroup(base).params, "holes"] }],
        }],
      },
    };
    expect(msgs(m)).toContain("table 'holes' sits in group 'conductor' — place it as a group of its own");
    expect(placedTables(m)).not.toContain("holes");
  });
});
