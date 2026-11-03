import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, assistantReport, configModel, configProject, sapConnection } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { auth } from "../src/auth.ts";
import { serve } from "../src/serve.ts";
import { Hono } from "hono";
import { storeResult } from "../src/reports/store.ts";
import { appendMessages, blankThread, listThreads, ownThread, releaseLease, takeLease, threadFor } from "../src/assistant/threads.ts";
import type { ReportResult } from "../src/reports/types.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// Reports' storage and router (reports spec §4, §6.1, §7): a report and its chat, the chat's own
// `set`, the live run, the home tiles and their company, delete under the chat's lease.

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
<edmx:DataServices><Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EntityType Name="Document"><Key><PropertyRef Name="DocEntry"/></Key>
    <Property Name="DocEntry" Type="Edm.Int32"/><Property Name="DocNum" Type="Edm.Int32"/>
    <Property Name="DocDate" Type="Edm.DateTime"/><Property Name="CardCode" Type="Edm.String"/>
    <Property Name="DocTotal" Type="Edm.Double"/>
  </EntityType>
  <EntityContainer Name="ServiceLayer"><EntitySet Name="Quotations" EntityType="SAPB1.Document"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

const DEF = {
  title: "Open quotations", subtitle: "All of them", assumptions: [],
  datasets: { q: { from: [{ source: "b1", entity: "Quotations" }] } },
  widgets: [{ kind: "kpi", title: "Value", value: { dataset: "q", agg: "sum", field: "DocTotal", label: "v", format: "money" } }],
};

