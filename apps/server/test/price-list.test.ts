import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import {
  ensurePriceList, priceListCode, priceListSql, priceRow, priceState, syncPriceList,
} from "../src/price-list.ts";
import { db, configModel } from "@confire/db";
import { liveEngine } from "../src/config-project.ts";
import { makeTenant, TEST_MODEL } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The model's price list (spec 2026-11-09 §The price list): one stored SQL query per list over ITM1,
// created on first use, paged into a `price_list` entry of sap_cache, refreshed after 24 h.

test("the query text is fixed, the list number spliced in only as a positive integer", () => {
  expect(priceListSql(3)).toBe("SELECT ItemCode, Price FROM ITM1 WHERE PriceList = 3 ORDER BY ItemCode");
  expect(priceListCode(3)).toMatch(/^CF_PL_[0-9a-f]{8}$/);
  expect(priceListCode(3)).not.toBe(priceListCode(4));
  for (const bad of [1.5, 0, -1]) expect(() => priceListSql(bad)).toThrow();
});

test("a row is read by name whatever its case; no price or no code is no row", () => {
  expect(priceRow({ ITEMCODE: "A", PRICE: "12.5" })).toEqual({ ItemCode: "A", Price: 12.5 });
  expect(priceRow({ ItemCode: "B", Price: null })).toBeNull();
  expect(priceRow({ ItemCode: "", Price: 1 })).toBeNull();
});

describe.skipIf(!process.env.DATABASE_URL)("syncing a price list", () => {
  const agents: MockAgent[] = [];
  afterAll(() => { setSystemTime(); for (const a of agents) a.stop(); });
  const setup = async (rows: Record<string, unknown>[]) => {
    const agent = startMockAgent({ [`SQLQueries#${priceListCode(1)}`]: rows });
    agents.push(agent);
    const { tenantId } = await makeTenant();
    await connectTenant(tenantId, agent);
    const sqlCalls = () => agent.calls.filter((c) => c.route === "/sql").length;
    return { agent, tenantId, sqlCalls };
  };
  const until = async (ok: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await ok()); i++) await Bun.sleep(10);
  };

  test("creates the stored query on first use, then pages through every row", async () => {
    const s = await setup(Array.from({ length: 1201 }, (_, n) => ({ ItemCode: `I${n}`, Price: n })));
    expect(await syncPriceList(s.tenantId, 1)).toEqual({ rows: 1201 });
    const creates = s.agent.calls.filter((c) => c.route === "/create" && c.body.entitySet === "SQLQueries");
    expect(creates.map((c) => c.body.data.SqlText)).toEqual([priceListSql(1)]);
    const before = s.sqlCalls();
    await syncPriceList(s.tenantId, 1);
    expect(s.agent.calls.filter((c) => c.route === "/create" && c.body.entitySet === "SQLQueries")).toHaveLength(1);
    expect(s.sqlCalls() - before).toBe(3); // 500 + 500 + 201
  });

  test("an empty price list is an answer, not an error", async () => {
    const s = await setup([]);
    expect(await syncPriceList(s.tenantId, 1)).toEqual({ rows: 0 });
    const state = await priceState(s.tenantId, 1);
    expect(state).toMatchObject({ rows: 0, error: null });
    expect(state!.fetchedAt).toBeInstanceOf(Date);
  });

  test("a quotation is never priced off a list not read yet: the engine reads it first", async () => {
    // After a deploy or a company switch every list is missing, while stored calculations still
    // show their old prices: the quote's own re-pricing must not cost each material at 0.
    const s = await setup([{ ItemCode: "BODY", Price: 3 }]);
    const def = { ...TEST_MODEL, bom: [{ itemCode: '"BODY"', qty: "1" }] };
    const [m] = await db.insert(configModel).values({ tenantId: s.tenantId, name: def.name, definition: def }).returning({ id: configModel.id });
    const { lookups } = await liveEngine(s.tenantId, { modelId: m!.id, entries: {}, tables: {}, margin: null });
    expect(lookups.prices).toEqual({ BODY: 3 });
  });

  test("a list that cannot reach SAP says why", async () => {
    const { tenantId } = await makeTenant(); // no agent paired
    ensurePriceList(tenantId, 1);
    await until(async () => !!(await priceState(tenantId, 1))?.error);
    expect(await priceState(tenantId, 1)).toMatchObject({ fetchedAt: null, rows: 0 });
    expect((await priceState(tenantId, 1))!.error).toBeTruthy();
  });

  test("ensurePriceList fills a missing list in the background and leaves a fresh one alone", async () => {
    const s = await setup([{ ItemCode: "BODY", Price: 3 }]);
    ensurePriceList(s.tenantId, 1);
    await until(async () => ((await priceState(s.tenantId, 1))?.rows ?? 0) > 0);
    expect((await priceState(s.tenantId, 1))?.rows).toBe(1);
    const calls = s.sqlCalls();
    ensurePriceList(s.tenantId, 1);
    await Bun.sleep(50);
    expect(s.sqlCalls()).toBe(calls);
    setSystemTime(new Date(Date.now() + 24 * 3600_000 + 1));
    ensurePriceList(s.tenantId, 1);
    await until(() => s.sqlCalls() > calls);
    expect(s.sqlCalls()).toBeGreaterThan(calls);
    setSystemTime();
  });
});
