import { expect, test } from "bun:test";
import { docHistoryQuery, flattenDocs } from "../src/doc-history.ts";

// The item codes are a list now (the items grid's ITEM_COL column, n rows), not one parameter.
// These two cover what that changed: n OR clauses in the filter, and `matched` classifying a line
// against the whole set instead of a single code.

const pair = (cardCode: string, itemCode: string) => ({
  Orders: { DocEntry: 1, DocNum: 7, DocDate: "2026-01-02", DocCurrency: "EUR", CardCode: cardCode, CardName: "Acme" },
  "Orders/DocumentLines": { ItemCode: itemCode, ItemDescription: "x", Quantity: 2, UnitPrice: 3 },
});

test("every item code becomes its own OR clause, quoted", () => {
  const q = docHistoryQuery("Orders", { cardCode: "C1", itemCodes: ["A-1", "O'B"] });
  expect(q.filter).toBe(
    "Orders/DocEntry eq Orders/DocumentLines/DocEntry and " +
      "(Orders/CardCode eq 'C1' or Orders/DocumentLines/ItemCode eq 'A-1' or Orders/DocumentLines/ItemCode eq 'O''B')",
  );
  expect(() => docHistoryQuery("Orders", { itemCodes: [] })).toThrow();
});

test("matched is judged against the whole code set", () => {
  const opts = { cardCode: "C1", itemCodes: ["A", "B"] };
  const rows = flattenDocs("order", { value: [pair("C1", "B"), pair("C9", "A"), pair("C9", "Z")] }, opts);
  expect(rows.map((r) => r.matched)).toEqual(["both", "item"]); // the C9/Z line matched nothing
});
