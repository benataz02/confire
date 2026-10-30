import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configModel, configProject, entityMeta } from "@confire/db";
import { requireAdmin } from "../src/orpc/base.ts";
import { GENERAL, PAGES, pageFor } from "../src/assistant/pages.ts";
import { CARD_FIELDS, LIST_CAP, missingSources, procedureOf, toolsFor, type ToolCtx } from "../src/assistant/tools.ts";
import { newThread } from "../src/assistant/threads.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The chat's tools (spec §4.3, §4.5): the existing procedures, run through their own builders with
// the request's headers, picked per page. The route is a hint; the builders are the permission.

const CHAT = { chat: "make it 200 wide" };
const NO_QUERY = { select: [], filter: [], orderby: [] };

test("registry: a configuration page configures; unknown routes get the general set", () => {
  expect(pageFor("/$slug/configs/$id").tools).toContain("configs_calculate");
  expect(pageFor("/$slug/configs/$id").kind).toBe("configure");
  expect(pageFor("/$slug/models/$id").kind).toBe("model");
  expect(pageFor("/$slug/whatever").kind).toBe("general");
  expect(pageFor("/$slug/whatever")).toBe(GENERAL);
  // The AI page: the general set to start one, for the bare page and a chat alike (`$id` is the chat;
  // the route makes a configuration's chat CONFIGURE_CHAT).
  expect(pageFor("/$slug/assistant/").tools).toContain("configs_create");
  expect(pageFor("/$slug/assistant/$id").kind).toBe("general");
});

test("no tool posts, and no tool is admin-only", () => {
  for (const page of [...Object.values(PAGES), GENERAL]) {
    expect(page.tools).not.toContain("configs_createQuote");
    for (const name of page.tools) {
      const p = procedureOf(name);
      expect(p?.["~orpc"].orderedMiddlewares.some((m) => m.middleware === requireAdmin) ?? false).toBe(false);
    }
  }
  // the check itself can see an admin procedure
  expect(router.assistant.settings["~orpc"].orderedMiddlewares.some((m) => m.middleware === requireAdmin)).toBe(true);
});

test("every page re-runs the intake steps and may ask: its history may hold their calls", () => {
  for (const page of [...Object.values(PAGES), GENERAL]) expect(page.tools).toEqual(expect.arrayContaining(["read_request", "extract_values", "ask_user"]));
});

test("missingSources names every unsourced write", () => {
  const id = crypto.randomUUID();
  expect(missingSources({ id, set: { a: 1, b: 2 }, batches: [5], sources: { a: CHAT } })).toEqual(["b", "batches"]);
  expect(missingSources({ id, tables: { holes: [] }, customer: { cardCode: "C1", cardName: "Acme" }, sources: {} })).toEqual(["holes", "customer"]);
  expect(missingSources({ id, unset: ["a"], name: "x", sources: {} })).toEqual([]);
});

