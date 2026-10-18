import { describe, expect, test } from "bun:test";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import { ALWAYS, isDenied, pickable, portalSchema, projectRow } from "../src/portal/doc-fields.ts";

// The portal's document field rule (spec §13.1, D19): what a client may see of a SAP document.
// Pure: no database, no agent.

const f = (name: string, kind: B1Field["kind"] = "string"): B1Field => ({ name, kind, edmType: "Edm.String" });

const orders: B1EntitySchema = {
  name: "Orders", label: "Sales orders", keys: ["DocEntry"],
  fields: [
    f("DocEntry", "number"), f("DocNum", "number"), f("DocDate", "date"), f("DocumentStatus", "enum"), f("DocTotal", "number"),
    f("DocCurrency"), f("DocDueDate", "date"), f("NumAtCard"), f("Comments"), f("CardCode"), f("GrossProfit", "number"),
    f("U_CF_Key"), f("U_Window"),
    {
      ...f("DocumentLines", "collection"),
      fields: ["LineNum", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal", "GrossBuyPrice", "StockPrice", "BaseType", "BaseEntry"].map((n) => f(n)),
    },
    { ...f("TaxExtension", "collection"), fields: [f("TaxId0")] },
  ],
};

const names = (s: B1EntitySchema) => s.fields.map((x) => x.name);
const lines = (s: B1EntitySchema) => s.fields.find((x) => x.name === "DocumentLines")?.fields?.map((x) => x.name);

describe("portalSchema", () => {
  test("no setting: ALWAYS, then the defaults, in order; lines from DOC_DEFAULTS", () => {
    const s = portalSchema(orders, undefined);
    // No Comments: B1's Remarks often hold internal notes, so an admin opts it in.
    expect(names(s)).toEqual(["DocEntry", "DocNum", "DocDate", "DocumentStatus", "DocTotal", "DocCurrency", "DocDueDate", "NumAtCard", "DocumentLines"]);
    expect(lines(s)).toEqual(["ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"]);
    expect(s.keys).toEqual(["DocEntry"]);
    expect(s.label).toBe("Sales orders");
  });

  test("setting order is kept; CardCode, denied, unknown and other collections are dropped on read", () => {
    const s = portalSchema(orders, {
      header: ["U_Window", "NumAtCard", "CardCode", "GrossProfit", "U_CF_Key", "Gone", "TaxExtension", "DocNum"],
      lines: ["LineTotal", "GrossBuyPrice", "StockPrice", "ItemCode"],
    });
    expect(names(s)).toEqual([...ALWAYS, "U_Window", "NumAtCard", "DocumentLines"]);
    expect(lines(s)).toEqual(["LineTotal", "ItemCode"]);
  });

  test("empty lists show ALWAYS only and no DocumentLines", () => {
    expect(names(portalSchema(orders, { header: [], lines: [] }))).toEqual(ALWAYS);
  });
});

describe("pickable", () => {
  test("offers what an admin may add, nothing ALWAYS/NEVER/denied/collection", () => {
    const p = pickable(orders);
    expect(p.header.map((x) => x.name)).toEqual(["DocDueDate", "NumAtCard", "Comments", "U_Window"]);
    expect(p.lines.map((x) => x.name)).toEqual(["LineNum", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal", "BaseType", "BaseEntry"]);
  });
});

describe("isDenied", () => {
  test("matches patterns case-insensitively", () => {
    for (const n of ["COGSCostingCode", "GrossProfitTotal", "grossbuyprice", "StockSumSC", "U_Margin", "u_cf_key"]) expect(isDenied(n)).toBe(true);
    for (const n of ["DocTotal", "Comments", "UnitPrice"]) expect(isDenied(n)).toBe(false);
  });

  test("blocks the cost, profit, purchase-price and commission fields a real B1 schema carries", () => {
    // Read off a live tenant's cached Quotations/Orders/Invoices schemas (entity_meta).
    for (const n of [
      "OperatingProfit", "OperatingProfitFC", "OperatingProfitSC", "ServiceGrossProfitPercent", "StockInmPrice", "LastBuyInmPrice",
      "LastBuyDistributeSum", "LastBuyDistributeSumFc", "StockDistributesum", "StockDistributesumForeign", "CommisionPercent", "CommissionTrade",
    ]) expect(isDenied(n)).toBe(true);
    // Customer-facing figures and references stay pickable.
    for (const n of ["Price", "PriceAfterVAT", "GrossPrice", "GrossTotal", "LineTotal", "VatSum", "ItemDescription", "PayToBankAccountNo", "U_SII_SINMUEBLE"])
      expect(isDenied(n)).toBe(false);
  });
});

describe("projectRow", () => {
  test("cuts a row and each line to the schema", () => {
    const s = portalSchema(orders, undefined);
    const out = projectRow(s, {
      DocEntry: 1, CardCode: "C1", GrossProfit: 9, "odata.etag": "x",
      DocumentLines: [{ ItemCode: "A", GrossBuyPrice: 5, LineTotal: 10 }],
    });
    expect(out).toEqual({ DocEntry: 1, DocumentLines: [{ ItemCode: "A", LineTotal: 10 }] });
    expect(projectRow(s, { DocEntry: 2 })).toEqual({ DocEntry: 2 });
  });
});
