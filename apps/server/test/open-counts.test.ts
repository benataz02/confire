import { expect, test } from "bun:test";
import { countsOf, OPEN_COUNTS_CODE, OPEN_COUNTS_SQL } from "../src/open-counts.ts";

test("rows by ObjType become counts by entity set; a set with no row is 0", () => {
  // HANA may upper-case the columns; the count may come back as a string.
  expect(countsOf([{ ObjType: "23", Cnt: 4 }, { OBJTYPE: "13", CNT: "7" }]))
    .toEqual({ Quotations: 4, Orders: 0, DeliveryNotes: 0, Invoices: 7 });
});

test("the query is one SELECT per table, no select *, and its code fits SAP's", () => {
  expect(OPEN_COUNTS_SQL.split(" UNION ")).toHaveLength(4);
  expect(OPEN_COUNTS_SQL).not.toContain("*");
  expect(OPEN_COUNTS_CODE).toMatch(/^CF_OC_[0-9a-f]{8}$/);
});
