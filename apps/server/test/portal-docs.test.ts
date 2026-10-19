import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, configModel, configProjectEvent, entityMeta } from "@confire/db";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { readRows } from "../src/entity-read.ts";
import { savePortalSettings } from "../src/portal/settings.ts";
import {
  call, insertSeat, makePortalSeat, makePortalUser, makeTenant, makeUser, tenantHeaders, TEST_MODEL,
} from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// Portal documents (spec §13.1): the admin's field settings, and the client's fenced reads of its
// own quotations, orders, deliveries and invoices.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const NO_QUERY = { select: [], filter: [], orderby: [] };

const f = (name: string, kind: B1Field["kind"] = "string"): B1Field => ({ name, kind, edmType: kind === "number" ? "Edm.Int32" : "Edm.String" });

/** A marketing document's schema, as entity_meta caches it: enough fields to see the fence work. */
const fixtureSchema = (name: string): B1EntitySchema => ({
  name, label: name, keys: ["DocEntry"],
  fields: [
    f("DocEntry", "number"), f("DocNum", "number"), f("DocDate", "date"), f("DocumentStatus", "enum"), f("DocTotal", "number"),
    f("DocCurrency"), f("DocDueDate", "date"), f("NumAtCard"), f("Comments"), f("CardCode"), f("GrossProfit", "number"),
    {
      ...f("DocumentLines", "collection"),
      fields: [f("ItemCode"), f("ItemDescription"), f("Quantity", "number"), f("UnitPrice", "number"), f("LineTotal", "number"),
        f("GrossBuyPrice", "number"), f("BaseType", "number"), f("BaseEntry", "number")],
    },
  ],
});

/** A cached schema is read from Postgres before any agent call (entity-meta.ts), so seeding it is
 *  the whole $metadata setup. Settings → Portal also reads BusinessPartners (the onboarding extras). */
async function seedDocSchemas(tenantId: string) {
  for (const name of ["Quotations", "Orders", "DeliveryNotes", "Invoices"])
    await db.insert(entityMeta).values({ tenantId, entityName: name, json: fixtureSchema(name), fetchedAt: new Date() });
  await db.insert(entityMeta).values({
    tenantId, entityName: "BusinessPartners", fetchedAt: new Date(),
    json: { name: "BusinessPartners", label: "Business partners", keys: ["CardCode"], fields: [f("CardCode"), f("CardName")] },
  });
}

let agent: MockAgent;
beforeAll(() => { agent = startMockAgent({}); });
afterAll(() => agent.stop());

async function setup() {
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  await seedDocSchemas(t.tenantId);
  const admin = await makeUser("admin", t.tenantId);
  const member = await makeUser("member", t.tenantId);
  return {
    ...t,
    adminCtx: { context: { headers: tenantHeaders(t.slug, admin.cookie) } },
    memberCtx: { context: { headers: tenantHeaders(t.slug, member.cookie) } },
  };
}

describe("portal settings: document fields", () => {
  test("admin reads options without ALWAYS/NEVER/denied and the code defaults", async () => {
    const s = await setup();
    const r = await call(router.portalSettings.get, undefined, s.adminCtx);
    expect(r.defaults).toEqual({ header: ["DocDueDate", "NumAtCard"], lines: ["ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"] });
    expect(r.options.Orders.header.map((o) => o.key)).toEqual(["DocDueDate", "NumAtCard", "Comments"]);
    expect(r.options.Invoices.lines.map((o) => o.key)).not.toContain("GrossBuyPrice");
    expect(r.options.Invoices.lines[0]).toEqual({ key: "ItemCode", label: "ItemCode" });
    expect(r.docFields).toEqual({});
  });

  test("save refuses a denied field and stores a valid one", async () => {
    const s = await setup();
    expect(await codeOf(call(router.portalSettings.save, { docFields: { Orders: { header: [], lines: ["GrossBuyPrice"] } } }, s.adminCtx))).toBe("BAD_REQUEST");
    expect(await codeOf(call(router.portalSettings.save, { docFields: { Orders: { header: ["CardCode"], lines: [] } } }, s.adminCtx))).toBe("BAD_REQUEST");
    await call(router.portalSettings.save, { docFields: { Orders: { header: ["NumAtCard"], lines: ["ItemCode"] } } }, s.adminCtx);
    expect((await call(router.portalSettings.get, undefined, s.adminCtx)).docFields).toEqual({ Orders: { header: ["NumAtCard"], lines: ["ItemCode"] } });
  });

  test("get drops names a stored setting kept but pickable no longer offers, so the next save heals it", async () => {
    const s = await setup();
    // A UDF removed from B1, and a field denied after the admin picked it.
    await savePortalSettings(s.tenantId, { docFields: { Orders: { header: ["U_Gone", "NumAtCard", "GrossProfit"], lines: ["ItemCode", "GrossBuyPrice"] } } });
    const r = await call(router.portalSettings.get, undefined, s.adminCtx);
    expect(r.docFields).toEqual({ Orders: { header: ["NumAtCard"], lines: ["ItemCode"] } });
    // What the page sends back from that draft saves.
    await call(router.portalSettings.save, { docFields: r.docFields }, s.adminCtx);
  });

  test("a plain member cannot read or write portal settings", async () => {
    const s = await setup();
    expect(await codeOf(call(router.portalSettings.get, undefined, s.memberCtx))).toBe("FORBIDDEN");
    expect(await codeOf(call(router.portalSettings.save, { docFields: {} }, s.memberCtx))).toBe("FORBIDDEN");
  });
});

