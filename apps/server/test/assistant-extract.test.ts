import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { itemsTable, type FormState, type ModelDef, type Val } from "@confire/config-engine";
import {
  extractionSchema, modelBlock, planApply, type Extraction, type FileSource,
} from "../src/assistant/extract.ts";

// The extraction's pure half (assistant spec §4.4): what the model is told, the schema its answer
// must fit, and how a read becomes a patch plus questions. Values fill empty fields only; anything
// else is asked, never written.

const DEF: ModelDef = {
  name: "Bracket",
  description: "Welded steel brackets, cut and bent.",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select", mandatory: true, help: "Nominal size on the drawing",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S", label: "Small" }, { value: "L", label: "Large" }] } },
    },
    { key: "grade", label: "Grade", type: "string", ui: "select", domain: { kind: "options", ref: { source: "table", table: "grades" } } },
    { key: "item", label: "Item", type: "string", ui: "select", domain: { kind: "options", ref: { source: "query", table: "items_q" } } },
    { key: "width", label: "Width", type: "number", ui: "input", unit: "mm", domain: { kind: "range", min: 10, max: 500, step: 5 }, requiredWhen: 'size == "L"' },
    { key: "note", label: "Note", type: "string", ui: "input", visibleWhen: "width > 100" },
    { key: "fixed", label: "Fixed", type: "number", ui: "input", readonly: true },
  ],
  structure: { sections: [] },
  computed: [],
  tables: [itemsTable()],
  constraints: [{ kind: "expr", assert: 'size != "S" || grade != "steel"', message: "No S in steel" }],
  bom: [], routing: [],
  pricing: { priceExpr: "0", quoteItemCode: "X" },
  batchDefaults: [10, 20],
};

const FORM: FormState = {
  fields: {
    size: { visible: true, required: true, options: [{ value: "S", label: "Small" }, { value: "L", label: "Large" }] },
    grade: { visible: true, required: false, options: [{ value: "steel", label: "Steel" }, { value: "alu", label: "Aluminium" }] },
    item: { visible: true, required: false },
    width: { visible: true, required: false },
    note: { visible: false, required: false },
    fixed: { visible: true, required: false, value: 3 },
  },
  conflicts: [], open: 0, tables: { items: [] },
};

const SRC: FileSource = { file: "RFQ.pdf", page: 1, quote: "SIZE S" };
const s = (key: string, value: Val, source: FileSource = SRC) => ({ key, value, source });
const x = (p: Partial<Extraction>): Extraction => ({ set: [], batches: null, tables: [], unsure: [], notes: [], ...p });
const view = (p: Partial<Parameters<typeof planApply>[1]> = {}) => ({ entries: {}, batches: [10, 20], tables: {}, form: FORM, ...p });
const all = () => true;

test("fills empty fields only; same value is silent; different is a question", () => {
  const p = planApply(DEF, view({ entries: { size: "L", grade: "alu" } }), x({ set: [s("size", "S"), s("grade", "alu"), s("width", 200)] }), all);
  expect(p.patch.set).toEqual({ width: 200 });
  expect(p.sources).toEqual({ width: SRC });
  expect(p.questions).toEqual([expect.objectContaining({ key: "size", why: "differs", read: "S" })]);
});

test("an option a rule eliminated is asked with the rule's message", () => {
  const form = { ...FORM, fields: { ...FORM.fields, size: { ...FORM.fields.size!, options: [{ value: "S", label: "Small", unavailable: "No S in steel" }, { value: "L", label: "Large" }] } } };
  const p = planApply(DEF, view({ form }), x({ set: [s("size", "S")] }), all);
  expect(p.patch.set).toEqual({});
  expect(p.questions).toEqual([expect.objectContaining({ key: "size", why: "unavailable", detail: "No S in steel", read: "S" })]);
});

test("a value outside a manual or table list is not an option", () => {
  const p = planApply(DEF, view(), x({ set: [s("grade", "brass")] }), all);
  expect(p.questions).toEqual([expect.objectContaining({ key: "grade", why: "not_an_option", read: "brass" })]);
});

test("a query-backed value the cache does not hold is asked", () => {
  const p = planApply(DEF, view(), x({ set: [s("item", "A1"), s("width", 50)] }), (k) => k !== "item");
  expect(p.patch.set).toEqual({ width: 50 });
  expect(p.questions).toEqual([expect.objectContaining({ key: "item", why: "not_an_option" })]);
});

