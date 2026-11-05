import { describe, expect, test } from "bun:test";
import { buildCopy, draftConstraints, duplicateItem, findFlow, onItems, partLines, swapLine } from "../src/doc-copy.ts";

// Document copy, one source or several merged into one target. Pure: no database, no agent.

const flow = findFlow("Orders", "DeliveryNotes")!;
const order = (DocEntry: number, CardCode: string, lineNums: number[]) => ({
  DocEntry, DocNum: DocEntry + 1000, CardCode, CardName: `${CardCode} Ltd`, DocDate: `2026-10-0${DocEntry}`,
  DocumentLines: lineNums.map((LineNum) => ({ LineNum, ItemCode: `I${LineNum}`, Quantity: 1, LineTotal: 9 })),
});

describe("buildCopy", () => {
  test("merges the lines of every source, each linked to its own base", () => {
    const doc = buildCopy(flow, [order(1, "C1", [0, 2]), order(2, "C1", [5])]);
    expect(doc.CardCode).toBe("C1");
    expect(doc.DocDate).toBe("2026-10-01");
    expect(doc.Comments).toBe("Created from Orders 1001, 1002 in Confire");
    expect(doc.DocumentLines).toEqual([
      { BaseType: 17, BaseEntry: 1, BaseLine: 0, ItemCode: "I0", Quantity: 1 },
      { BaseType: 17, BaseEntry: 1, BaseLine: 2, ItemCode: "I2", Quantity: 1 },
      { BaseType: 17, BaseEntry: 2, BaseLine: 5, ItemCode: "I5", Quantity: 1 },
    ]);
  });

  test("refuses sources of different business partners", () => {
    expect(() => buildCopy(flow, [order(1, "C1", [0]), order(2, "C2", [0])])).toThrow(/different business partners/);
  });

  test("refuses a source without lines", () => {
    expect(() => buildCopy(flow, [order(1, "C1", [0]), order(2, "C1", [])])).toThrow("Orders 1002 has no lines");
  });

  test("the draft's changes: allowlisted header fields, kept lines with their quantities", () => {
    const doc = buildCopy(flow, [order(1, "C1", [0, 2]), order(2, "C1", [5])], {
      header: { NumAtCard: "PO-7", Comments: "partial" },
      lines: [{ baseEntry: 2, baseLine: 5, quantity: 0.5 }],
    });
    expect(doc).toMatchObject({ CardName: "C1 Ltd", NumAtCard: "PO-7", Comments: "partial" });
    expect(doc.DocumentLines).toEqual([{ BaseType: 17, BaseEntry: 2, BaseLine: 5, ItemCode: "I5", Quantity: 0.5 }]);
    expect(() => buildCopy(flow, [order(1, "C1", [0])], { lines: [{ baseEntry: 1, baseLine: 9, quantity: 1 }] }))
      .toThrow("not on a source document");
    // A field outside the allowlist never reaches B1, whatever the caller sends.
    expect(() => buildCopy(flow, [order(1, "C1", [0])], { header: { CardCode: "C2" } as never })).toThrow();
  });
});

test("draftConstraints opens the allowlist only", () => {
  const ro = { Type: "string" as const, EdmType: "Edm.String" };
  const c = draftConstraints({
    name: "DeliveryNotes", label: "Deliveries", keys: ["DocEntry"], writable: false,
    fields: { CardCode: ro, NumAtCard: ro, DocumentLines: { ...ro, Type: "collection", Fields: { Quantity: ro, ItemCode: ro } } },
  });
  expect(c.fields.CardCode?.Editable).toBeUndefined();
  expect(c.fields.NumAtCard?.Editable).toBe(true);
  expect(c.fields.DocumentLines).toMatchObject({ Editable: true, Required: true });
  expect(c.fields.DocumentLines?.Fields?.Quantity?.Editable).toBe(true);
  expect(c.fields.DocumentLines?.Fields?.ItemCode?.Editable).toBeUndefined();
});

describe("configured parts", () => {
  const quote = {
    DocEntry: 7, CardCode: "C1", DocumentLines: [
      { LineNum: 0, ItemCode: "GEN", ItemDescription: "Bracket 40", Quantity: 3, UnitPrice: 12, LineTotal: 36, U_CF_ItemCode: " PART-A " },
      { LineNum: 1, ItemCode: "A", Quantity: 1, U_CF_ItemCode: null },
      { LineNum: 2, ItemCode: "part-b", U_CF_ItemCode: "PART-B" }, // already its item, case-blind
      { LineNum: 3, ItemCode: "GEN", U_CF_ItemCode: "PART-C", LineStatus: "bost_Close" },
      { LineNum: 5, ItemCode: "GEN", U_CF_ItemCode: "PART-D" },
    ],
  };

  test("a part is an open line on a generic item with its code in the UDF; the kept lines only", () => {
    expect(partLines([quote])).toEqual([
      { docEntry: 7, lineNum: 0, code: "PART-A", generic: "GEN", name: "Bracket 40" },
      { docEntry: 7, lineNum: 5, code: "PART-D", generic: "GEN", name: "PART-D" },
    ]);
    expect(partLines([quote], [{ baseEntry: 7, baseLine: 5, quantity: 1 }]).map((p) => p.code)).toEqual(["PART-D"]);
  });

  test("the order is built from the lines on their items, still linked to the quotation", () => {
    const [p] = partLines([quote]);
    const doc = buildCopy(findFlow("Quotations", "Orders")!, onItems([quote], [{ ...p!, item: "PART-A" }]));
    expect((doc.DocumentLines as Record<string, unknown>[])[0]).toMatchObject({ BaseType: 23, BaseEntry: 7, BaseLine: 0, ItemCode: "PART-A", U_CF_ItemCode: " PART-A " });
  });

  test("a duplicate keeps everything but the code, the name and what is B1's own", () => {
    const generic = {
      "@odata.etag": 'W/"1"', ItemCode: "GEN", ItemName: "Generic", ItemsGroupCode: 108, Series: 3, QuantityOnStock: 4,
      CreateDate: "2018-10-15", BarCode: "123", ItemBarCodeCollection: [], U_Cliente: "X", Picture: null,
      ItemPrices: [{ PriceList: 1, Price: 1.37 }],
      ItemWarehouseInfoCollection: [{ WarehouseCode: "01", InStock: 4, Committed: 1, MinimalStock: 2, UserSignature: 1 }],
    };
    expect(duplicateItem(generic, "PART-A", "Bracket 40")).toEqual({
      ItemCode: "PART-A", ItemName: "Bracket 40", ItemsGroupCode: 108, U_Cliente: "X",
      ItemPrices: [{ PriceList: 1, Price: 1.37 }], ItemWarehouseInfoCollection: [{ WarehouseCode: "01", MinimalStock: 2 }],
    });
  });

  test("a swapped line carries its own figures back, nothing computed", () => {
    expect(swapLine(quote.DocumentLines[0]!, "PART-A")).toEqual({
      LineNum: 0, ItemCode: "PART-A", Quantity: 3, UnitPrice: 12, ItemDescription: "Bracket 40",
    });
  });
});
