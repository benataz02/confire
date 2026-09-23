import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configMasterdata, configMasterdataRow, configModel, configProject, type ConfigCandidate } from "@confire/db";
import type { Entries, ModelDef, ResolvedLookups } from "@confire/config-engine";
import { applySelection, cachedLookups, calculateProject, createQuote, loadModel } from "../src/orpc/routers/configs.ts";
import { buildQuoteLines, configDocumentCommandId } from "../src/config-quote.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import type { RowCache } from "../src/lookups.ts";

const tenantId = `test-cfg-${crypto.randomUUID()}`;

const model: ModelDef = {
  name: "Test box",
  parameters: [
    {
      key: "size", label: "Size", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "S" }, { value: "L" }] } },
    },
    {
      key: "grade", label: "Grade", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode" } },
    },
  ],
  structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["size", "grade"] }] }] },
  computed: [],
  constraints: [],
  bom: [{ id: "body", itemCode: '"BODY"', qty: 'size == "S" ? 1 : 2' }],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "1", ratePerHour: "60" }],
  pricing: { priceExpr: "unitCost * 2", quoteItemCode: "BOX", priceList: 1, itemTable: "catalog" },
  batchDefaults: [10],
};

// The masterdata ids the fakes dispatch on, filled by seedQueryTable.
const ids: Record<string, string> = {};

/** A RowCache over literal rows, honouring the two shapes a resolve asks for: a page of a table,
 *  and the rows holding particular values in one column. This is the whole seam now — a resolve
 *  never reaches an agent, so there is no runner left to fake. */
const cacheOf = (byName: Record<string, Record<string, unknown>[]>, log?: unknown[]): RowCache =>
  async (id, q) => {
    log?.push({ id, ...q });
    const name = Object.keys(ids).find((n) => ids[n] === id);
    const rows = (name && byName[name]) ?? [];
    if (q?.col && q.values) return rows.filter((r) => q.values!.some((v) => String(v) === String(r[q.col!])));
    return q?.top === undefined ? rows : rows.slice(q.skip ?? 0, (q.skip ?? 0) + q.top);
  };

/** A model with no query masterdata still prices its BOM — out of the cached item table. */
const noFetch: RowCache = cacheOf({ catalog: [{ ItemCode: "SHEET", ItemPrices: [{ PriceList: 1, Price: 10 }] }] });

// The `items` table backs the `grade` domain (a $select'd page); `catalog` backs the BOM's prices
// (whole Items rows, so the nested ItemPrices collection survives — it cannot be $selected).
const fakeFetch: RowCache = cacheOf({
  items: [{ ItemCode: "A" }, { ItemCode: "B" }],
  catalog: [{ ItemCode: "BODY", ItemPrices: [{ PriceList: 1, Price: 3 }] }],
});