/** Two client companies on one tenant, A's documents chained quotation → order → delivery → invoice,
 *  and a project of A's whose `quoted` event names the quotation. */
async function clientSetup() {
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  await seedDocSchemas(t.tenantId);
  const ua = await makePortalUser();
  const ub = await makePortalUser();
  const A = await makePortalSeat(t.tenantId, ua.userId, "viewer");
  const B = await makePortalSeat(t.tenantId, ub.userId, "buyer");
  Object.assign(agent.store, {
    Quotations: [
      { DocEntry: 1, DocNum: 101, CardCode: A.cardCode, DocTotal: 10, GrossProfit: 3, DocumentLines: [{ ItemCode: "X", GrossBuyPrice: 5, LineTotal: 10 }] },
      { DocEntry: 2, DocNum: 102, CardCode: B.cardCode },
    ],
    Orders: [{ DocEntry: 7, CardCode: A.cardCode, DocumentLines: [{ BaseType: 23, BaseEntry: 1 }] }],
    DeliveryNotes: [{ DocEntry: 8, CardCode: A.cardCode, DocumentLines: [{ BaseType: 17, BaseEntry: 7 }] }],
    Invoices: [{ DocEntry: 9, CardCode: A.cardCode, DocumentLines: [{ BaseType: 15, BaseEntry: 8 }] }],
  });
  const portalA = { context: { headers: tenantHeaders(t.slug, ua.cookie) } };
  const portalB = { context: { headers: tenantHeaders(t.slug, ub.cookie) } };
  // A buyer of A's creates the project; the viewer above reads documents (any seat may).
  const buyer = await makePortalUser();
  await insertSeat(t.tenantId, A.id, buyer.userId, "buyer");
  const [model] = await db.insert(configModel)
    .values({ tenantId: t.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true, portalPricing: "request" }).returning();
  const { id: projectId } = await call(portalRouter.projects.create, { modelId: model!.id, name: "Kabel 1" },
    { context: { headers: tenantHeaders(t.slug, buyer.cookie) } });
  await db.insert(configProjectEvent).values({
    tenantId: t.tenantId, projectId, kind: "quoted", actorSide: "internal",
    payload: { docEntry: 1, docNum: 101, value: 10, mode: "created", inputs: { entries: {}, batches: [], tables: {} } },
  });
  return { ...t, A, B, portalA, portalB, projectId };
}

