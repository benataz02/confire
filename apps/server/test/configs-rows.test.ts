import { expect, test } from "bun:test";
import { db, configModel, configProject, configProjectEvent, sapConnection } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

const NO_QUERY = { select: [], filter: [], orderby: [] };

// The list's Quotation column: the DocNum the latest `quoted` event read, linked by DocEntry, and
// only while the quotation is in the connected company.
test("configs.rows carries the customer code and the current quotation of the connected company", async () => {
  const t = await makeTenant();
  await db.insert(sapConnection).values({ tenantId: t.tenantId, agentUrl: "http://x", secret: "s", companyDb: "SBODEMO" });
  const admin = await makeUser("admin", t.tenantId);
  const staff = { context: { headers: tenantHeaders(t.slug, admin.cookie) } };
  const [model] = await db.insert(configModel).values({ tenantId: t.tenantId, name: "M", definition: TEST_MODEL }).returning();
  const quote = (b1Company: string) => ({
    tenantId: t.tenantId, modelId: model!.id, name: b1Company, createdBy: admin.userId, status: "quoted" as const,
    customer: { cardCode: "C1", cardName: "Kunde" }, b1DocEntry: 7, b1Company,
  });
  const [here, there] = await db.insert(configProject).values([quote("SBODEMO"), quote("OTHER")]).returning();
  const quoted = (projectId: string, docNum: number | null, at: string) => ({
    tenantId: t.tenantId, projectId, kind: "quoted" as const, actorSide: "internal" as const, at: new Date(at),
    payload: { docEntry: 7, docNum, value: 1, mode: "created" as const, inputs: { entries: {}, batches: [], tables: {} } },
  });
  await db.insert(configProjectEvent).values([
    quoted(here!.id, 1001, "2026-01-01"), quoted(here!.id, null, "2026-01-02"), quoted(there!.id, 2002, "2026-01-01"),
  ]);

  const { rows } = await call(router.configs.rows, { query: NO_QUERY, top: 10 }, staff);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName.SBODEMO).toMatchObject({ cardCode: "C1", quoteDocEntry: 7, quoteDocNum: 1001 });
  expect(byName.OTHER).toMatchObject({ cardCode: "C1", quoteDocEntry: null, quoteDocNum: null });

  const filtered = await call(router.configs.rows, { query: { ...NO_QUERY, filter: [{ field: "quoteDocNum", op: "eq", value: 1001 }] }, top: 10 }, staff);
  expect(filtered.rows.map((r) => r.name)).toEqual(["SBODEMO"]);
});
