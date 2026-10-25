import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { fakeText, type FakeResponseStep } from "@tanstack/ai/testing";
import { db, aiUsage, assistantSettings, configModel, configProject, projectFile } from "@confire/db";
import { itemsTable, type FormState, type ModelDef, type Val } from "@confire/config-engine";
import {
  extractInto, extractionSchema, modelBlock, planApply, type Extraction, type FileSource,
} from "../src/assistant/extract.ts";
import type { FileRef } from "../src/assistant/files.ts";
import { useTestAdapter } from "../src/assistant/model.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";

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

// --- the call and its write (DB) -----------------------------------------------------------------

const BOX: ModelDef = {
  name: "Box",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select", mandatory: true,
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S" }, { value: "L" }] } },
    },
    { key: "width", label: "Width", type: "number", ui: "input", domain: { kind: "range", min: 10, max: 500 } },
    { key: "note", label: "Note", type: "string", ui: "input" },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "width", "note"] }] }] },
  computed: [], tables: [], constraints: [], bom: [], routing: [],
  pricing: { priceExpr: "1", quoteItemCode: "BOX" },
  batchDefaults: [10],
};
const PDF = Buffer.from("%PDF-1.4 a drawing");
const answer = (p: Partial<Extraction>): FakeResponseStep => ({ text: JSON.stringify(x(p)) });

async function world(on = true) {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  const headers = tenantHeaders(slug, admin.cookie);
  if (on) await db.insert(assistantSettings).values({ tenantId, assistant: true });
  const [m] = await db.insert(configModel).values({ tenantId, name: "Box", definition: BOX }).returning({ id: configModel.id });
  const { id } = await call(router.configs.create, { modelId: m!.id, name: "Box", customer: null }, { context: { headers } });
  const file = async (name = "RFQ.pdf", data = PDF): Promise<FileRef> => {
    const [f] = await db.insert(projectFile).values({ tenantId, projectId: id, name, mime: "application/pdf", size: data.length, data }).returning({ id: projectFile.id });
    return { kind: "project", id: f!.id, name, mime: "application/pdf" };
  };
  const fake = fakeText();
  useTestAdapter(fake);
  const ctx = { headers, tenantId, userId: admin.userId, threadId: null };
  const calc = (input: { set?: Record<string, Val> }) => call(router.configs.calculate, { id, ...input }, { context: { headers } });
  const load = async () => (await db.select().from(configProject).where(eq(configProject.id, id)))[0]!;
  const usage = () => db.select().from(aiUsage).where(eq(aiUsage.tenantId, tenantId));
  return { tenantId, id, file, fake, ctx, calc, load, usage };
}
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);

describe.skipIf(!process.env.DATABASE_URL)("extractInto", () => {
  afterEach(() => useTestAdapter(null));

  test("reads, fills the empty fields with their sources, asks the rest, meters the call", async () => {
    const w = await world();
    w.fake.setResponses([answer({
      set: [s("size", "S"), s("width", 900, { file: "RFQ.pdf", page: 1, quote: "W 900" })],
      unsure: [{ key: "note", why: "smudged", candidates: [] }],
    })]);
    const r = await extractInto(w.ctx, w.id, { refs: [await w.file()], text: "50 pcs" });
    const row = await w.load();
    expect(row.entries).toEqual({ size: "S" });
    expect(row.sources.size!.source).toEqual({ file: "RFQ.pdf", page: 1, quote: "SIZE S" });
    expect(r.applied).toEqual([{ key: "size", label: "Size", value: "S", source: SRC }]);
    expect(r.questions.map((q) => [q.key, q.why])).toEqual([["width", "out_of_range"], ["note", "unsure"]]);
    const rows = await w.usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "extract", projectId: w.id });
  });

  test("a value typed while the model reads wins", async () => {
    const w = await world();
    w.fake.setResponses([async () => {
      await w.calc({ set: { size: "L" } });
      return { text: JSON.stringify(x({ set: [s("size", "S")] })) };
    }]);
    const r = await extractInto(w.ctx, w.id, { refs: [await w.file()], text: "" });
    expect((await w.load()).entries.size).toBe("L");
    expect(r.questions).toContainEqual(expect.objectContaining({ key: "size", why: "differs", read: "S" }));
    expect(r.applied).toEqual([]);
  });

  test("quantities the patch would refuse become a question; the rest is still written", async () => {
    const w = await world();
    w.fake.setResponses([answer({ set: [s("size", "S")], batches: { qtys: [0.5, 200], source: SRC } })]);
    const r = await extractInto(w.ctx, w.id, { refs: [await w.file()], text: "" });
    expect((await w.load()).entries).toEqual({ size: "S" });
    expect((await w.load()).batches).toEqual([10]);
    expect(r.questions).toContainEqual(expect.objectContaining({ key: "batches", why: "not_an_option" }));
  });

  test("locked: refused before the model is called", async () => {
    const w = await world();
    await db.update(configProject).set({ status: "quoted" }).where(eq(configProject.id, w.id));
    w.fake.setResponses([answer({ set: [s("size", "S")] })]);
    expect(await codeOf(extractInto(w.ctx, w.id, { refs: [await w.file()], text: "" }))).toBe("CONFLICT");
    expect(w.fake.state.callCount).toBe(0);
    expect(await w.usage()).toHaveLength(0);
  });

  test("attachments over the request cap are refused, unbilled", async () => {
    const w = await world();
    const big = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]);
    const refs = [await w.file("a.pdf", big), await w.file("b.pdf", big), await w.file("c.pdf", big)];
    w.fake.setResponses([answer({})]);
    expect(await codeOf(extractInto(w.ctx, w.id, { refs, text: "" }))).toBe("PAYLOAD_TOO_LARGE");
    expect(w.fake.state.callCount).toBe(0);
  });

  test("switch off: ASSISTANT_OFF, nothing read", async () => {
    const w = await world(false);
    w.fake.setResponses([answer({ set: [s("size", "S")] })]);
    expect(await codeOf(extractInto(w.ctx, w.id, { refs: [await w.file()], text: "" }))).toBe("ASSISTANT_OFF");
    expect(w.fake.state.callCount).toBe(0);
    expect((await w.load()).entries).toEqual({});
  });

  test("another tenant's file is not read", async () => {
    const w = await world();
    const other = await world();
    let sent = "";
    w.fake.setResponses([({ request }) => { sent = JSON.stringify(request.messages); return { text: JSON.stringify(x({})) }; }]);
    useTestAdapter(w.fake);
    await extractInto(w.ctx, w.id, { refs: [await other.file("theirs.pdf"), await w.file("ours.pdf")], text: "x" });
    expect(sent).toContain("ours.pdf");
    expect(sent).not.toContain("theirs.pdf");
  });
});
