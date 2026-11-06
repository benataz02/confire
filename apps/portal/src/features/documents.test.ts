import { expect, test } from "bun:test";
import type { EntityConstraints } from "@confire/ui/metadata.ts";
import { docFeature } from "./documents.ts";

// The portal's document pages are built from the field list the server sends (spec §13.1): the
// admin's order decides the columns and the form.

const c = {
  name: "Orders", label: "Orders", keys: ["DocEntry"], writable: false, printable: true, flows: [],
  fields: {
    DocEntry: { Type: "number", EdmType: "Edm.Int32" },
    DocNum: { Type: "number", EdmType: "Edm.Int32" },
    DocDate: { Type: "date", EdmType: "Edm.DateTime" },
    NumAtCard: { Type: "string", EdmType: "Edm.String" },
    DocumentLines: {
      Type: "collection", EdmType: "Collection(SAPB1.DocumentLine)",
      Fields: { ItemCode: { Type: "string", EdmType: "Edm.String" }, LineTotal: { Type: "number", EdmType: "Edm.Double" } },
    },
  },
} as unknown as EntityConstraints;

const t = (key: string) => (key === "PORTAL_DOC_ORDERS" ? "Sales orders" : key);

test("columns and form follow the server's field order; lines are the table", () => {
  const f = docFeature("Orders", c, t);
  expect(f.list.columns.map((x) => x.key)).toEqual(["DocNum", "DocDate", "NumAtCard"]);
  expect(f.detail.sections[0]!.groups![0]!.fields.map((x) => x.key)).toEqual(["DocNum", "DocDate", "NumAtCard"]);
  expect(f.detail.sections[1]!.table!.columns.map((x) => x.key)).toEqual(["ItemCode", "LineTotal"]);
  expect(f.list.systemViews!.map((v) => v.key)).toEqual(["default", "open"]);
  expect(f.label).toBe("Sales orders");
  expect(f.list.title).toBe("Sales orders");
  expect(f.list.systemViews!.map((v) => v.name)).toEqual(["PORTAL_VIEW_ALL", "PORTAL_VIEW_OPEN"]);
  expect(f.detail.sections.map((s) => s.label)).toEqual(["PORTAL_GENERAL", "PORTAL_LINES"]);
  expect(f.detail.sections[0]!.groups![0]!.label).toBe("PORTAL_DOCUMENT");
  expect(f.detail.header.facets?.[0]?.statusMapping?.bost_Open?.text).toBe("PORTAL_DOC_STATUS_OPEN");
});

test("no line fields, no Lines section", () => {
  const { DocumentLines: _, ...fields } = c.fields;
  expect(docFeature("Orders", { ...c, fields }, t).detail.sections.map((s) => s.id)).toEqual(["general"]);
});

test("a sales employee shows by name; a quotation's project follows its number, as a link", () => {
  const fields = { ...c.fields, SalesPersonCode: { Type: "number", EdmType: "Edm.Int32", Label: "Sales Employee" } } as EntityConstraints["fields"];
  const f = docFeature("Quotations", { ...c, fields }, t);
  expect(f.list.columns.map((x) => x.key)).toEqual(["DocNum", "ConfigName", "DocDate", "NumAtCard", "SalesPersonName"]);
  const sales = f.list.columns.find((x) => x.key === "SalesPersonName")!;
  expect(sales).toMatchObject({ label: "Sales Employee", sortable: false, filterable: false });
  expect(f.list.columns[1]).toMatchObject({ label: "PORTAL_PROJECT", linkConfig: { route: "/projects", idField: "ConfigId" } });
  expect(f.detail.sections[0]!.groups![0]!.fields.map((x) => x.key)).toEqual(["DocNum", "DocDate", "NumAtCard", "SalesPersonName"]);
  expect(docFeature("Orders", { ...c, fields }, t).list.columns.some((x) => x.key === "ConfigName")).toBe(false);
});