describe.skipIf(!process.env.DATABASE_URL)("reports", () => {
  let agent: MockAgent;
  beforeAll(() => { agent = startMockAgent(); agent.metadata.xml = EDMX; });
  afterAll(() => agent.stop());

  async function world() {
    agent.store["Quotations#apply"] = [{ sum_DocTotal: 1234 }];
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser("member", tenantId);
    await connectTenant(tenantId, agent);
    const headers = tenantHeaders(slug, u.cookie);
    const staff = { context: { headers } };
    const r = await call(router.reports.create, {}, staff);
    const chat = { context: { headers, assistantThreadId: r.threadId } };
    return { tenantId, slug, u, headers, staff, chat, r };
  }
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));

  test("create reuses the blank report; its chat is never the user's general chat", async () => {
    const w = await world();
    expect((await call(router.reports.create, {}, w.staff)).id).toBe(w.r.id);
    expect((await blankThread(w.tenantId, w.u.userId)).id).not.toBe(w.r.threadId);
    expect((await threadFor(w.tenantId, w.u.userId, null)).id).not.toBe(w.r.threadId);
    expect((await ownThread(w.tenantId, w.u.userId, w.r.threadId)).reportId).toBe(w.r.id);
  });

  test("set is the chat's only: it stores the definition and its run and answers a summary", async () => {
    const w = await world();
    expect(await code(call(router.reports.set, { definition: DEF }, w.staff))).toBe("FORBIDDEN");
    const general = await blankThread(w.tenantId, w.u.userId);
    expect(await code(call(router.reports.set, { definition: DEF }, { context: { headers: w.headers, assistantThreadId: general.id } }))).toBe("FORBIDDEN");
    const out = await call(router.reports.set, { definition: DEF }, w.chat);
    expect(out.widgets).toEqual([{ kpi: "Value", value: 1234, compare: null }]);
    expect(JSON.stringify(out)).not.toContain("\"rows\":[");
    const got = await call(router.reports.get, { id: w.r.id }, w.staff);
    expect(got.title).toBe("Open quotations");
    expect(got.definition?.title).toBe("Open quotations");
    expect((got.lastResult as ReportResult).widgets).toHaveLength(1);
    // A new blank report is another one now: this one has a definition.
    expect((await call(router.reports.create, {}, w.staff)).id).not.toBe(w.r.id);
  });

  test("an invalid definition is BAD_REQUEST naming the problem", async () => {
    const w = await world();
    const bad = { ...DEF, widgets: [{ kind: "kpi", title: "x", value: { dataset: "q", agg: "sum", field: "DocTotl", label: "v" } }] };
    const e = await call(router.reports.set, { definition: bad }, w.chat).catch((x: { code: string; message: string }) => x);
    expect((e as { code: string }).code).toBe("BAD_REQUEST");
    expect((e as { message: string }).message).toContain("DocTotl is not a field of dataset q (did you mean DocTotal?)");
  });

  test("run reads live and stores it; another user's report is NOT_FOUND", async () => {
    const w = await world();
    expect(await code(call(router.reports.run, { id: w.r.id }, w.staff))).toBe("BAD_REQUEST"); // nothing drafted yet
    await call(router.reports.set, { definition: DEF }, w.chat);
    agent.store["Quotations#apply"] = [{ sum_DocTotal: 99 }];
    const live = await call(router.reports.run, { id: w.r.id }, w.staff);
    expect(live.widgets[0]).toMatchObject({ kind: "kpi", value: 99 });
    const colleague = await makeUser("member", w.tenantId);
    expect(await code(call(router.reports.get, { id: w.r.id }, { context: { headers: tenantHeaders(w.slug, colleague.cookie) } }))).toBe("NOT_FOUND");
  });

  test("tiles: saved only, headline from the first KPI, hidden after a company switch", async () => {
    const w = await world();
    await call(router.reports.set, { definition: DEF }, w.chat);
    expect(await call(router.reports.tiles, {}, w.staff)).toEqual([]);
    await call(router.reports.save, { id: w.r.id, saved: true }, w.staff);
    const [tile] = await call(router.reports.tiles, {}, w.staff);
    expect(tile).toMatchObject({ id: w.r.id, title: "Open quotations", subtitle: "All of them", value: 1234, format: "money" });
    await db.update(sapConnection).set({ companyDb: "OTHER" }).where(eq(sapConnection.tenantId, w.tenantId));
    const [after] = await call(router.reports.tiles, {}, w.staff);
    expect(after!.value).toBeNull();
  });

  test("delete mid-run is THREAD_BUSY; after, the report and its chat are gone", async () => {
    const w = await world();
    const lease = await takeLease(w.r.threadId);
    expect(await code(call(router.reports.delete, { id: w.r.id }, w.staff))).toBe("THREAD_BUSY");
    await releaseLease(w.r.threadId, lease);
    await call(router.reports.delete, { id: w.r.id }, w.staff);
    expect(await code(ownThread(w.tenantId, w.u.userId, w.r.threadId))).toBe("NOT_FOUND");
    expect(await db.select().from(assistantReport).where(eq(assistantReport.id, w.r.id))).toEqual([]);
  });

  test("the chat list names a report's chat by its report", async () => {
    const w = await world();
    await call(router.reports.set, { definition: DEF }, w.chat);
    await appendMessages(w.r.threadId, [{ role: "user", content: "open quotations" }]);
    const row = (await listThreads(w.tenantId, w.u.userId)).find((t) => t.id === w.r.threadId)!;
    expect(row).toMatchObject({ reportId: w.r.id, reportTitle: "Open quotations", projectId: null });
  });

  test("a Confire report reads this workspace's configurations, a client's draft never", async () => {
    const w = await world();
    const [m] = await db.insert(configModel).values({ tenantId: w.tenantId, name: "Cable", definition: TEST_MODEL }).returning({ id: configModel.id });
    const p = (o: Partial<typeof configProject.$inferInsert>) => ({ tenantId: w.tenantId, modelId: m!.id, name: "p", createdBy: w.u.userId, ...o });
    await db.insert(configProject).values([
      p({ status: "quoted", quotedValue: "100" }), p({ status: "quoted", quotedValue: "50" }),
      p({ status: "draft", portalCardCode: "C1", quotedValue: "1000" }),
    ]);
    const def = { ...DEF, datasets: { c: { from: [{ source: "confire", entity: "Configurations" }] } },
      widgets: [{ kind: "kpi", title: "Quoted", value: { dataset: "c", agg: "sum", field: "quotedValue", label: "q" } },
        { kind: "kpi", title: "All", value: { dataset: "c", agg: "count", label: "n" } }] };
    const out = await call(router.reports.set, { definition: def }, w.chat);
    expect(out.widgets).toEqual([{ kpi: "Quoted", value: 150, compare: null }, { kpi: "All", value: 2, compare: null }]);
  });

  test("a live run gets two minutes before Bun's idle timeout; other calls keep it", async () => {
    const app = serve({ auth, router, title: "t", routes: new Hono(), spaDist: "/nonexistent", port: 0, origin: "http://localhost" });
    const seen: number[] = [];
    const env = { timeout: (_r: Request, s: number) => { seen.push(s); } };
    await app.fetch(new Request("http://localhost/rpc/reports/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env as never);
    await app.fetch(new Request("http://localhost/rpc/reports/tiles", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env as never);
    expect(seen).toEqual([120]);
  });

  test("a run of an older definition never overwrites the newer one's result", async () => {
    const w = await world();
    await call(router.reports.set, { definition: DEF }, w.chat);
    const old = await call(router.reports.get, { id: w.r.id }, w.staff);
    agent.store["Quotations#apply"] = [{ sum_DocTotal: 7 }];
    await call(router.reports.set, { definition: { ...DEF, title: "Only Spain" } }, w.chat);
    await storeResult(w.r.id, old.lastResult!, old.definition!);
    const now = await call(router.reports.get, { id: w.r.id }, w.staff);
    expect(now.lastResult!.widgets[0]).toMatchObject({ value: 7 });
  });

  test("a report's chat never becomes a configuration's", async () => {
    const w = await world();
    const [m] = await db.insert(configModel).values({ tenantId: w.tenantId, name: "Cable", definition: TEST_MODEL }).returning({ id: configModel.id });
    expect(await code(call(router.assistant.start, { threadId: w.r.threadId, modelId: m!.id, name: "x", customer: null }, w.staff))).not.toBe("ok");
    expect((await ownThread(w.tenantId, w.u.userId, w.r.threadId)).projectId).toBeNull();
  });

  test("a rename stands when the chat changes the report", async () => {
    const w = await world();
    await call(router.reports.set, { definition: DEF }, w.chat);
    await call(router.reports.rename, { id: w.r.id, title: "My quotes" }, w.staff);
    await call(router.reports.set, { definition: { ...DEF, subtitle: "Spain" } }, w.chat);
    expect((await call(router.reports.get, { id: w.r.id }, w.staff)).title).toBe("My quotes");
  });

  test("a tile carries no good/bad colour: whether down is bad depends on the measure", async () => {
    const w = await world();
    const def = { ...DEF, widgets: [{ kind: "kpi", title: "v", value: { dataset: "q", agg: "sum", field: "DocTotal", label: "v" }, compare: { dataset: "q", agg: "sum", field: "DocTotal", label: "c" } }] };
    await call(router.reports.set, { definition: def }, w.chat);
    await call(router.reports.save, { id: w.r.id, saved: true }, w.staff);
    const [tile] = await call(router.reports.tiles, {}, w.staff);
    expect(tile).not.toHaveProperty("state");
  });
});
