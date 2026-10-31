import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { InferRouterInputs } from "@orpc/server";
import { db, configMasterdata, configMasterdataRow, configModel, configProject } from "@confire/db";
import { itemsTable, type ModelDef } from "@confire/config-engine";
import { liveEngine, liveProject, recalculate } from "../src/config-project.ts";
import { buildQuoteLines } from "../src/config-quote.ts";
import { bumpMasterdata } from "../src/lookups.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";

// The configuration process through the real router (spec 2026-10-24): the server computes, the
// page sends patches and draws the view. Every price comes out of the masterdata cache, so no agent.

const ACME = { cardCode: "C1", cardName: "Acme" };

const PRICED: ModelDef = {
  name: "Priced box",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select", mandatory: true,
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S" }, { value: "L" }] } },
    },
    { key: "note", label: "Note", type: "string", ui: "input" },
    { key: "fixed", label: "Fixed", type: "number", ui: "input", readonly: true },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "note", "fixed"] }, { table: "items" }, { table: "holes" }] }] },
  computed: [],
  tables: [
    itemsTable(),
    { role: "calc", key: "holes", title: "Holes", columns: [{ key: "d", label: "D", type: "number", cell: { kind: "input" } }] },
  ],
  constraints: [],
  bom: [{ id: "body", itemCode: '"BODY"', qty: 'size == "S" ? 1 : 2' }],
  routing: [],
  pricing: { margin: 50, quoteItemCode: "BOX", priceList: 1, itemTable: "catalog" },
  batchDefaults: [10, 20],
};
const ITEMS = [{ itemcode: "P1", itemname: "Part 1", quantity: 1 }, { itemcode: "P2", itemname: "Part 2", quantity: 2 }];
/** Later than any calculation the test has run, so a strict comparison cannot tie on a millisecond. */
const later = (s = 1) => new Date(Date.now() + s * 1000);

async function setup(def: ModelDef = PRICED, price = 3) {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
  // Synced, with no sync frequency: nothing decides it is stale and goes looking for an agent.
  const [md] = await db.insert(configMasterdata).values({
    tenantId, name: "catalog", kind: "query", query: { target: "b1", query: { entitySet: "Items" }, columns: [] },
    syncedAt: new Date(), rowCount: 1,
  }).returning({ id: configMasterdata.id });
  const setPrice = (p: number) => db.update(configMasterdataRow)
    .set({ row: { ItemCode: "BODY", ItemPrices: [{ PriceList: 1, Price: p }] } }).where(eq(configMasterdataRow.masterdataId, md!.id));
  await db.insert(configMasterdataRow).values({ tenantId, masterdataId: md!.id, seq: 0, row: {} });
  await setPrice(price);
  const [m] = await db.insert(configModel).values({ tenantId, name: def.name, definition: def }).returning({ id: configModel.id });
  const create = async (name = "Box", customer: typeof ACME | null = ACME) =>
    (await call(router.configs.create, { modelId: m!.id, name, customer }, ctx)).id;
  /** A sync landing after the calculation: new rows, a newer syncedAt, the memo told. */
  const sync = async (p: number) => {
    await setPrice(p);
    await db.update(configMasterdata).set({ syncedAt: later() }).where(eq(configMasterdata.id, md!.id));
    bumpMasterdata(tenantId);
  };
  const calc = (input: InferRouterInputs<typeof router>["configs"]["calculate"]) => call(router.configs.calculate, input, ctx);
  return { tenantId, ctx, modelId: m!.id, create, sync, calc };
}

const load = async (id: string) => (await db.select().from(configProject).where(eq(configProject.id, id)))[0]!;
const codes = (v: { missing: { code: string }[] }) => v.missing.map((m) => m.code);