describe.skipIf(!process.env.DATABASE_URL)("through the builders", () => {
  let agent: MockAgent;
  beforeAll(() => { agent = startMockAgent({ Quotations: [{ DocEntry: 7, DocNum: 1007, CardCode: "C1", CardName: "ACME", DocTotal: 10, DocCurrency: "EUR", DocDate: "2026-10-01", DocumentStatus: "bost_Open" }] }); });
  afterAll(() => agent.stop());

  async function world() {
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser("member", tenantId);
    const [m] = await db.insert(configModel).values({ tenantId, name: "Cable", definition: TEST_MODEL }).returning({ id: configModel.id });
    const headers = tenantHeaders(slug, u.cookie);
    const { id } = await call(router.configs.create, { modelId: m!.id, name: "Cable", customer: null }, { context: { headers } });
    const thread = await newThread(tenantId, u.userId);
    const ctx: ToolCtx = { headers, tenantId, userId: u.userId, thread, meter: { tenantId, userId: u.userId, threadId: thread.id, projectId: null, kind: "chat" } };
    const tool = (name: string, c = ctx) => {
      const t = toolsFor({ ...GENERAL, tools: [name] }, c)[0]!;
      return (input: unknown) => (t as unknown as { execute: (i: unknown) => Promise<any> }).execute(input);
    };
    return { tenantId, slug, u, modelId: m!.id, id, ctx, tool };
  }

  test("a tool with a forged x-tenant is refused", async () => {
    const w = await world();
    const other = await makeTenant();
    const forged = { ...w.ctx, headers: tenantHeaders(other.slug, w.u.cookie) };
    await expect(w.tool("configs_rows", forged)({ query: NO_QUERY })).rejects.toThrow("Not a member of this workspace");
  });

  test("configs_calculate without sources is refused back to the model, nothing written", async () => {
    const w = await world();
    const calc = w.tool("configs_calculate");
    await expect(calc({ id: w.id, set: { material: "steel" }, sources: {} })).rejects.toThrow("material");
    expect((await db.select().from(configProject).where(eq(configProject.id, w.id)))[0]!.entries).toEqual({});
    const v = await calc({ id: w.id, set: { material: "steel" }, sources: { material: CHAT } });
    expect(v.project.sources).toEqual({ material: { value: "steel", source: CHAT } });
  });

  test("every tool's procedure has at most one input schema", () => {
    for (const name of new Set([...Object.values(PAGES), GENERAL].flatMap((p) => p.tools)))
      expect(procedureOf(name)?.["~orpc"].inputSchemas?.length ?? 0).toBeLessThanOrEqual(1);
  });

  test("list tools answer at most 20 rows and the total", async () => {
    const w = await world();
    for (let i = 0; i < 24; i++) await call(router.configs.create, { modelId: w.modelId, name: `C${i}`, customer: null }, { context: { headers: w.ctx.headers } });
    const out = await w.tool("configs_rows")({ query: NO_QUERY, top: 500 });
    expect(out.rows).toHaveLength(LIST_CAP);
    expect(out.total).toBe(25);

    await connectTenant(w.tenantId, agent);
    await db.insert(entityMeta).values({
      tenantId: w.tenantId, entityName: "Quotations",
      json: {
        name: "Quotations", entityType: "Document", table: "OQUT", label: "Sales Quotations", entityClass: "document" as never, keys: ["DocEntry"],
        fields: CARD_FIELDS.Quotations.map((name) => ({ name, kind: name.startsWith("Doc") && name !== "DocCurrency" && name !== "DocDate" ? "number" : "string", edmType: "Edm.String" })) as never,
      },
    });
    const docs = await w.tool("entities_rows")({ entity: "Quotations", query: { ...NO_QUERY, select: ["DocNum"] } });
    expect(docs.rows).toHaveLength(1);
    const sent = agent.calls.filter((c) => c.route === "/entity-set").at(-1)!.body as { query: { select: string[] } };
    expect(sent.query.select).toEqual(expect.arrayContaining(CARD_FIELDS.Quotations));

    // Business partners are a configuration's customers: suppliers never reach the chat, whatever it asks.
    await db.insert(entityMeta).values({
      tenantId: w.tenantId, entityName: "BusinessPartners",
      json: {
        name: "BusinessPartners", entityType: "BusinessPartner", table: "OCRD", label: "Business Partners", entityClass: "master" as never, keys: ["CardCode"],
        fields: CARD_FIELDS.BusinessPartners.map((name) => ({ name, kind: "string", edmType: "Edm.String" })) as never,
      },
    });
    await w.tool("entities_rows")({ entity: "BusinessPartners", query: { ...NO_QUERY, filter: [{ field: "CardName", op: "contains", value: "caf" }] } });
    const bp = agent.calls.filter((c) => c.route === "/entity-set").at(-1)!.body as { query: { filter: string } };
    expect(bp.query.filter).toContain("CardType eq 'cCustomer'");
  });

  test("configs_get leaves the model definition out", async () => {
    const w = await world();
    const v = await w.tool("configs_get")({ id: w.id });
    expect(v.model).toMatchObject({ id: w.modelId, name: "Cable" });
    expect(v.model.definition).toBeUndefined();
  });
});