test("out of range is asked, never clamped", () => {
  const p = planApply(DEF, view(), x({ set: [s("width", 900)] }), all);
  expect(p.patch.set).toEqual({});
  expect(p.questions).toEqual([expect.objectContaining({ key: "width", why: "out_of_range", read: 900 })]);
});

test("batches only replace the untouched defaults", () => {
  const read = { qtys: [50, 200], source: SRC };
  const fresh = planApply(DEF, view(), x({ batches: read }), all);
  expect(fresh.patch.batches).toEqual([50, 200]);
  expect(fresh.sources.batches).toEqual(SRC);
  const edited = planApply(DEF, view({ batches: [5] }), x({ batches: read }), all);
  expect(edited.patch.batches).toBeUndefined();
  expect(edited.questions).toEqual([expect.objectContaining({ key: "batches", why: "differs" })]);
});

test("a table with rows is not overwritten; an empty one is filled, null cells left out", () => {
  const rows = [{ itemcode: "P1", itemname: null, quantity: 2 }];
  const empty = planApply(DEF, view(), x({ tables: [{ table: "items", rows, source: SRC }] }), all);
  expect(empty.patch.tables).toEqual({ items: [{ itemcode: "P1", quantity: 2 }] });
  expect(empty.sources.items).toEqual(SRC);
  const full = planApply(DEF, view({ tables: { items: [{ itemcode: "X", quantity: 1 }] } }), x({ tables: [{ table: "items", rows, source: SRC }] }), all);
  expect(full.patch.tables).toBeUndefined();
  expect(full.questions).toEqual([expect.objectContaining({ key: "items", why: "differs" })]);
});

test("one key read twice two ways is ambiguous; unsure and notes pass through", () => {
  const p = planApply(DEF, view(), x({
    set: [s("size", "S"), s("size", "L", { file: "RFQ.pdf", page: 2, quote: "L" })],
    unsure: [{ key: "width", why: "smudged", candidates: [200, 250] }],
    notes: ["Deliver by June"],
  }), all);
  expect(p.patch.set).toEqual({});
  expect(p.questions).toEqual([
    expect.objectContaining({ key: "size", why: "ambiguous", candidates: ["S", "L"] }),
    expect.objectContaining({ key: "width", why: "unsure", detail: "smudged", candidates: [200, 250] }),
  ]);
  expect(p.notes).toEqual(["Deliver by June"]);
});

test("a read-only parameter is never in the schema", () => {
  const schema = extractionSchema(DEF, FORM);
  expect(schema.safeParse(x({ set: [s("fixed", 4)] })).success).toBe(false);
  expect(schema.safeParse(x({ set: [s("width", 4)] })).success).toBe(true);
});

describe("schema", () => {
  const json = JSON.stringify(z.toJSONSchema(extractionSchema(DEF, FORM)));
  test("enums for short lists, string for query and long lists, no bounds keywords", () => {
    expect(json).not.toMatch(/"minimum"|"maximum"|"minLength"|"exclusiveMinimum"/);
    expect(json).toContain('"enum":["S","L"]');
    expect(extractionSchema(DEF, FORM).safeParse(x({ set: [s("size", "M")] })).success).toBe(false);
    expect(extractionSchema(DEF, FORM).safeParse(x({ set: [s("item", "anything")] })).success).toBe(true);
  });
  test("no open-ended objects: Claude takes additionalProperties false only", () => {
    expect(json).not.toMatch(/"additionalProperties":\{/);
    expect(json).not.toContain('"oneOf"');
  });
});

test("modelBlock is stable and names help, rules and allowed values", () => {
  const b = modelBlock(DEF, FORM);
  expect(b).toBe(modelBlock(DEF, FORM));
  for (const part of ["Welded steel brackets", "width", "Nominal size on the drawing", "No S in steel", "S (Small)", "10–500", "search", "itemcode"])
    expect(b).toContain(part);
  expect(b).not.toContain("fixed");
  // a rule eliminating an option changes the form, not the block: it stays cacheable
  const ruled = { ...FORM, fields: { ...FORM.fields, size: { ...FORM.fields.size!, options: [{ value: "S", label: "Small", unavailable: "No S in steel" }, { value: "L", label: "Large" }] } } };
  expect(modelBlock(DEF, ruled)).toBe(b);
});
