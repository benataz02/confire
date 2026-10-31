import { expect, test } from "bun:test";
import { filterHints, selectHints, sortHints, type FieldInfo } from "./queryHints.ts";

const fields: FieldInfo[] = [
  { name: "ItemCode", kind: "string" },
  { name: "ItemName", kind: "string" },
  { name: "SalesItem", kind: "boolean", values: ["'tYES'", "'tNO'"] },
  { name: "ItemsGroupCode", kind: "number" },
];
const texts = (h: { text: string }[]) => h.map((x) => x.text);

test("a filter walks field → operator → value → and/or, each per source", () => {
  expect(texts(filterHints("Sal", fields, "b1"))).toEqual(["SalesItem"]);
  expect(texts(filterHints("SalesItem e", fields, "b1"))).toEqual(["SalesItem eq"]);
  expect(texts(filterHints("SalesItem eq '", fields, "b1"))).toEqual(["SalesItem eq 'tYES'", "SalesItem eq 'tNO'"]);
  expect(texts(filterHints("SalesItem eq 'tYES' a", fields, "b1"))).toEqual(["SalesItem eq 'tYES' and"]);
  expect(texts(filterHints("SalesItem eq 'tYES' and Code", fields, "b1"))).toEqual([
    "SalesItem eq 'tYES' and ItemCode", "SalesItem eq 'tYES' and ItemsGroupCode",
  ]);
  // B1 has OData's functions, Beas infix operators instead.
  expect(texts(filterHints("star", fields, "b1"))).toEqual(["startswith("]);
  expect(texts(filterHints("startswith(Item", fields, "b1"))).toContain("startswith(ItemCode");
  expect(texts(filterHints("star", fields, "beas"))).toEqual([]);
  expect(texts(filterHints("ItemCode s", fields, "beas"))).toEqual(["ItemCode startwith"]);
  // Inside a string, nothing.
  expect(filterHints("ItemName eq 'Tipo a", fields, "beas")).toEqual([]);
  expect(filterHints('OpGroup eq "Tipo a', fields, "beas")).toEqual([]);
});

test("select skips listed fields; sort offers a direction after a field", () => {
  expect(texts(selectHints("ItemCode, Item", fields))).toEqual(["ItemCode, ItemName", "ItemCode, ItemsGroupCode", "ItemCode, SalesItem"]);
  expect(texts(sortHints("ItemName ", fields))).toEqual(["ItemName asc", "ItemName desc"]);
  expect(texts(sortHints("ItemName desc, Sal", fields))).toEqual(["ItemName desc, SalesItem"]);
});