describe("portal documents", () => {
  test("metadata is the cut schema, read-only", async () => {
    const s = await clientSetup();
    const m = await call(portalRouter.docs.metadata, { entity: "Quotations" }, s.portalA);
    expect(Object.keys(m.fields)).not.toContain("CardCode");
    expect(Object.keys(m.fields)).not.toContain("GrossProfit");
    expect(Object.keys(m.fields.DocumentLines!.Fields!)).not.toContain("GrossBuyPrice");
    expect(m.writable).toBe(false);
    expect(m.printable).toBe(true);
  });

  test("rows are fenced to the company and cut to the schema", async () => {
    const s = await clientSetup();
    const r = await call(portalRouter.docs.rows, { entity: "Quotations", query: NO_QUERY, count: true }, s.portalA);
    expect(agent.calls.at(-1)!.body.query.filter).toBe(`CardCode eq '${s.A.cardCode}'`);
    expect(r.rows.map((x) => x.DocEntry)).toEqual([1]);
    expect(JSON.stringify(r.rows)).not.toContain("GrossProfit");
    expect(JSON.stringify(r.rows)).not.toContain("CardCode");
  });

  test("a cursor sealed for company A is refused for company B", async () => {
    const s = await clientSetup();
    const fake = { readEntitySet: async () => ({ status: 200, data: { value: [], "@odata.nextLink": "Quotations?$skip=20" } }) } as never;
    const { nextCursor } = await readRows(fake, fixtureSchema("Quotations"), "Quotations", { query: NO_QUERY, pageSize: 20 },
      { tenantId: s.tenantId, key: `portal:${s.A.id}` });
    expect(nextCursor).toBeString();
    expect(await codeOf(call(portalRouter.docs.rows, { entity: "Quotations", query: NO_QUERY, cursor: nextCursor }, s.portalB))).toBe("BAD_REQUEST");
  });

  test("one/print/project refuse another company's document", async () => {
    const s = await clientSetup();
    expect(await Promise.all([
      codeOf(call(portalRouter.docs.one, { entity: "Quotations", key: 2 }, s.portalA)),
      codeOf(call(portalRouter.docs.print, { entity: "Quotations", docEntry: 2 }, s.portalA)),
      codeOf(call(portalRouter.docs.project, { entity: "Quotations", docEntry: 2 }, s.portalA)),
    ])).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    // The PDF is never rendered: the check comes before the agent's /print.
    expect(agent.calls.some((c) => c.route === "/print" && c.body.docEntry === 2)).toBe(false);
  });

  test("one is cut to the schema; print renders after the check", async () => {
    const s = await clientSetup();
    const { row, etag } = await call(portalRouter.docs.one, { entity: "Quotations", key: 1 }, s.portalA);
    expect(row).toMatchObject({ DocEntry: 1, DocNum: 101, DocumentLines: [{ ItemCode: "X", LineTotal: 10 }] });
    expect(JSON.stringify(row)).not.toMatch(/CardCode|GrossProfit|GrossBuyPrice/);
    expect(etag).toBeNull();
    expect((await call(portalRouter.docs.print, { entity: "Quotations", docEntry: 1 }, s.portalA)).fileName).toBe("Quotations-1.pdf");
  });

  test("project walks back to the quotation from every document type", async () => {
    const s = await clientSetup();
    for (const [entity, docEntry] of [["Quotations", 1], ["Orders", 7], ["DeliveryNotes", 8], ["Invoices", 9]] as const)
      expect(await call(portalRouter.docs.project, { entity, docEntry }, s.portalA)).toEqual({ id: s.projectId, name: "Kabel 1" });
  });

  test("a document of the company's that no project quoted has no project", async () => {
    const s = await clientSetup();
    agent.store.Orders!.push({ DocEntry: 70, CardCode: s.A.cardCode, DocumentLines: [{ BaseType: -1, BaseEntry: null }] });
    expect(await call(portalRouter.docs.project, { entity: "Orders", docEntry: 70 }, s.portalA)).toBeNull();
  });

  test("a stale setting naming a denied field never reaches the client", async () => {
    const s = await clientSetup();
    await savePortalSettings(s.tenantId, { docFields: { Quotations: { header: ["GrossProfit"], lines: ["GrossBuyPrice"] } } });
    const m = await call(portalRouter.docs.metadata, { entity: "Quotations" }, s.portalA);
    expect(JSON.stringify(m)).not.toMatch(/GrossProfit|GrossBuyPrice/);
    const { row } = await call(portalRouter.docs.one, { entity: "Quotations", key: 1 }, s.portalA);
    expect(JSON.stringify(row)).not.toMatch(/GrossProfit|GrossBuyPrice/);
  });

  test("an entity outside the four is refused before SAP", async () => {
    const s = await clientSetup();
    const before = agent.calls.length;
    expect(await codeOf(call(portalRouter.docs.rows, { entity: "BusinessPartners" as never, query: NO_QUERY }, s.portalA))).toBe("BAD_REQUEST");
    expect(agent.calls.length).toBe(before);
  });
});
