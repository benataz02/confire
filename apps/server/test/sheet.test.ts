import { expect, test } from "bun:test";
import { CFB, utils, write } from "xlsx";
import { isSheet, sheetText } from "../src/assistant/sheet.ts";

// Spreadsheets the assistant reads (sheet.ts): values and formulas as text, the first rows only, and
// only a file that really is a workbook.

const book = (rows: unknown[][], type: "xlsx" | "biff8" | "ods" = "xlsx") => {
  const wb = utils.book_new();
  const ws = utils.aoa_to_sheet(rows);
  ws["B4"] = { t: "n", v: 350, f: "SUM(B2:B3)" };
  ws["!ref"] = utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 3), c: 1 } });
  utils.book_append_sheet(wb, ws, "Sales 2025");
  return Buffer.from(write(wb, { type: "buffer", bookType: type }) as Buffer);
};

test("a workbook's values and formulas, per sheet, in xlsx, xls and ods", () => {
  for (const type of ["xlsx", "biff8", "ods"] as const) {
    const b = book([["Customer", "Net"], ["ACME", 100], ["Globex", 250]], type);
    expect(isSheet(b, "report.bin")).toBe(true);
    const text = sheetText("Q1 report.xlsx", b)!;
    expect(text).toStartWith('<file name="Q1 report.xlsx">');
    expect(text).toContain("## Sheet Sales 2025");
    expect(text).toContain("ACME,100");
    // SheetJS's own .xls writer leaves formulas out (its reader takes them), so the fixture has none
    if (type !== "biff8") expect(text).toContain("B4 = SUM(B2:B3)");
  }
});

test("only the first 200 rows of a sheet, and it says so", () => {
  const rows = [["n"], ...Array.from({ length: 500 }, (_, i) => [i])];
  const text = sheetText("big.xlsx", book(rows))!;
  expect(text).toContain("\n198,\n");
  expect(text).not.toContain("\n300,");
  expect(text).toContain("only the first 200 rows");
});

test("a CSV by its name and its text; anything else is no sheet", () => {
  const csv = Buffer.from("a,b\n1,2\n");
  expect(sheetText("data.csv", csv)).toContain("1,2");
  expect(isSheet(csv, "data.txt")).toBe(false);
  expect(isSheet(Buffer.from([0x61, 0x00, 0x62]), "nul.csv")).toBe(false);
  expect(isSheet(Buffer.from("%PDF-1.7"), "x.pdf")).toBe(false);
  // a zip that is no workbook (a Word file's shape): refused
  const notBook = Buffer.from(utils.book_new() && "PK\u0003\u0004 garbage", "latin1");
  expect(isSheet(notBook, "letter.docx")).toBe(false);
});

test("an xlsx's pivot tables by their definition: rows, columns, values, filters, source", () => {
  const zip = CFB.read(book([["Customer", "Net"], ["ACME", 100]]), { type: "buffer" });
  const add = (path: string, body: string) => CFB.utils.cfb_add(zip, path, Buffer.from(body));
  const rel = (target: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="x" Target="${target}"/></Relationships>`;
  add("xl/worksheets/_rels/sheet1.xml.rels", rel("../pivotTables/pivotTable1.xml"));
  add("xl/pivotTables/_rels/pivotTable1.xml.rels", rel("../pivotCache/pivotCacheDefinition1.xml"));
  add("xl/pivotTables/pivotTable1.xml", `<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="Sales by customer" cacheId="1">
    <location ref="D3:F9"/><rowFields count="1"><field x="0"/></rowFields><colFields count="1"><field x="-2"/></colFields>
    <pageFields count="1"><pageField fld="2" hier="-1"/></pageFields>
    <dataFields count="2"><dataField name="Sum of Net" fld="1" baseField="0" baseItem="0"/><dataField name="Orders" fld="1" subtotal="count"/></dataFields>
  </pivotTableDefinition>`);
  add("xl/pivotCache/pivotCacheDefinition1.xml", `<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
    <cacheSource type="worksheet"><worksheetSource ref="A1:C500" sheet="Data"/></cacheSource>
    <cacheFields count="4"><cacheField name="Customer"/><cacheField name="Net"/><cacheField name="Year"/><cacheField name="Margin" formula="Net*0.2"/></cacheFields>
  </pivotCacheDefinition>`);
  const text = sheetText("pivot.xlsx", Buffer.from(CFB.write(zip, { type: "buffer", fileType: "zip" }) as Buffer))!;
  expect(text).toContain(`- "Sales by customer" on sheet Sales 2025 at D3:F9, from Data!A1:C500`);
  expect(text).toContain("rows: Customer; columns: (the values); filters: Year");
  expect(text).toContain("values: Sum of Net (sum of Net); Orders (count of Net)");
  expect(text).toContain("calculated field Margin = Net*0.2");
});
