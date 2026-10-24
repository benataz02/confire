import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configMasterdata, configMasterdataRow, configModel, configProject, entityMeta, sapConnection } from "@confire/db";
import { adoptCompany, tenantConnector, viaB1 } from "../src/b1.ts";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { call, makePortalSeat, makePortalUser, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// A company switch made on the SAP server (spec 2026-10-21 §6.2): the agent refuses a call built for
// another company before it touches SAP, Confire adopts the agent's company once and drops the old
// one's caches, and a quotation stays tied to the company it was posted in.

let agent: MockAgent;
beforeAll(() => { agent = startMockAgent({}); });
afterAll(() => agent.stop());

const conn = async (tenantId: string) =>
  (await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1))[0]!;

describe("following a company switch", () => {
  test("a 409 adopts the agent's company once and clears the old company's caches", async () => {
    agent.company.db = "SBODEMO";
    const t = await makeTenant();
    await connectTenant(t.tenantId, agent);
    await db.update(sapConnection).set({ localCurrency: "EUR" }).where(eq(sapConnection.tenantId, t.tenantId));
    await db.insert(entityMeta).values({ tenantId: t.tenantId, entityName: "Items", json: { name: "Items", keys: [], fields: [], navigations: [] } as never });
    const [md] = await db.insert(configMasterdata).values({
      tenantId: t.tenantId, name: "items", kind: "query", syncedAt: new Date(), rowCount: 1,
      query: { target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"] },
    } as never).returning();
    await db.insert(configMasterdataRow).values({ tenantId: t.tenantId, masterdataId: md!.id, seq: 0, row: { ItemCode: "A" } });

    agent.company.db = "OTHER";
    const { b1 } = await tenantConnector(t.tenantId);
    // Three calls in flight when the switch lands: every one is refused, none reached the store.
    const before = agent.calls.length;
    const results = await Promise.allSettled([1, 2, 3].map(() => viaB1(() => b1.readEntitySet("Items"))));
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT", message: "SAP company changed to OTHER — try again." });
    expect(agent.calls.length).toBe(before);

    expect(await conn(t.tenantId)).toMatchObject({ companyDb: "OTHER", localCurrency: null });
    expect(await db.select().from(entityMeta).where(eq(entityMeta.tenantId, t.tenantId))).toEqual([]);
    expect(await db.select().from(configMasterdataRow).where(eq(configMasterdataRow.tenantId, t.tenantId))).toEqual([]);
    expect((await db.select().from(configMasterdata).where(eq(configMasterdata.id, md!.id)))[0]).toMatchObject({ syncedAt: null, rowCount: 0 });

    // The next call is built for the new company and goes through.
    await (await tenantConnector(t.tenantId)).b1.readEntitySet("Items");
    // Adopting is once, however many callers race for it.
    expect((await Promise.all([1, 2, 3].map(() => adoptCompany(t.tenantId, "THIRD")))).filter(Boolean)).toHaveLength(1);
  });

  test("a quotation stays in its company: elsewhere a re-quote creates; back home it patches", async () => {
    agent.company.db = "SBODEMO";
    const t = await makeTenant();
    await connectTenant(t.tenantId, agent);
    // A known currency, so drafting makes no SAP call of its own.
    await db.update(sapConnection).set({ localCurrency: "EUR" }).where(eq(sapConnection.tenantId, t.tenantId));
    const admin = await makeUser("admin", t.tenantId);
    const client = await makePortalUser();
    await makePortalSeat(t.tenantId, client.userId, "buyer");
    const [model] = await db.insert(configModel)
      .values({ tenantId: t.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true, portalPricing: "request" })
      .returning();
    const staff = { context: { headers: tenantHeaders(t.slug, admin.cookie) } };
    const portal = { context: { headers: tenantHeaders(t.slug, client.cookie) } };
    const switchTo = async (company: string) => {
      agent.company.db = company;
      expect(await call(router.sap.agentStatus, undefined, staff)).toMatchObject({ connected: true, companyDb: company });
    };
    const draft = () => call(router.configs.quoteDraft, { projectId: id }, staff);
    const post = async () => call(router.configs.createQuote, { projectId: id, commandId: (await draft()).commandId }, staff);
    const decline = () => call(portalRouter.projects.respondQuote, { id, accept: false }, portal);
    const project = async () => (await db.select().from(configProject).where(eq(configProject.id, id)))[0]!;

    const { id } = await call(portalRouter.projects.create, { modelId: model!.id, name: "Kabel" }, portal);
    await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, portal);
    await call(portalRouter.projects.submit, { id }, portal);
    await call(router.requests.accept, { id }, staff);
    const { project: calc } = await call(router.configs.calculate, { id }, staff);
    await call(router.configs.select, { projectId: id, selection: [{ candidateIdx: 0, batchQty: calc.candidates[0]!.perBatch[0]!.batchQty }] }, staff);

    const first = await post();
    expect(first.mode).toBe("created");
    expect(await project()).toMatchObject({ b1DocEntry: first.docEntry, b1Company: "SBODEMO" });
    await decline();

    // Elsewhere: no quotation to modify, no link on the page, no SAP chain on the timeline.
    await switchTo("OTHER");
    expect((await draft()).replaces).toBeNull();
    const page = await call(router.configs.get, { id }, staff);
    expect([page.sapCompany, page.project.b1Company]).toEqual(["OTHER", "SBODEMO"]);
    expect((await call(router.timeline.documents, { projectId: id }, staff)).quotations).toEqual([]);
    expect(await call(portalRouter.projects.quotation, { id }, portal)).toBeNull();

    // Home again: the same quotation is patched in place.
    await switchTo("SBODEMO");
    expect((await draft()).replaces).toEqual({ docEntry: first.docEntry });
    expect(await post()).toMatchObject({ mode: "updated", docEntry: first.docEntry });
    await decline();

    // A switch while a re-quote is on its way: refused before SAP, then a new quotation in the new one.
    // (Each adoption cleared the currency; with it unknown, drafting would read SAP and learn first.)
    await db.update(sapConnection).set({ localCurrency: "EUR" }).where(eq(sapConnection.tenantId, t.tenantId));
    agent.company.db = "OTHER";
    const updates = agent.calls.filter((c) => c.route === "/update").length;
    const stale = await draft(); // still believes SBODEMO: no SAP call to find out otherwise
    expect(stale.replaces).toEqual({ docEntry: first.docEntry });
    await expect(call(router.configs.createQuote, { projectId: id, commandId: stale.commandId }, staff))
      .rejects.toMatchObject({ code: "CONFLICT", message: "SAP company changed to OTHER — try again." });
    const second = await post();
    expect(second.mode).toBe("created");
    expect(second.docEntry).not.toBe(first.docEntry);
    expect(agent.calls.filter((c) => c.route === "/update").length).toBe(updates);
    expect(await project()).toMatchObject({ b1DocEntry: second.docEntry, b1Company: "OTHER" });
    // Each company's timeline names its own quotation only.
    expect((await call(router.timeline.documents, { projectId: id }, staff)).quotations.map((q) => q.quotation.docEntry))
      .toEqual([second.docEntry]);
  });
});
