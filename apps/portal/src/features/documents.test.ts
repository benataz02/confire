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

test("columns and form follow the server's field order; lines are the table", () => {
  const f = docFeature("Orders", c);
  expect(f.list.columns.map((x) => x.key)).toEqual(["DocNum", "DocDate", "NumAtCard"]);
  expect(f.detail.sections[0]!.groups![0]!.fields.map((x) => x.key)).toEqual(["DocNum", "DocDate", "NumAtCard"]);
  expect(f.detail.sections[1]!.table!.columns.map((x) => x.key)).toEqual(["ItemCode", "LineTotal"]);
  expect(f.list.systemViews!.map((v) => v.key)).toEqual(["default", "open"]);
  expect(f.label).toBe("Sales orders");
});

test("no line fields, no Lines section", () => {
  const { DocumentLines: _, ...fields } = c.fields;
  expect(docFeature("Orders", { ...c, fields }).detail.sections.map((s) => s.id)).toEqual(["general"]);
});