const lookups: ResolvedLookups = {
  domains: { grade: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
  tables: { items: { columns: ["ItemCode"], rows: [["A"], ["B"]] } },
};

// A query table is tenant masterdata now, not part of any model: one row, referenced by name.
const seedQueryTable = async (name: string, columns: string[]) => {
  const [r] = await db.insert(configMasterdata).values({
    tenantId, name, kind: "query",
    query: { target: "b1", query: { entitySet: "Items" }, columns },
  }).onConflictDoNothing().returning({ id: configMasterdata.id });
  if (r) ids[name] = r.id;
  return ids[name]!;
};

const seed = async (name: string, def: ModelDef, entries: Entries, batches: number[]) => {
  const [m] = await db.insert(configModel).values({ tenantId, name: def.name, definition: def })
    .returning({ id: configModel.id });
  const [p] = await db.insert(configProject)
    .values({ tenantId, modelId: m!.id, name, batches, entries, createdBy: "tester" })
    .returning({ id: configProject.id });
  return p!.id;
};

const load = async (id: string) =>
  (await db.select().from(configProject).where(eq(configProject.id, id)).limit(1))[0]!;

// configDocumentCommandId is pure — this half runs without a database.
describe("configDocumentCommandId", () => {
  const candidates = [
    { assignment: { size: "S" }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
    { assignment: { size: "L" }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
  ] satisfies ConfigCandidate[];
  const id = (sel: { candidateIdx: number; batchQty: number }[], c = candidates, tables = {}) =>
    configDocumentCommandId({ tenantId: "t", projectId: "p", candidates: c, selection: sel, tables });

  test("a reordered retry of the same picks keeps its key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }, { candidateIdx: 1, batchQty: 10 }]);
    expect(a).toHaveLength(64);
    expect(id([{ candidateIdx: 1, batchQty: 10 }, { candidateIdx: 0, batchQty: 10 }])).toBe(a);
  });

  test("editing the item matrix changes the key, so a re-post creates a second document", () => {
    const sel = [{ candidateIdx: 0, batchQty: 10 }];
    const a = id(sel, candidates, { parts: [{ code: "A", pieces: 1 }] });
    expect(id(sel, candidates, { parts: [{ code: "A", pieces: 2 }] })).not.toBe(a);
    // and jsonb key reordering must not: Postgres does not preserve object key order
    expect(id(sel, candidates, { parts: [{ pieces: 1, code: "A" }] })).toBe(a);
  });

  test("dropping a pick or changing a batch quantity changes the key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }, { candidateIdx: 1, batchQty: 10 }]);
    expect(id([{ candidateIdx: 0, batchQty: 10 }])).not.toBe(a);
    expect(id([{ candidateIdx: 0, batchQty: 20 }, { candidateIdx: 1, batchQty: 10 }])).not.toBe(a);
  });

  // The reason the hash covers assignments and not indices: a recalculate replaces the candidate
  // list, so "candidate 0" can silently come to mean a different configuration. If the key did not
  // move with it, the U_CF_Key pre-check would hand back a quotation for the old one.
  test("the same index against a different calculation is a different key", () => {
    const a = id([{ candidateIdx: 0, batchQty: 10 }]);
    const recalculated = [
      { assignment: { size: "L" }, perBatch: [{ batchQty: 10, outputs: {} as never }] },
    ] satisfies ConfigCandidate[];
    expect(id([{ candidateIdx: 0, batchQty: 10 }], recalculated)).not.toBe(a);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("calculateProject (integration)", () => {
  afterAll(async () => {
    await db.delete(configProject).where(eq(configProject.tenantId, tenantId));
    await db.delete(configModel).where(eq(configModel.tenantId, tenantId));
    await db.delete(configMasterdata).where(eq(configMasterdata.tenantId, tenantId));
  });

  test("candidates land on config_project and flip its status; applySelection recomputes overrides", async () => {
    await seedQueryTable("items", ["ItemCode"]);
    await seedQueryTable("catalog", []);
    const id = await seed("proj", model, {}, [10]);

    const res = await calculateProject(tenantId, id, fakeFetch);
    // 2 sizes × 2 grades, nothing constrained away
    expect(res.candidateCount).toBe(4);
    expect(res.capped).toBe(false);

    const project = await load(id);
    expect(project.status).toBe("draft"); // "calculated" is calculatedAt, not a status
    expect(project.calculatedAt).not.toBeNull();
    expect(project.candidates).toHaveLength(4);

    // Hand-check one candidate (size S, batch 10): material 1×3=3;
    // labor ((10/10+1)/60)×60=2; unitCost 5; priceExpr ×2 → unitPrice 10; batchTotal 100.
    const idx = project.candidates.findIndex((c) => c.assignment.size === "S");
    const outputs = project.candidates[idx]!.perBatch[0]!.outputs;
    expect(project.candidates[idx]!.perBatch[0]!.batchQty).toBe(10);
    expect(outputs.unitCost).toBeCloseTo(5);
    expect(outputs.unitPrice).toBeCloseTo(10);
    expect(outputs.batchTotal).toBeCloseTo(100);

    // select: price override 3 → 4 on the same candidate: unitCost 6, unitPrice 12.
    const selections = applySelection(model, lookups, project.candidates, [
      { candidateIdx: idx, batchQty: 10, overrides: { bom: [{ id: "body", unitPrice: 4 }] } },
    ]);
    expect(selections[0]!.outputs.unitCost).toBeCloseTo(6);
    expect(selections[0]!.outputs.unitPrice).toBeCloseTo(12);

    // out-of-range candidate index is rejected
    expect(() => applySelection(model, lookups, project.candidates, [{ candidateIdx: 99, batchQty: 10 }])).toThrow();
  });

  test("a persisted off-page selection is bound, and lands in its domain as well as its price", async () => {
    const offPageModel: ModelDef = {
      name: "Off-page material",
      parameters: [{
        key: "material", label: "Material", type: "string", ui: "select",
        domain: { kind: "options", ref: { source: "query", table: "priced", valueCol: "ItemCode", columns: ["Price"] } },
      }],
      structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["material"] }] }] },
      computed: [],
      constraints: [],
      bom: [{ id: "body", itemCode: "material", qty: "1" }],
      routing: [],
      pricing: { priceExpr: "unitCost", quoteItemCode: "BOX", priceList: 1, itemTable: "catalog" },
      batchDefaults: [1],
    };
    await seedQueryTable("priced", ["ItemCode", "Price"]);
    await seedQueryTable("catalog", []);
    const id = await seed("off-page", offPageModel, { material: "B" }, [1]);

    const reads: { id: string; col?: string; top?: number }[] = [];
    // "B" is past the canonical page: only "A" comes back from an unfiltered read, so binding the
    // stored entry is the only way the configuration can price itself at all.
    const cache: RowCache = async (mdId, q) => {
      reads.push({ id: mdId, col: q?.col, top: q?.top });
      if (mdId === ids.priced)
        return q?.col
          ? [{ ItemCode: "B", Price: 11 }].filter((r) => q.values!.includes(r.ItemCode))
          : [{ ItemCode: "A", Price: 3 }];
      if (mdId === ids.catalog)
        return [
          { ItemCode: "A", ItemPrices: [{ PriceList: 1, Price: 3 }] },
          { ItemCode: "B", ItemPrices: [{ PriceList: 1, Price: 11 }] },
        ].filter((r) => (q?.values ?? []).includes(r.ItemCode));
      return [];
    };

    await calculateProject(tenantId, id, cache);
    // canonical page of `priced`; the price read over that one-value domain; the bind of the
    // stored "B"; and the price read again, now that "B" is in the domain.
    expect(reads.map((r) => `${r.id === ids.priced ? "priced" : "catalog"}:${r.col ?? "page"}`))
      .toEqual(["priced:page", "catalog:ItemCode", "priced:ItemCode", "catalog:ItemCode"]);
    const project = await load(id);
    expect(project.candidates[0]!.perBatch[0]!.outputs.unitCost).toBe(11);

    // The bound value is in the *domain*, not merely in the table: the old live enrich could only
    // afford to append the row, so a stored off-page pick showed as an empty Select.
    const lk = await cachedLookups(
      tenantId, (await loadModel(tenantId, (await load(id)).modelId)), { material: "B" }, {}, cache,
    );
    expect(lk.domains.material!.map((o) => o.value)).toEqual(["A", "B"]);
  });

  // The auto-calculate on the process page fires ~1s after every field edit. Each calculation used
  // to re-GET every query table through the agent; this counts the fetches so that regression is loud.
  test("recalculating does not re-fetch query tables: reuse short-circuits, and the cache absorbs the rest", async () => {
    await seedQueryTable("items", ["ItemCode"]);
    await seedQueryTable("catalog", []);
    const id = await seed("no-refetch", model, {}, [10]);

    let reads = 0;
    const counting: RowCache = async (mdId, q) => {
      reads++;
      return fakeFetch(mdId, q);
    };

    const first = await calculateProject(tenantId, id, counting);
    expect(first.reused).toBe(false);
    expect(reads).toBe(2); // the query table's canonical page, plus the BOM's price read

    // Nothing changed: the reuse check must return before any lookup resolution, so the fetch
    // count cannot move and the stored candidates come straight back.
    const again = await calculateProject(tenantId, id, counting);
    expect(again.reused).toBe(true);
    expect(again.candidateCount).toBe(first.candidateCount);
    expect(reads).toBe(2);

    // A real edit through the API: configs.calculate writes entries AND empties candidates in one
    // statement, which is the invariant that lets a non-null calculatedAt stand in for "these
    // entries produced these candidates". Reuse must not fire.
    await db.update(configProject).set({ entries: { size: "L" }, candidates: [], calculatedAt: null })
      .where(eq(configProject.id, id));
    const edited = await calculateProject(tenantId, id, counting);
    expect(edited.reused).toBe(false);
    expect(edited.candidateCount).toBe(2); // size pinned to L, two grades left

    // Still two. The model was never touched, so the canonical resolve came out of the cache, and
    // binding the new entry read nothing because `size` is a manual domain — only a query-backed
    // value that sits past the canonical page costs a read, and then exactly one.
    expect(reads).toBe(2);
  });

  test("editing the model invalidates the stored calculation", async () => {
    await seedQueryTable("items", ["ItemCode"]);
    await seedQueryTable("catalog", []);
    const id = await seed("model-edit", model, {}, [10]);
    await calculateProject(tenantId, id, fakeFetch);
    expect((await calculateProject(tenantId, id, fakeFetch)).reused).toBe(true);

    const { modelId } = await load(id);
    await db.update(configModel).set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(configModel.id, modelId));
    expect((await calculateProject(tenantId, id, fakeFetch)).reused).toBe(false);
  });
});

