import { expect, test } from "bun:test";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import { compileAggregate, compileLinesAggregate, flattenJoined } from "../src/entity-list.ts";

// SAP-side totals (reports spec §3.4): the `$apply` text b1.read and the report runner send. Pure.

const f = (name: string, kind: B1Field["kind"], extra: Partial<B1Field> = {}): B1Field => ({ name, kind, edmType: "", ...extra });
const ORDERS: B1EntitySchema = {
  name: "Orders", entityType: "Document", table: "ORDR", label: "Orders", entityClass: "standard", keys: ["DocEntry"],
  fields: [
    f("DocEntry", "number"), f("DocDate", "date"), f("CardCode", "string"), f("DocTotal", "number"), f("VatSum", "number"),
    f("DocumentStatus", "enum", { options: [{ value: "bost_Open", label: "bost_Open" }, { value: "bost_Close", label: "bost_Close" }] }),
    f("DocumentLines", "collection", { fields: [f("ItemCode", "string"), f("LineTotal", "number")] }),
  ],
};

test("groupby + aggregates after the filter", () => {
  const q = compileAggregate(ORDERS, [{ field: "DocumentStatus", op: "eq", value: "bost_Open" }],
    { groupBy: ["DocDate", "CardCode"], measures: [{ field: "DocTotal", agg: "sum", as: "a0" }, { agg: "count", as: "n" }] }, { pageSize: 500 });
  expect(q.apply).toBe("filter(DocumentStatus eq 'bost_Open')/groupby((DocDate,CardCode),aggregate(DocTotal with sum as a0,$count as n))");
  expect(q.maxPageSize).toBe(500);
});

test("no groupBy is one total; no filter has no filter step", () => {
  expect(compileAggregate(ORDERS, [], { groupBy: [], measures: [{ field: "DocTotal", agg: "avg", as: "a0" }] }, { pageSize: 500 }).apply)
    .toBe("aggregate(DocTotal with average as a0)");
});

test("an injected quote is escaped; an unknown field is refused", () => {
  expect(compileAggregate(ORDERS, [{ field: "CardCode", op: "eq", value: "O'Neil" }], { groupBy: [], measures: [{ agg: "count", as: "n" }] }, { pageSize: 500 }).apply)
    .toContain("CardCode eq 'O''Neil'");
  expect(() => compileAggregate(ORDERS, [], { groupBy: ["Nope"], measures: [{ agg: "count", as: "n" }] }, { pageSize: 500 })).toThrow("Nope");
});

test("a fence ANDed after compilation lands inside filter()", () => {
  expect(compileAggregate(ORDERS, [], { groupBy: [], measures: [{ agg: "count", as: "n" }] }, { pageSize: 500, extraFilter: "CardCode eq 'C1'" }).apply)
    .toBe("filter(CardCode eq 'C1')/aggregate($count as n)");
});

test("lines: the DocEntry join first, prefixed names, line measures on the lines path", () => {
  const s = compileLinesAggregate(ORDERS, "Orders", [{ field: "Lines.ItemCode", op: "eq", value: "A" }],
    { groupBy: ["DocDate", "Lines.ItemCode"], measures: [{ field: "Lines.LineTotal", agg: "sum", as: "a0" }] }, { pageSize: 500 });
  expect(s.entities).toEqual(["Orders", "Orders/DocumentLines"]);
  expect(s.apply).toBe("filter(Orders/DocEntry eq Orders/DocumentLines/DocEntry and (Orders/DocumentLines/ItemCode eq 'A'))/groupby((Orders/DocDate,Orders/DocumentLines/ItemCode),aggregate(Orders/DocumentLines(LineTotal with sum as a0)))");
  expect(s.maxPageSize).toBe(500);
});

test("flattenJoined reads both answer shapes", () => {
  expect(flattenJoined({ Orders: { DocDate: "2026-11-01" }, "Orders/DocumentLines": { ItemCode: "A" }, a0: 5 }, "Orders"))
    .toEqual({ DocDate: "2026-11-01", "Lines.ItemCode": "A", a0: 5 });
  expect(flattenJoined({ "Orders/DocDate": "2026-11-01", "Orders/DocumentLines/ItemCode": "A", a0: 5 }, "Orders"))
    .toEqual({ DocDate: "2026-11-01", "Lines.ItemCode": "A", a0: 5 });
});