describe.skipIf(!process.env.DATABASE_URL)("the configuration process", () => {
  test("a patch writes only its own fields; tables per table; set then unset; two writers at once", async () => {
    const s = await setup();
    const id = await s.create();
    const v1 = await s.calc({ id, set: { size: "S" }, tables: { items: ITEMS, holes: [{ d: 1 }] } });
    expect(v1.project.entries).toEqual({ size: "S" });

    const v2 = await s.calc({ id, set: { note: "x" } });
    expect(v2.project.entries).toEqual({ size: "S", note: "x" });
    expect(v2.project.tables).toEqual({ items: ITEMS, holes: [{ d: 1 }] });
    expect([v2.project.name, v2.project.batches, v2.project.customer]).toEqual(["Box", [10, 20], ACME]);

    expect((await s.calc({ id, tables: { holes: [{ d: 2 }] } })).project.tables).toEqual({ items: ITEMS, holes: [{ d: 2 }] });

    await s.calc({ id, set: { note: "y" } });
    expect((await s.calc({ id, unset: ["note"] })).project.entries).toEqual({ size: "S" });
    expect((await s.calc({ id, set: { note: "z" }, unset: ["note"] })).project.entries).toEqual({ size: "S" });

    // The merge happens in SQL, so concurrent writers of different fields all land.
    await Promise.all([s.calc({ id, set: { note: "a" } }), s.calc({ id, batches: [5] }), s.calc({ id, name: "Renamed" })]);
    const row = await load(id);
    expect([row.entries, row.batches, row.name]).toEqual([{ size: "S", note: "a" }, [5], "Renamed"]);
  });

  test("a refusal names every problem, and nothing is written", async () => {
    const s = await setup();
    const id = await s.create();
    await s.calc({ id, set: { size: "S" } });
    const before = await load(id);
    const err = await s.calc({ id, name: "New name", set: { nope: 1, fixed: 2, size: ["S"] }, tables: { other: [], items: [{ junk: 1 }] } })
      .then(() => null, (e: Error & { code?: string }) => e);
    expect(err?.code).toBe("BAD_REQUEST");
    for (const named of ["nope", "fixed", "size", "other", "junk"]) expect(err!.message).toContain(named);
    expect(await load(id)).toEqual(before);
  });

  test("the gate: no candidates while anything mandatory is missing; the call that fills the last one has them", async () => {
    const s = await setup();
    const id = await s.create("Box", null);
    let v = await call(router.configs.get, { id }, s.ctx);
    expect(codes(v)).toEqual(["customer_required", "param_required", "table_empty"]);
    expect([v.calculation.state, v.candidates.rows, v.costs]).toEqual(["waiting", [], []]);

    v = await s.calc({ id, customer: ACME });
    expect(codes(v)).toEqual(["param_required", "table_empty"]);
    v = await s.calc({ id, set: { size: "S" } });
    expect(codes(v)).toEqual(["table_empty"]);
    v = await s.calc({ id, tables: { items: [{ itemcode: "P1", quantity: 1 }] } });
    expect(v.missing).toEqual([{ key: "items", code: "cell_required", params: ["Items", "Item name", "1"], message: "Items: Item name is empty in row 1" }]);
    expect(v.candidates.rows).toEqual([]);
    v = await s.calc({ id, tables: { items: ITEMS } });
    expect([v.missing, v.calculation.state, v.candidates.rows.length, v.costs.length]).toEqual([[], "current", 1, 2]);

    v = await s.calc({ id, batches: [] });
    expect([codes(v), v.candidates.rows]).toEqual([["batches_required"], []]);
    v = await s.calc({ id, batches: [10] });
    expect(v.candidates.rows).toHaveLength(1);

    // A rename feeds no figure: candidates and picks stay. Clearing the customer closes the gate.
    await call(router.configs.select, { projectId: id, selection: [{ candidateIdx: 0, batchQty: 10 }] }, s.ctx);
    v = await s.calc({ id, name: "Renamed" });
    expect([v.selection.picks.length, v.candidates.rows.length]).toEqual([1, 1]);
    v = await s.calc({ id, customer: null });
    expect([codes(v), v.candidates.rows, v.selection.picks]).toEqual([["customer_required"], [], []]);

    // A name is the gate too (a row stored without one, from before names were required).
    await db.update(configProject).set({ name: "", customer: ACME }).where(eq(configProject.id, id));
    v = await call(router.configs.get, { id }, s.ctx);
    expect([codes(v), v.candidates.rows]).toEqual([["name_required"], []]);
  });

  test("a calculation that cannot complete keeps the inputs and says why; duplicate keeps such a copy", async () => {
    const broken: ModelDef = { ...PRICED, routing: [{ id: "cut", resource: "SAW", setupMin: "size", runMinPerUnit: "1", ratePerHour: "60" }] };
    const s = await setup(broken);
    const id = await s.create();
    const v = await s.calc({ id, set: { size: "S" }, tables: { items: ITEMS } });
    expect(v.project.entries).toEqual({ size: "S" });
    expect(v.calculation.state).toBe("failed");
    expect(v.calculation.message).toContain("setupMin");
    expect(v.candidates.rows).toEqual([]);
    // not stored: the next read tries again, and says so again
    expect((await call(router.configs.get, { id }, s.ctx)).calculation.state).toBe("failed");

    const { id: copy } = await call(router.configs.duplicate, { id }, s.ctx);
    expect((await load(copy)).entries).toEqual({ size: "S" });
  });

  test("staleness: a price sync and a model edit reach the candidates; a quoted project never recalculates", async () => {
    const s = await setup(PRICED, 3);
    const id = await s.create();
    const price = (v: { candidates: { rows: { perBatch: { unitPrice: number }[] }[] } }) => v.candidates.rows[0]!.perBatch[0]!.unitPrice;
    expect(price(await s.calc({ id, set: { size: "S" }, tables: { items: ITEMS } }))).toBeCloseTo(6); // 1 × 3, × 2

    await s.sync(5);
    expect(price(await call(router.configs.get, { id }, s.ctx))).toBeCloseTo(10);

    await db.update(configModel).set({ definition: { ...PRICED, pricing: { ...PRICED.pricing, margin: 75 } }, updatedAt: later(2) })
      .where(eq(configModel.id, s.modelId));
    expect(price(await call(router.configs.get, { id }, s.ctx))).toBeCloseTo(20);

    await db.update(configProject).set({ status: "quoted" }).where(eq(configProject.id, id));
    await s.sync(7);
    const v = await call(router.configs.get, { id }, s.ctx);
    expect([v.project.status, price(v)]).toEqual(["quoted", 20]);
  });

  test("a configuration's margin prices over the model's, recalculates, and is the staff's alone", async () => {
    const s = await setup(PRICED, 3);
    const id = await s.create();
    const v = await s.calc({ id, set: { size: "S" }, tables: { items: ITEMS } });
    expect([v.margin, v.candidates.rows[0]!.perBatch[0]!.unitPrice]).toEqual([50, 6]); // cost 3
    const own = await s.calc({ id, margin: 75 });
    expect([own.margin, own.candidates.rows[0]!.perBatch[0]!.unitPrice]).toEqual([75, 12]);
    expect((await load(id)).margin).toBe(75);
    const back = await s.calc({ id, margin: null });
    expect([back.margin, back.candidates.rows[0]!.perBatch[0]!.unitPrice]).toEqual([50, 6]);
    await expect(s.calc({ id, margin: 100 })).rejects.toThrow();
  });

  test("the calculation's write: a patch landing between its read and its write is not undone", async () => {
    const s = await setup();
    const id = await s.create();
    await s.calc({ id, set: { size: "S" }, tables: { items: ITEMS } });
    const before = await liveProject(s.tenantId, and(eq(configProject.id, id), eq(configProject.tenantId, s.tenantId))!, "internal");
    await s.calc({ id, set: { note: "late" } });

    const r = await recalculate(s.tenantId, before.row, before.model, before.lookups, { missing: [], conflicts: [] });
    expect(r.lost).toBe(true);
    const row = await load(id);
    expect(row.entries).toEqual({ size: "S", note: "late" });
    expect(row.candidates).toHaveLength(1); // the newer call's own calculation
  });

  test("one money unit: the view's costs are the quotation's lines, a typed price included, every quantity present", async () => {
    const s = await setup();
    const id = await s.create();
    await s.calc({ id, set: { size: "L" }, tables: { items: [ITEMS[0]!, { ...ITEMS[1]!, unitprice: 4 }] } });
    const v = await call(router.configs.select, { projectId: id, selection: [{ candidateIdx: 0, batchQty: 20 }] }, s.ctx);
    expect(v.costs.map((c) => c.batchQty)).toEqual([10, 20]);

    const row = await load(id);
    const { model, lookups } = await liveEngine(s.tenantId, row);
    const q = buildQuoteLines(row, model.definition, lookups);
    const at20 = v.costs.find((c) => c.batchQty === 20)!;
    expect(at20.price).toBeCloseTo(q.value, 8);
    expect(at20.cost).toBeCloseTo(q.cost, 8);
    expect(at20.items).toHaveLength(q.lines.length);
    at20.items.forEach((r, i) => expect(r!.unitPrice).toBeCloseTo(q.lines[i]!.UnitPrice as number, 8));
    expect(at20.items[1]).toMatchObject({ unitPrice: 4, typed: true });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sources", () => {
  const SRC = { file: "RFQ.pdf", page: 1, quote: "Size S" } as const;
  test("a sourced write stores value and source; a human edit of that key drops it", async () => {
    const s = await setup(); const id = await s.create();
    const v1 = await s.calc({ id, set: { size: "S", note: "x" }, sources: { size: SRC } });
    expect(v1.project.sources).toEqual({ size: { value: "S", source: SRC } });
    const v2 = await s.calc({ id, set: { size: "L" } }); // no source: the page
    expect(v2.project.sources).toEqual({});
  });
  test("batches and tables carry their sources; a name-only write leaves them", async () => {
    const s = await setup(); const id = await s.create();
    const chat = { chat: "50 and 200 pieces" };
    const v = await s.calc({ id, batches: [50, 200], tables: { holes: [{ d: 4 }] }, sources: { batches: chat, holes: SRC } });
    expect(v.project.sources).toEqual({ batches: { value: [50, 200], source: chat }, holes: { value: [{ d: 4 }], source: SRC } });
    expect((await s.calc({ id, name: "Renamed" })).project.sources).toEqual(v.project.sources);
  });
  test("unset drops the source; a source for an unwritten key is refused", async () => {
    const s = await setup(); const id = await s.create();
    await s.calc({ id, set: { size: "S" }, sources: { size: SRC } });
    expect((await s.calc({ id, unset: ["size"] })).project.sources).toEqual({});
    await expect(s.calc({ id, set: { note: "x" }, sources: { size: SRC } })).rejects.toThrow("size is not written");
  });
  test("model switch clears sources; duplicate keeps them", async () => {
    const s = await setup(); const id = await s.create();
    await s.calc({ id, set: { size: "S" }, sources: { size: SRC } });
    const { id: copy } = await call(router.configs.duplicate, { id }, s.ctx);
    expect((await load(copy)).sources).toEqual({ size: { value: "S", source: SRC } });
    const [other] = await db.insert(configModel).values({ tenantId: s.tenantId, name: "Other", definition: PRICED }).returning({ id: configModel.id });
    expect((await call(router.configs.update, { id, modelId: other!.id }, s.ctx)).project.sources).toEqual({});
  });
});
