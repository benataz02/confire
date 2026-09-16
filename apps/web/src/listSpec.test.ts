import { expect, test } from "bun:test";
import { EMPTY_SPEC, optionFilterValues, sameDef, schemaColumns, type ListVariantDef } from "./listSpec.ts";

test("optionFilterValues reads a saved eq and a multi in the same way", () => {
  expect(optionFilterValues()).toEqual([]);
  expect(optionFilterValues({ field: "status", op: "eq", value: "quoted" })).toEqual(["quoted"]);
  expect(optionFilterValues({ field: "status", op: "in", value: ["quoted", "requested"] })).toEqual(["quoted", "requested"]);
});

test("the unfiltered case is one shared array, not a fresh one per call", () => {
  // MultiComboBox's `selectedValues` is a property, not an attribute: withWebComponent assigns it
  // from a useEffect keyed on value identity, so a new [] per render is a DOM write and a
  // web-component invalidation per render on every option column that has no filter.
  expect(optionFilterValues()).toBe(optionFilterValues());
});

// Verbatim from `select '…'::jsonb` on the dev database — Postgres sorts object keys by length then
// bytewise, so the seeded "Requested" view comes back with its condition as {op, field, value}.
// Parsed from a string because an object literal here would be in *source* order, not jsonb order.
const FROM_POSTGRES = JSON.parse(
  '{"filter": [{"op": "eq", "field": "status", "value": "requested"}], "select": [], "orderby": [{"dir": "desc", "field": "updatedAt"}], "filterBar": ["status"]}',
) as ListVariantDef;

const AS_WRITTEN: ListVariantDef = {
  select: [],
  filter: [{ field: "status", op: "eq", value: "requested" }],
  orderby: [{ field: "updatedAt", dir: "desc" }],
  filterBar: ["status"],
};

test("sameDef ignores jsonb key order, so the dirty asterisk clears after a Save", () => {
  expect(JSON.stringify(AS_WRITTEN)).not.toBe(JSON.stringify(FROM_POSTGRES)); // why canon exists
  expect(sameDef(AS_WRITTEN, FROM_POSTGRES)).toBe(true);
});

test("an empty optional is not the same as an absent one — the writers must omit the key", () => {
  expect(sameDef({ ...EMPTY_SPEC, search: "" }, EMPTY_SPEC)).toBe(false);
  expect(sameDef({ ...EMPTY_SPEC, labels: {} }, EMPTY_SPEC)).toBe(false);
});

test("sameDef still sees real edits", () => {
  expect(sameDef({ ...AS_WRITTEN, search: "acme" }, FROM_POSTGRES)).toBe(false);
  expect(sameDef({ ...AS_WRITTEN, labels: { status: "State" } }, FROM_POSTGRES)).toBe(false);
  // Array order IS part of the view: these are two different column orders, not one reordered key.
  expect(sameDef({ ...EMPTY_SPEC, select: ["a", "b"] }, { ...EMPTY_SPEC, select: ["b", "a"] })).toBe(false);
});

test("no selected row is not dirty", () => {
  expect(sameDef(EMPTY_SPEC, null)).toBe(false); // useListSpec gates on !!selectedDef before asking
});

test("schemaColumns types BoYesNoEnum as boolean and drops collections", () => {
  const cols = schemaColumns([
    { name: "DocEntry", kind: "number", edmType: "Edm.Int32" },
    { name: "Printed", kind: "boolean", edmType: "SAPB1.BoYesNoEnum", label: "Printed" },
    { name: "DocumentLines", kind: "collection", edmType: "Collection(DocumentLine)" },
    { name: "DocumentStatus", kind: "enum", edmType: "SAPB1.BoStatus", options: [{ value: "O", label: "Open" }] },
  ]);
  expect(cols.map((c) => c.name)).toEqual(["DocEntry", "Printed", "DocumentStatus"]);
  expect(cols.find((c) => c.name === "Printed")?.type).toBe("Edm.Boolean");
  expect(cols.find((c) => c.name === "DocumentStatus")?.options).toEqual([{ value: "O", text: "Open" }]);
});
