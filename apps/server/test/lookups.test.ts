import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@confire/config-engine";
import {
  bindEntryValues, queryPageSource, resolveLookups,
  type MasterdataRow, type RowCache,
} from "../src/lookups.ts";

// Masterdata is tenant-wide: these cover the filter that keeps a model from loading tables it
// never names, and the two things the cache made possible — prices out of a nested B1 collection,
// and a stored off-page pick that reaches the domain instead of only the table.

const model: ModelDef = {
  name: "m",
  parameters: [{
    key: "grade", label: "Grade", type: "string", ui: "select",
    domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode" } },
  }],
  structure: { sections: [{ key: "s", title: "S", groups: [{ key: "g", title: "G", params: ["grade"] }] }] },
  computed: [],
  constraints: [],
  bom: [{ id: "b", itemCode: "grade", qty: "1" }],
  routing: [],
  pricing: { priceExpr: "unitCost", quoteItemCode: "X", priceList: 2, itemTable: "catalog" },
  batchDefaults: [1],
};

const md = (id: string, name: string, extra: Partial<MasterdataRow> = {}): MasterdataRow => ({
  id, name, kind: "query", columns: [], rows: [],
  query: { target: "b1", query: { entitySet: "Items" }, columns: [] },
  ...extra,
});

const rows: MasterdataRow[] = [
  { id: "p", name: "prices", kind: "table", columns: [{ key: "code" }, { key: "price" }], rows: [["A", 2]] },
  md("i", "items", { query: { target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"], labels: { ItemCode: "Item" } } }),
  md("c", "catalog"),
  md("u", "unused", { query: { target: "b1", query: { entitySet: "Orders" }, columns: ["DocNum"] } }),
];

/** A cache over literal rows, honouring the `col`/`values` filter the binder and prices use. */
const cacheOf = (byId: Record<string, Record<string, unknown>[]>, log?: string[]): RowCache =>
  async (id, q) => {
    log?.push(id);
    const all = byId[id] ?? [];
    return q?.col && q.values
      ? all.filter((r) => q.values!.some((v) => String(v) === String(r[q.col!])))
      : all;
  };

const CATALOG = [
  // two lists on the same item: only the model's price list (2) may be picked
  { ItemCode: "A", ItemPrices: [{ PriceList: 1, Price: 99 }, { PriceList: 2, Price: 7 }] },
  // priced on another list only — B1 returned the item, but not for this list
  { ItemCode: "B", ItemPrices: [{ PriceList: 1, Price: 50 }] },
];

describe("resolveLookups over cached masterdata", () => {
  test("loads only the tables the model names, and carries their display metadata", async () => {
    const read: string[] = [];
    const lookups = await resolveLookups(model, rows, cacheOf({ i: [{ ItemCode: "A" }], c: CATALOG }, read));
    expect(read.sort()).toEqual(["c", "i"]); // "unused" and the manual "prices" are never read
    expect(lookups.tables.prices!.rows).toEqual([["A", 2]]);
    expect(lookups.tables.items!.labels).toEqual({ ItemCode: "Item" });
    expect(lookups.domains.grade).toEqual([{ value: "A", label: "A" }]);
  });

  test("prices come out of the nested ItemPrices collection, for this model's list only", async () => {
    const both = { ...model, parameters: [], bom: [{ id: "b", itemCode: '"A"', qty: "1" }] };
    const lookups = await resolveLookups(both, rows, cacheOf({ c: CATALOG }));
    expect(lookups.prices).toEqual({ A: 7 });
  });

  test("an item with no line for the price list is absent, not zero", async () => {
    // Absent is what makes computeOutputs refuse the BOM line by name; a 0 would quietly ship a
    // free material into a quotation.
    const onlyB = { ...model, parameters: [], bom: [{ id: "b", itemCode: '"B"', qty: "1" }] };
    const lookups = await resolveLookups(onlyB, rows, cacheOf({ c: CATALOG }));
    expect(lookups.prices).toEqual({});
    expect("B" in (lookups.prices ?? {})).toBe(false);
  });

  test("a table that has never synced resolves empty instead of failing", async () => {
    const lookups = await resolveLookups(model, rows, cacheOf({}));
    expect(lookups.tables.items!.rows).toEqual([]);
    expect(lookups.domains.grade).toEqual([]);
    // The manual table is untouched by SAP being unreachable — that is the whole point.
    expect(lookups.tables.prices!.rows).toEqual([["A", 2]]);
  });
});

describe("bindEntryValues", () => {
  const cache = cacheOf({ i: [{ ItemCode: "A" }], c: CATALOG });
  // "B" exists in the item table but not on the canonical page the resolve loaded.
  const withB = cacheOf({ i: [{ ItemCode: "A" }, { ItemCode: "B" }], c: CATALOG });

  test("a stored off-page pick reaches the domain, not just the table", async () => {
    const canonical = await resolveLookups(model, rows, cache);
    expect(canonical.domains.grade!.map((o) => o.value)).toEqual(["A"]);

    const bound = await bindEntryValues(model, rows, canonical, withB, { grade: "B" });
    expect(bound.tables.items!.rows).toEqual([["A"], ["B"]]);
    expect(bound.domains.grade!.map((o) => o.value)).toEqual(["A", "B"]);
    // ...and the newly reachable code is priced, because the BOM's itemCode is that parameter.
    expect(bound.prices).toEqual({ A: 7 });
  });

  test("nothing missing returns the same object, so callers can compare by identity", async () => {
    const canonical = await resolveLookups(model, rows, cache);
    expect(await bindEntryValues(model, rows, canonical, cache, { grade: "A" })).toBe(canonical);
    expect(await bindEntryValues(model, rows, canonical, cache, {})).toBe(canonical);
  });
});

describe("queryPageSource", () => {
  test("resolves the named row and refuses anything else", () => {
    const src = queryPageSource(rows, { table: "items" });
    expect(src.row.id).toBe("i");
    expect(src.q.skip).toBe(0);
    expect(() => queryPageSource(rows, { table: "prices" })).toThrow("Unknown query table 'prices'");
    expect(() => queryPageSource(rows, { table: "items", searchCols: ["Nope"] })).toThrow();
    expect(() => queryPageSource(rows, { table: "items", cursor: -1 })).toThrow();
  });

  test("a table that declares no columns accepts any search column", () => {
    // An `Items` read sends no $select on purpose, so its fields are whatever B1 returned and
    // there is no declared list to check a search column against.
    expect(() => queryPageSource(rows, { table: "catalog", searchCols: ["ItemName"] })).not.toThrow();
  });
});
