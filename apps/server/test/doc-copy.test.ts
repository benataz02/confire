import { describe, expect, test } from "bun:test";
import { buildCopy, draftConstraints, findFlow } from "../src/doc-copy.ts";

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