// The merge-production path end to end: rows persist, feed the model's formulas, and become n
// reconciling quotation lines. This is where the money invariant lives.
describe("config tables (integration)", () => {
  const tableModel: ModelDef = {
    name: "Merged sheet",
    parameters: [
      {
        key: "thickness", label: "Thickness", type: "number", ui: "select",
        domain: { kind: "options", ref: { source: "manual", options: [{ value: 2 }, { value: 3 }] } },
      },
    ],
    structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["thickness", "holes", "parts"] }] }] },
    computed: [],
    tables: [
      {
        role: "calc", key: "holes", title: "Holes",
        columns: [
          { key: "size", label: "Size", type: "number", cell: { kind: "input" } },
          { key: "minutes", label: "Minutes", type: "number", cell: { kind: "formula", expr: "size * thickness / 10" } },
        ],
      },
      {
        role: "items", key: "parts", title: "Parts", basisExpr: "area",
        map: { code: "U_CF_ItemCode" },
        columns: [
          { key: "code", label: "Code", type: "string", cell: { kind: "input" } },
          { key: "quantity", label: "Pieces", type: "number", cell: { kind: "input" } },
          { key: "area", label: "Area", type: "number", cell: { kind: "input" } },
        ],
      },
    ],
    constraints: [],
    bom: [{ id: "sheet", itemCode: '"SHEET"', qty: "1" }],
    // the table's sum is the whole point: drilling time comes from the rows, not from a parameter
    routing: [{ id: "drill", resource: "CNC", setupMin: "5", runMinPerUnit: "holes_minutes", ratePerHour: "60" }],
    pricing: { priceExpr: "unitCost * 2", quoteItemCode: "SHEET-CFG", priceList: 1, itemTable: "catalog" },
    batchDefaults: [3],
  };

  // What the price-list read hands the engine for this model's one BOM line.
  const SHEET_LOOKUPS = { domains: {}, tables: {}, prices: { SHEET: 10 } };

  const rows = {
    holes: [{ size: 10 }, { size: 20 }],
    parts: [
      { code: "PART-A", quantity: 1, area: 2 },
      { code: "PART-B", quantity: 1, area: 1 },
    ],
  };

  test("rows reach the routing, and the split lines sum to the quoted total", async () => {
    await seedQueryTable("catalog", []); // tableModel prices its SHEET line out of it
    const projectId = await seed("merged", tableModel, { thickness: 3 }, [3]);
    await db.update(configProject).set({ tables: rows }).where(eq(configProject.id, projectId));

    const r = await calculateProject(tenantId, projectId, noFetch);
    expect(r.candidates).toHaveLength(1);
    const out = r.candidates[0]!.perBatch[0]!.outputs;
    // holes_minutes = (10*3 + 20*3)/10 = 9 -> total 5 + 9*3 = 32 min at 60/h = 32 EUR labour
    expect(out.ops[0]!.totalMin).toBe(32);

    const [project] = await db.select().from(configProject).where(eq(configProject.id, projectId));
    const withPick = {
      ...project!,
      customer: { cardCode: "C1", cardName: "Acme" },
      selection: [{ candidateIdx: 0, batchQty: 3 }],
    };
    const { lines, value } = buildQuoteLines(withPick, tableModel, SHEET_LOOKUPS);

    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.U_CF_ItemCode)).toEqual(["PART-A", "PART-B"]);
    // Quantity is row pieces x batch qty, and the generic configurator item stays the B1 ItemCode
    expect(lines.map((l) => l.Quantity)).toEqual([3, 3]);
    expect(new Set(lines.map((l) => l.ItemCode))).toEqual(new Set(["SHEET-CFG"]));

    // The invariant: what SAP will total has to equal what the dashboard stores. Work in cents —
    // that is the unit the split reconciles in, and the unit B1 rounds each line to.
    const cents = (l: Record<string, unknown>) => Math.round(Number(l.Quantity) * Number(l.UnitPrice) * 100);
    const total = Math.round(out.unitPrice * 3 * 100);
    expect(Math.round(value * 100)).toBe(total);
    expect(lines.reduce((a, l) => a + cents(l), 0)).toBe(total);
    // 2:1 by cost basis — exact up to the one cent largest-remainder has to move to make it add up
    expect(Math.abs(cents(lines[0]!) - (total * 2) / 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(cents(lines[1]!) - total / 3)).toBeLessThanOrEqual(1);
  });

  test("no rows in the item matrix is the pre-feature single line", async () => {
    await seedQueryTable("catalog", []); // tableModel prices its SHEET line out of it
    const projectId = await seed("unmerged", tableModel, { thickness: 3 }, [3]);
    await db.update(configProject).set({ tables: { holes: rows.holes } }).where(eq(configProject.id, projectId));
    await calculateProject(tenantId, projectId, noFetch);
    const [project] = await db.select().from(configProject).where(eq(configProject.id, projectId));
    const { lines } = buildQuoteLines(
      { ...project!, customer: { cardCode: "C1", cardName: "Acme" }, selection: [{ candidateIdx: 0, batchQty: 3 }] },
      tableModel, SHEET_LOOKUPS,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ItemCode).toBe("SHEET-CFG");
    expect(lines[0]!.Quantity).toBe(3);
  });

  test("a hand-typed unit price wins over the split and moves the quoted value", async () => {
    await seedQueryTable("catalog", []); // tableModel prices its SHEET line out of it
    const projectId = await seed("priced", tableModel, { thickness: 3 }, [3]);
    const priced = { ...rows, parts: [{ ...rows.parts[0]!, unitprice: 99 }, rows.parts[1]!] };
    await db.update(configProject).set({ tables: priced }).where(eq(configProject.id, projectId));
    await calculateProject(tenantId, projectId, noFetch);

    const [project] = await db.select().from(configProject).where(eq(configProject.id, projectId));
    const { lines, value } = buildQuoteLines(
      { ...project!, customer: { cardCode: "C1", cardName: "Acme" }, selection: [{ candidateIdx: 0, batchQty: 3 }] },
      tableModel, SHEET_LOOKUPS,
    );

    expect(lines[0]!.UnitPrice).toBe(99);
    // the untouched row still carries its share of the split, so one override does not reprice the other
    expect(lines[1]!.UnitPrice).not.toBe(99);
    // value follows the lines, the way B1 will total them
    const cents = (l: Record<string, unknown>) => Math.round(Number(l.Quantity) * Number(l.UnitPrice) * 100);
    expect(Math.round(value * 100)).toBe(lines.reduce((a, l) => a + cents(l), 0));
    expect(cents(lines[0]!)).toBe(99 * 3 * 100);
  });

  test("editing a unit price yields a new dedup key, so the retry check cannot find the old document", () => {
    const candidates = [{ assignment: { thickness: 3 }, perBatch: [] }] as unknown as ConfigCandidate[];
    const args = { tenantId, projectId: "p1", candidates, selection: [{ candidateIdx: 0, batchQty: 3 }] };
    const before = configDocumentCommandId({ ...args, tables: rows });
    const after = configDocumentCommandId({
      ...args,
      tables: { ...rows, parts: [{ ...rows.parts[0]!, unitprice: 99 }, rows.parts[1]!] },
    });
    expect(after).not.toBe(before);
  });

  test("createQuote refuses a header field the Quotations profile does not name", async () => {
    // Rejected before anything reaches the database or SAP, so the ids need not exist.
    await expect(createQuote(tenantId, {
      projectId: crypto.randomUUID(),
      commandId: "0".repeat(64),
      header: { Comments: "fine", DocTotal: 1, DocumentLines: [] },
    })).rejects.toThrow(/DocTotal, DocumentLines/);
  });

  // The invariant, now that no status flag restates it: writing the calculation's inputs empties
  // the candidates they produced, so a stored non-null calculatedAt can never describe stale rows.
  test("editing rows through configs.calculate recomputes instead of reusing", async () => {
    const { tenantId: tid, slug } = await makeTenant();
    const admin = await makeUser("admin", tid);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    // No BOM: this path goes through the real endpoint, which resolves its own runner, and a
    // priced BOM is a live price-list read — it would go looking for the tenant's agent.
    const noBom: ModelDef = { ...tableModel, bom: [] };
    const [m] = await db.insert(configModel).values({ tenantId: tid, name: noBom.name, definition: noBom })
      .returning({ id: configModel.id });
    const [p] = await db.insert(configProject)
      .values({ tenantId: tid, modelId: m!.id, name: "stale", batches: [3], entries: { thickness: 3 }, tables: rows, createdBy: admin.userId })
      .returning({ id: configProject.id });
    const projectId = p!.id;

    await calculateProject(tid, projectId, noFetch);
    const stored = async () =>
      (await db.select().from(configProject).where(eq(configProject.id, projectId)))[0]!;
    const before = await stored();
    expect(before.calculatedAt).not.toBeNull();
    expect(before.candidates.length).toBeGreaterThan(0);

    // One call does the write and the recompute. The returned payload is what `get` returns, so
    // the client never needs a follow-up read.
    const res = await call(
      router.configs.calculate, { id: projectId, tables: { ...rows, holes: [{ size: 99 }] } }, ctx,
    );
    expect(res.project.tables).toEqual({ ...rows, holes: [{ size: 99 }] });
    expect(res.project.candidates.length).toBeGreaterThan(0);

    // Not the reuse path: the edit nulled calculatedAt, so this is a fresh calculation.
    const after = await stored();
    expect(after.calculatedAt!.getTime()).toBeGreaterThan(before.calculatedAt!.getTime());
    expect(after.status).toBe("draft"); // still a draft — "calculated" is not a status any more

    await db.delete(configProject).where(eq(configProject.tenantId, tid));
    await db.delete(configModel).where(eq(configModel.tenantId, tid));
  });
});

