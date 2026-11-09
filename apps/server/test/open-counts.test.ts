import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, sapCache } from "@confire/db";
import { countsOf, openCounts, OPEN_COUNTS_CODE, OPEN_COUNTS_SQL } from "../src/open-counts.ts";
import { makeTenant } from "./harness.ts";
import { connectTenant, startMockAgent } from "./mock-agent.ts";

test("rows by ObjType become counts by entity set; a set with no row is 0", () => {
  // HANA may upper-case the columns; the count may come back as a string.
  expect(countsOf([{ ObjType: "23", Cnt: 4 }, { OBJTYPE: "13", CNT: "7" }]))
    .toEqual({ Quotations: 4, Orders: 0, DeliveryNotes: 0, Invoices: 7 });
});

test("the query is one SELECT per table, no select *, and its code fits SAP's", () => {
  expect(OPEN_COUNTS_SQL.split(" UNION ")).toHaveLength(4);
  expect(OPEN_COUNTS_SQL).not.toContain("*");
  expect(OPEN_COUNTS_CODE).toMatch(/^CF_OC_[0-9a-f]{8}$/);
});

describe.skipIf(!process.env.DATABASE_URL)("openCounts", () => {
  const counts = { Quotations: 4, Orders: 0, DeliveryNotes: 0, Invoices: 0 };
  const setup = async () => {
    const agent = startMockAgent({ [`SQLQueries#${OPEN_COUNTS_CODE}`]: [{ ObjType: "23", Cnt: 4 }] });
    const { tenantId } = await makeTenant();
    await connectTenant(tenantId, agent);
    return { agent, tenantId };
  };
  afterAll(() => setSystemTime());

  test("the first read creates the stored query, counts, and keeps the answer in sap_cache", async () => {
    const { agent, tenantId } = await setup();
    try {
      expect(await openCounts(tenantId)).toEqual(counts);
      expect(agent.calls.filter((c) => c.route === "/create" && c.body.entitySet === "SQLQueries")).toHaveLength(1);
      const stored = await db.select().from(sapCache).where(and(eq(sapCache.tenantId, tenantId), eq(sapCache.kind, "open_counts")));
      expect(stored.map((r) => r.data)).toEqual([counts]);
      const sql = agent.calls.filter((c) => c.route === "/sql").length;
      expect(await openCounts(tenantId)).toEqual(counts);
      expect(agent.calls.filter((c) => c.route === "/sql")).toHaveLength(sql);
    } finally {
      agent.stop();
    }
  });

  test("a failed refresh serves the last counts of the same company", async () => {
    const { agent, tenantId } = await setup();
    try {
      await openCounts(tenantId);
      agent.stop();
      setSystemTime(new Date(Date.now() + 10 * 60_000 + 1));
      expect(await openCounts(tenantId)).toEqual(counts);
    } finally {
      setSystemTime();
    }
  });
});