describe.skipIf(!process.env.DATABASE_URL)("configs.duplicate (integration)", () => {
  // TEST_MODEL names no query masterdata and carries no BOM, so the recalculate inside duplicate
  // resolves its lookups without an agent — the copy still comes back genuinely calculated.
  test("a quoted configuration copies its inputs, drops everything quote-shaped, and recalculates", async () => {
    const { tenantId: tid, slug } = await makeTenant();
    const admin = await makeUser("admin", tid);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    const [m] = await db.insert(configModel)
      .values({ tenantId: tid, name: TEST_MODEL.name, definition: TEST_MODEL })
      .returning({ id: configModel.id });
    const entries: Entries = { material: "steel", coated: false };
    const [src] = await db.insert(configProject).values({
      tenantId: tid, modelId: m!.id, name: "Bridge cable", createdBy: admin.userId,
      customer: { cardCode: "C0001", cardName: "Acme" },
      entries, batches: [100],
      // A portal request that was quoted: every field the copy must not inherit, set.
      source: "portal", status: "quoted", b1DocEntry: 4711, quotedAt: new Date(),
      quotedValue: "1234.5600", quotedCost: "600.0000", calculatedAt: new Date(),
      selection: [], rejectionNote: null,
    }).returning({ id: configProject.id });

    const { id: copyId } = await call(router.configs.duplicate, { id: src!.id }, ctx);
    const [copy] = await db.select().from(configProject).where(eq(configProject.id, copyId));

    expect(copy!.name).toBe("Bridge cable (copy)");
    expect(copy!.modelId).toBe(m!.id);
    expect(copy!.entries).toEqual(entries);
    expect(copy!.batches).toEqual([100]);
    expect(copy!.customer).toEqual({ cardCode: "C0001", cardName: "Acme" });

    expect(copy!.status).toBe("draft");
    // Not "portal": an internal copy must not surface in that client's own request list.
    expect(copy!.source).toBe("internal");
    // b1DocEntry is the quote idempotency record — inheriting it would make the copy unquotable.
    expect(copy!.b1DocEntry).toBeNull();
    expect(copy!.quotedAt).toBeNull();
    expect(copy!.quotedValue).toBeNull();
    expect(copy!.quotedCost).toBeNull();
    expect(copy!.selection).toBeNull();

    // The recalculate ran: candidates and calculatedAt land together, as everywhere else.
    expect(copy!.calculatedAt).not.toBeNull();
    expect(copy!.candidates.length).toBeGreaterThan(0);

    // The source is untouched and still locked.
    const [after] = await db.select().from(configProject).where(eq(configProject.id, src!.id));
    expect(after!.status).toBe("quoted");
    expect(after!.b1DocEntry).toBe(4711);
    expect(after!.name).toBe("Bridge cable");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("configs.remove (integration)", () => {
  test("refuses a quoted configuration, including in a mixed batch, and still deletes a draft", async () => {
    const { tenantId: tid, slug } = await makeTenant();
    const member = await makeUser("member", tid);
    const ctx = { context: { headers: tenantHeaders(slug, member.cookie) } };

    const [m] = await db.insert(configModel)
      .values({ tenantId: tid, name: TEST_MODEL.name, definition: TEST_MODEL })
      .returning({ id: configModel.id });
    const [quoted] = await db.insert(configProject).values({
      tenantId: tid, modelId: m!.id, name: "Quoted cable", createdBy: member.userId,
      status: "quoted", b1DocEntry: 1, quotedAt: new Date(),
    }).returning({ id: configProject.id });
    const [draft] = await db.insert(configProject).values({
      tenantId: tid, modelId: m!.id, name: "Draft cable", createdBy: member.userId,
    }).returning({ id: configProject.id });

    await expect(call(router.configs.remove, { ids: [quoted!.id] }, ctx))
      .rejects.toThrow(/quoted and locked/);
    expect(await db.select().from(configProject).where(eq(configProject.id, quoted!.id))).toHaveLength(1);

    await expect(call(router.configs.remove, { ids: [quoted!.id, draft!.id] }, ctx))
      .rejects.toThrow(/quoted and locked/);
    expect(await db.select().from(configProject).where(eq(configProject.id, draft!.id))).toHaveLength(1);

    await call(router.configs.remove, { ids: [draft!.id] }, ctx);
    expect(await db.select().from(configProject).where(eq(configProject.id, draft!.id))).toHaveLength(0);
    expect(await db.select().from(configProject).where(eq(configProject.id, quoted!.id))).toHaveLength(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("configs.create (integration)", () => {
  test("inserts the name and customer the new page collected — not an empty draft", async () => {
    const { tenantId: tid, slug } = await makeTenant();
    const member = await makeUser("member", tid);
    const ctx = { context: { headers: tenantHeaders(slug, member.cookie) } };

    const [m] = await db.insert(configModel)
      .values({ tenantId: tid, name: TEST_MODEL.name, definition: TEST_MODEL })
      .returning({ id: configModel.id });

    const { id } = await call(router.configs.create, {
      modelId: m!.id, name: "North hall",
      customer: { cardCode: "C0001", cardName: "Acme" },
    }, ctx);
    const [row] = await db.select().from(configProject).where(eq(configProject.id, id));
    expect(row!.name).toBe("North hall");
    expect(row!.customer).toEqual({ cardCode: "C0001", cardName: "Acme" });
    expect(row!.modelId).toBe(m!.id);
    expect(row!.batches).toEqual(TEST_MODEL.batchDefaults);
  });
});

// The acceptance criterion of the masterdata-cache rewrite: this tenant has NO sap_connection row,
// so any read that reached for the agent would throw SERVICE_UNAVAILABLE (agent not configured).
// Nothing is injected here — calculateProject builds its own rowCache and goes to Postgres.
describe.skipIf(!process.env.DATABASE_URL)("calculating with no agent at all", () => {
  const offlineTenant = `test-offline-${crypto.randomUUID()}`;

  afterAll(async () => {
    await db.delete(configMasterdataRow).where(eq(configMasterdataRow.tenantId, offlineTenant));
    await db.delete(configProject).where(eq(configProject.tenantId, offlineTenant));
    await db.delete(configModel).where(eq(configModel.tenantId, offlineTenant));
    await db.delete(configMasterdata).where(eq(configMasterdata.tenantId, offlineTenant));
  });

  test("options and BOM prices both come out of the cache", async () => {
    const cache = async (name: string, rows: Record<string, unknown>[], columns: string[]) => {
      const [md] = await db.insert(configMasterdata).values({
        tenantId: offlineTenant, name, kind: "query",
        // No syncMinutes: nothing may decide this is stale and go looking for an agent mid-test.
        query: { target: "b1", query: { entitySet: "Items" }, columns },
        syncedAt: new Date(), rowCount: rows.length,
      }).returning({ id: configMasterdata.id });
      if (rows.length)
        await db.insert(configMasterdataRow).values(
          rows.map((row, seq) => ({ tenantId: offlineTenant, masterdataId: md!.id, seq, row })),
        );
    };
    await cache("items", [{ ItemCode: "A" }, { ItemCode: "B" }], ["ItemCode"]);
    await cache("catalog", [
      { ItemCode: "BODY", ItemPrices: [{ PriceList: 1, Price: 3 }] },
    ], []);

    const [m] = await db.insert(configModel)
      .values({ tenantId: offlineTenant, name: model.name, definition: model })
      .returning({ id: configModel.id });
    const [p] = await db.insert(configProject)
      .values({ tenantId: offlineTenant, modelId: m!.id, name: "offline", batches: [10], entries: {}, createdBy: "tester" })
      .returning({ id: configProject.id });

    const res = await calculateProject(offlineTenant, p!.id);
    expect(res.candidateCount).toBe(4); // 2 sizes × 2 grades — the grades came from the cache

    const outputs = res.candidates!.find((c) => c.assignment.size === "S")!.perBatch[0]!.outputs;
    expect(outputs.unitCost).toBeCloseTo(5);   // material 3 from the cached ItemPrices, labour 2
    expect(outputs.unitPrice).toBeCloseTo(10);
  });

  test("a table that was never synced leaves the form renderable, not broken", async () => {
    // No cached rows and no sync state at all — the cold-start case.
    await db.insert(configMasterdata).values({
      tenantId: offlineTenant, name: "empty", kind: "query",
      query: { target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"] },
    });
    const def: ModelDef = {
      ...model,
      parameters: [{
        key: "grade", label: "Grade", type: "string", ui: "select",
        domain: { kind: "options", ref: { source: "query", table: "empty", valueCol: "ItemCode" } },
      }],
      structure: { sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["grade"] }] }] },
      bom: [],
      pricing: { priceExpr: "unitCost", quoteItemCode: "BOX", priceList: 1 },
    };
    const [m] = await db.insert(configModel)
      .values({ tenantId: offlineTenant, name: def.name, definition: def })
      .returning({ id: configModel.id });

    // The resolve succeeds — an unsynced table is an empty one, not an error. That is what keeps
    // every section, parameter and routing line on screen while the cache fills in behind.
    const lk = await cachedLookups(offlineTenant, await loadModel(offlineTenant, m!.id));
    expect(lk.tables.empty).toEqual({ columns: ["ItemCode"], rows: [] });
    expect(lk.domains.grade).toEqual([]);
  });
});
