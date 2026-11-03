import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, assistantFile, assistantSettings, assistantThread, configModel, configProject, entityMeta } from "@confire/db";
import type { ModelMessage } from "@tanstack/ai";
import { router } from "../src/orpc/router.ts";
import { tenantConnector } from "../src/b1.ts";
import { entitySchema } from "../src/entity-meta.ts";
import { closestNames, postWrite, prepareWrite } from "../src/entity-write.ts";
import { CHAT_TOOLS } from "../src/assistant/pages.ts";
import { procedureOf } from "../src/assistant/tools.ts";
import { proposed } from "../src/assistant/route.ts";
import { appendMessages, newThread } from "../src/assistant/threads.ts";
import { AUTO_WRITE_KEY, readsClientContent } from "../src/assistant/auto.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The SAP tools (b1-tools spec §8): one write core under two field rules, strict names on b1.read, the
// read scope, auto mode and its exceptions, post's ETag, and an old Service Layer's one $metadata.

// A Service Layer before FP2608 answers every $metadata read with the whole document, whatever it
// asked for: this one holds three entity sets.
const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
<edmx:DataServices><Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EnumType Name="BoStatus"><Member Name="bost_Open" Value="0"/><Member Name="bost_Close" Value="1"/></EnumType>
  <ComplexType Name="DocumentLine">
    <Property Name="LineNum" Type="Edm.Int32"/><Property Name="ItemCode" Type="Edm.String"/>
    <Property Name="Quantity" Type="Edm.Double"/><Property Name="Price" Type="Edm.Double"/>
  </ComplexType>
  <EntityType Name="Document"><Key><PropertyRef Name="DocEntry"/></Key>
    <Property Name="DocEntry" Type="Edm.Int32"/><Property Name="DocNum" Type="Edm.Int32"/>
    <Property Name="CardCode" Type="Edm.String"/><Property Name="CardName" Type="Edm.String"/>
    <Property Name="Comments" Type="Edm.String"/><Property Name="ShipToCode" Type="Edm.String"/>
    <Property Name="DocTotal" Type="Edm.Double"/><Property Name="DocumentStatus" Type="SAPB1.BoStatus"/>
    <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
  </EntityType>
  <EntityType Name="EmployeeInfo"><Key><PropertyRef Name="EmployeeID"/></Key>
    <Property Name="EmployeeID" Type="Edm.Int32"/><Property Name="LastName" Type="Edm.String"/>
  </EntityType>
  <EntityContainer Name="ServiceLayer">
    <EntitySet Name="Orders" EntityType="SAPB1.Document"/>
    <EntitySet Name="Quotations" EntityType="SAPB1.Document"/>
    <EntitySet Name="Invoices" EntityType="SAPB1.Document"/>
    <EntitySet Name="EmployeesInfo" EntityType="SAPB1.EmployeeInfo"/>
  </EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

const order = () => ({
  DocEntry: 5, DocNum: 905, CardCode: "C1", CardName: "ACME", Comments: "old", DocTotal: 10, DocumentStatus: "bost_Open",
  "@odata.etag": 'W/"1"', DocumentLines: [{ LineNum: 0, ItemCode: "A", Quantity: 2, Price: 5 }],
});

test("closest names: another case first, then names it is part of", () => {
  const names = ["CardCode", "CardName", "DocTotal", "DocDate", "Comments"];
  expect(closestNames("cardcode", names)).toEqual(["CardCode"]);
  expect(closestNames("Card", names)).toEqual(["CardCode", "CardName"]);
  expect(closestNames("DocTotl", names)).toEqual(["DocTotal"]);
});

test("a proposal of a SAP write ends the run; a written answer or another tool does not", () => {
  const turn = (name: string, out: unknown): ModelMessage[] => [
    { role: "user", content: "go" },
    { role: "assistant", content: null, toolCalls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", toolCallId: "c1", content: JSON.stringify(out) },
  ];
  expect(proposed(turn("b1_write", { proposal: { op: "create" } }))).toBe(true);
  expect(proposed(turn("b1_copy", { proposal: { op: "copy" } }))).toBe(true);
  expect(proposed(turn("b1_write", { written: { entity: "Orders" } }))).toBe(false);
  expect(proposed(turn("b1_read", { proposal: 1 }))).toBe(false);
});

test("the chat's one tool set reaches SAP but never b1.post", () => {
  for (const name of CHAT_TOOLS) expect(procedureOf(name)).not.toBe(router.b1.post);
  expect(CHAT_TOOLS).toEqual(expect.arrayContaining(["b1_find", "b1_schema", "b1_read", "b1_write", "b1_copy"]));
});

describe.skipIf(!process.env.DATABASE_URL)("b1 tools", () => {
  let agent: MockAgent;
  beforeAll(() => { agent = startMockAgent(); agent.metadata.xml = EDMX; });
  afterAll(() => agent.stop());

  async function world(role: "member" | "admin" = "member") {
    agent.store.Orders = [order()];
    agent.store.Invoices = [];
    agent.store.EmployeesInfo = [{ EmployeeID: 1, LastName: "Doe" }];
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser(role, tenantId);
    await connectTenant(tenantId, agent);
    const headers = tenantHeaders(slug, u.cookie);
    return { tenantId, slug, u, headers, staff: { context: { headers } } };
  }
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code ?? String(e));
  const message = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
  const autoOn = async (w: Awaited<ReturnType<typeof world>>, user = true) => {
    await db.insert(assistantSettings).values({ tenantId: w.tenantId, assistant: true, b1AutoWrite: true })
      .onConflictDoUpdate({ target: assistantSettings.tenantId, set: { b1AutoWrite: true } });
    if (user) await call(router.views.setState, { key: AUTO_WRITE_KEY, value: true }, w.staff);
  };

  test("an old Service Layer's full document stores every schema; a second entity costs no agent call", async () => {
    const w = await world();
    const b1 = (await tenantConnector(w.tenantId)).b1;
    const metadataCalls = () => agent.calls.filter((c) => c.route === "/metadata").length;
    const before = metadataCalls();
    expect((await entitySchema(w.tenantId, b1, "Orders")).keys).toEqual(["DocEntry"]);
    const stored = await db.select({ name: entityMeta.entityName }).from(entityMeta).where(eq(entityMeta.tenantId, w.tenantId));
    expect(stored.map((r) => r.name).sort()).toEqual(["EmployeesInfo", "Invoices", "Orders", "Quotations"]);
    const after = metadataCalls(); // the entity list and the schema read
    expect((await entitySchema(w.tenantId, b1, "Invoices")).name).toBe("Invoices");
    expect(metadataCalls()).toBe(after);
    expect(after - before).toBe(2);
  });

  test("the write core: the profile rule refuses a non-profile field, the schema rule takes it and refuses a misspelling", async () => {
    const w = await world();
    const c = { tenantId: w.tenantId, b1: (await tenantConnector(w.tenantId)).b1 };
    const upd = (data: Record<string, unknown>) => ({ op: "update" as const, entity: "Orders", key: 5, etag: 'W/"1"', data });
    expect(await message(prepareWrite(c, "profile", upd({ ShipToCode: "S1" })))).toContain("ShipToCode");
    const p = await prepareWrite(c, "schema", upd({ ShipToCode: "S1" }));
    expect(p).toMatchObject({ op: "update", payload: { ShipToCode: "S1" } });
    const wrong = await message(prepareWrite(c, "schema", upd({ ShiptoCode: "S1", DocumentLines: [{ LineNum: 0, Qty: 3 }] })));
    expect(wrong).toContain("ShiptoCode (did you mean ShipToCode?)");
    expect(wrong).toContain("DocumentLines.Qty");
    for (const rule of ["profile", "schema"] as const)
      expect(await code(prepareWrite(c, rule, { op: "create", entity: "Invoices", data: { CardCode: "C1" } }))).toBe("FORBIDDEN");
    // The pages' procedure is unchanged: profile fields only.
    expect(await code(call(router.entities.update, { entity: "Orders", key: 5, etag: 'W/"1"', data: { ShipToCode: "S1" } }, w.staff))).toBe("BAD_REQUEST");
    const ok = await call(router.entities.update, { entity: "Orders", key: 5, etag: 'W/"1"', data: { Comments: "page" } }, w.staff);
    expect(ok.row.Comments).toBe("page");
    expect(ok.etag).not.toBe('W/"1"');
    await postWrite(c, await prepareWrite(c, "schema", { ...upd({ ShipToCode: "S2" }), etag: ok.etag! }));
    expect(agent.store.Orders![0]!.ShipToCode).toBe("S2");
  });

  test("b1.read: a misspelled select, filter or orderby name is refused with suggestions; rows are capped", async () => {
    const w = await world();
    const read = (query: Record<string, unknown>) => call(router.b1.read, { entity: "Orders", query }, w.staff);
    expect(await message(read({ select: ["DocNumber"] }))).toContain("DocNumber (did you mean DocNum?)");
    expect(await message(read({ filter: [{ field: "cardcode", op: "eq", value: "C1" }] }))).toContain("cardcode (did you mean CardCode?)");
    expect(await message(read({ orderby: [{ field: "Total", dir: "desc" }] }))).toContain("DocTotal");
    // A filter on a collection is no scalar filter: refused too.
    expect(await code(read({ filter: [{ field: "DocumentLines", op: "eq", value: 1 }] }))).toBe("BAD_REQUEST");

    agent.store.Orders = Array.from({ length: 25 }, (_, i) => ({ ...order(), DocEntry: i + 1 }));
    const page = await read({});
    expect(page.rows).toHaveLength(20);
    const sent = agent.calls.filter((c) => c.route === "/entity-set").at(-1)!.body as { query: { select?: string[] } };
    // An empty select must not name every scalar: that $select exceeds the Service Layer query-string limit.
    expect(sent.query.select).toBeUndefined();
    expect(page.rows[0]).not.toHaveProperty("DocumentLines");
    expect(page.rows[0]).toMatchObject({ DocEntry: 1, DocNum: 905 });
    // Named scalar fields: narrow rows, all 25 in one request.
    const before = agent.calls.length;
    expect((await read({ select: ["DocNum"] })).rows).toHaveLength(25);
    expect(agent.calls.length - before).toBe(1);

    // A collection named: whole rows read (B1 refuses some collections in $select), then projected.
    const lines = await read({ select: ["DocNum", "DocumentLines"] });
    const sentLines = agent.calls.filter((c) => c.route === "/entity-set").at(-1)!.body as { query: { select?: string[] } };
    expect(sentLines.query.select).toBeUndefined();
    expect(Object.keys(lines.rows[0]!).sort()).toEqual(["DocEntry", "DocNum", "DocumentLines"]);
    expect((await call(router.b1.read, { entity: "Orders", key: 3 }, w.staff)).row).toMatchObject({ DocEntry: 3 });
  });

  test("b1.read: aggregate goes to SAP as $apply, names checked, totals paged", async () => {
    const w = await world();
    agent.store["Orders#apply"] = [{ CardCode: "C1", a0: 10 }, { CardCode: "C2", a0: 7 }];
    const out = await call(router.b1.read, { entity: "Orders", query: { filter: [{ field: "CardCode", op: "ne", value: "X" }] },
      aggregate: { groupBy: ["CardCode"], measures: [{ field: "DocTotal", agg: "sum", as: "a0" }] } }, w.staff);
    expect(out.rows).toEqual([{ CardCode: "C1", a0: 10 }, { CardCode: "C2", a0: 7 }]);
    expect((agent.calls.at(-1)!.body as { query: { apply?: string } }).query.apply).toBe("filter(CardCode ne 'X')/groupby((CardCode),aggregate(DocTotal with sum as a0))");
    expect(await message(call(router.b1.read, { entity: "Orders", aggregate: { groupBy: ["Cardcode"], measures: [{ agg: "count", as: "n" }] } }, w.staff)))
      .toContain("Cardcode (did you mean CardCode?)");
  });

  test("b1.read: aggregate with a free-text search is refused, never a total over every record", async () => {
    const w = await world();
    expect(await code(call(router.b1.read, { entity: "Orders", query: { search: "ACME" }, aggregate: { groupBy: [], measures: [{ agg: "count", as: "n" }] } }, w.staff))).toBe("BAD_REQUEST");
  });

  test("b1.read follows nextLink: 600 rows are two pages", async () => {
    const w = await world();
    agent.store.Orders = Array.from({ length: 600 }, (_, i) => ({ ...order(), DocEntry: i + 1 }));
    const p1 = await call(router.b1.read, { entity: "Orders", query: { select: ["DocNum"] } }, w.staff);
    expect(p1.rows).toHaveLength(500);
    const p2 = await call(router.b1.read, { entity: "Orders", query: { select: ["DocNum"] }, cursor: p1.nextCursor }, w.staff);
    expect(p2.rows).toHaveLength(100);
    expect(p2.nextCursor).toBeUndefined();
  });

  test("read scope: a member's row reads of EmployeesInfo are FORBIDDEN, an admin's pass; b1.find hides it", async () => {
    const m = await world("member");
    expect(await code(call(router.b1.read, { entity: "EmployeesInfo", query: {} }, m.staff))).toBe("FORBIDDEN");
    expect(await code(call(router.entities.rows, { entity: "EmployeesInfo", query: { select: [], filter: [], orderby: [] } }, m.staff))).toBe("FORBIDDEN");
    expect(await code(call(router.entities.one, { entity: "EmployeesInfo", key: 1 }, m.staff))).toBe("FORBIDDEN");
    // A schema stays readable: field names are not the data.
    expect((await call(router.b1.schema, { entity: "EmployeesInfo" }, m.staff)).keys).toEqual(["EmployeeID"]);
    const memberFound = await call(router.b1.find, { query: "e" }, m.staff);
    expect(memberFound.entities.map((e) => e.name)).not.toContain("EmployeesInfo");

    const a = await world("admin");
    expect((await call(router.b1.read, { entity: "EmployeesInfo", query: {} }, a.staff)).rows).toHaveLength(1);
    expect((await call(router.entities.rows, { entity: "EmployeesInfo", query: { select: [], filter: [], orderby: [] } }, a.staff)).rows).toHaveLength(1);
    const adminFound = await call(router.b1.find, { query: "employ" }, a.staff);
    expect(adminFound.entities).toEqual([{ name: "EmployeesInfo", categories: ["hr"], writable: false, copyTo: [] }]);
    const orders = await call(router.b1.find, { category: "sales" }, a.staff);
    expect(orders.entities.find((e) => e.name === "Orders")).toMatchObject({ writable: true, copyTo: ["DeliveryNotes", "Invoices"] });
  });

  test("b1.schema is compact: keys, fields with enum values and required, collections by name", async () => {
    const w = await world();
    const s = await call(router.b1.schema, { entity: "Orders" }, w.staff);
    expect(s).toMatchObject({ entity: "Orders", keys: ["DocEntry"], writable: true });
    expect("fields" in s && s.fields.find((f) => f.name === "DocumentStatus")).toEqual({ name: "DocumentStatus", type: "enum", values: ["bost_Open", "bost_Close"] });
    expect("fields" in s && s.fields.find((f) => f.name === "CardCode")).toMatchObject({ required: true });
    expect("collections" in s && s.collections).toEqual([{ name: "DocumentLines", fields: 4, required: true }]);
    const lines = await call(router.b1.schema, { entity: "Orders", collection: "DocumentLines" }, w.staff);
    expect(lines.fields.map((f) => f.name)).toEqual(["LineNum", "ItemCode", "Quantity", "Price"]);
  });

  test("auto: a proposal unless both switches are on; then posted", async () => {
    const w = await world();
    const write = () => call(router.b1.write, { entity: "Orders", key: 5, data: { Comments: "new" } }, w.staff);
    const p = await write();
    expect("proposal" in p && p.proposal).toMatchObject({
      op: "update", entity: "Orders", key: 5, etag: 'W/"1"', payload: { Comments: "new" },
      changes: { Comments: { before: "old", after: "new" } }, title: "Change Orders 905",
    });
    expect(agent.store.Orders![0]!.Comments).toBe("old");

    await autoOn(w, false); // the workspace allows it, the user has not switched it on
    expect("proposal" in (await write())).toBe(true);
    await call(router.views.setState, { key: AUTO_WRITE_KEY, value: true }, w.staff);
    const done = await write();
    expect(done).toMatchObject({ written: { entity: "Orders", key: 5, docNum: 905 }, link: "/b1/Orders/5" });
    expect(agent.store.Orders![0]!.Comments).toBe("new");

    // The admin turns it off: at once a proposal again, for everyone.
    await db.update(assistantSettings).set({ b1AutoWrite: false }).where(eq(assistantSettings.tenantId, w.tenantId));
    expect("proposal" in (await write())).toBe(true);
  });

  test("auto still proposes in a chat holding dropped files, and for a copy to Invoices", async () => {
    const w = await world();
    await autoOn(w);
    const thread = await newThread(w.tenantId, w.u.userId);
    const inChat = { context: { headers: w.headers, assistantThreadId: thread.id } };
    expect("written" in (await call(router.b1.write, { entity: "Orders", key: 5, data: { Comments: "a" } }, inChat))).toBe(true);
    await db.insert(assistantFile).values({ tenantId: w.tenantId, threadId: thread.id, name: "rfq.pdf", mime: "application/pdf", size: 1, data: Buffer.from("x") });
    expect("proposal" in (await call(router.b1.write, { entity: "Orders", key: 5, data: { Comments: "b" } }, inChat))).toBe(true);

    const inv = await call(router.b1.copy, { sourceEntity: "Orders", targetEntity: "Invoices", docEntries: [5] }, w.staff);
    expect("proposal" in inv && inv.proposal).toMatchObject({ op: "copy", entity: "Invoices", payload: { sourceEntity: "Orders", docEntries: [5] } });
    expect(agent.store.Invoices).toEqual([]);
    // The card's click posts it.
    const posted = await call(router.b1.post, { proposal: (inv as { proposal: never }).proposal }, w.staff);
    expect(posted.written.entity).toBe("Invoices");
    expect(agent.store.Invoices![0]!.DocumentLines).toEqual([expect.objectContaining({ BaseType: 17, BaseEntry: 5, BaseLine: 0 })]);
  });

  test("auto still proposes once the chat read what a client wrote: this run, an earlier one, or a client's request", async () => {
    const w = await world();
    await autoOn(w);
    const thread = await newThread(w.tenantId, w.u.userId);
    const inChat = (extra = {}) => ({ context: { headers: w.headers, assistantThreadId: thread.id, ...extra } });
    const write = (c: object) => call(router.b1.write, { entity: "Orders", key: 5, data: { Comments: "c" } }, c);
    expect("written" in (await write(inChat()))).toBe(true);
    // This run read a client's text (route.ts' guard sets it before the write runs).
    expect("proposal" in (await write(inChat({ assistantClientContent: true })))).toBe(true);
    // An earlier run did: its stored assistant message says so.
    await appendMessages(thread.id, [{ role: "user", content: "x" }, { role: "assistant", content: "y", metadata: { clientContent: true } }]);
    expect("proposal" in (await write(inChat()))).toBe(true);

    // A configuration that is a client's request taints its own chat, and any run that reads it.
    const [m] = await db.insert(configModel).values({ tenantId: w.tenantId, name: "Cable", definition: TEST_MODEL }).returning({ id: configModel.id });
    const [req] = await db.insert(configProject).values({ tenantId: w.tenantId, modelId: m!.id, name: "Their request", portalCardCode: "C1", status: "submitted", createdBy: w.u.userId }).returning({ id: configProject.id });
    const [own] = await db.insert(configProject).values({ tenantId: w.tenantId, modelId: m!.id, name: "Ours", createdBy: w.u.userId }).returning({ id: configProject.id });
    const [rt] = await db.insert(assistantThread).values({ tenantId: w.tenantId, userId: w.u.userId, projectId: req!.id }).returning({ id: assistantThread.id });
    expect("proposal" in (await write({ context: { headers: w.headers, assistantThreadId: rt!.id } }))).toBe(true);
    expect(await readsClientContent(w.tenantId, "configs_get", { id: req!.id })).toBe(true);
    expect(await readsClientContent(w.tenantId, "timeline_list", { projectId: req!.id })).toBe(true);
    expect(await readsClientContent(w.tenantId, "configs_get", { id: own!.id })).toBe(false);
    expect(await readsClientContent(w.tenantId, "requests_rows", {})).toBe(true);
    expect(await readsClientContent(w.tenantId, "b1_read", { entity: "Orders", key: 5 })).toBe(false);
    // Another workspace's request is not this one's.
    const other = await makeTenant();
    expect(await readsClientContent(other.tenantId, "configs_get", { id: req!.id })).toBe(false);
  });

  test("b1.post posts with the proposal's ETag; a record changed since is CONFLICT", async () => {
    const w = await world();
    const { proposal } = (await call(router.b1.write, { entity: "Orders", key: 5, data: { Comments: "x" } }, w.staff)) as { proposal: never };
    const applied = await call(router.b1.post, { proposal }, w.staff);
    expect(applied.written).toMatchObject({ entity: "Orders", key: 5 });
    expect(agent.calls.filter((c) => c.route === "/update").at(-1)!.body.etag).toBe('W/"1"');

    const { proposal: stale } = (await call(router.b1.write, { entity: "Orders", key: 5, data: { Comments: "y" } }, w.staff)) as { proposal: never };
    agent.store.Orders![0]!["@odata.etag"] = 'W/"999"'; // someone edits it in SAP meanwhile
    expect(await code(call(router.b1.post, { proposal: stale }, w.staff))).toBe("CONFLICT");
    expect(agent.store.Orders![0]!.Comments).toBe("x");
    // A model's etag from an older read is refused at once, not after a click.
    expect(await code(call(router.b1.write, { entity: "Orders", key: 5, etag: 'W/"1"', data: { Comments: "z" } }, w.staff))).toBe("CONFLICT");
  });

  test("create: required fields first, then a proposal of exactly what will post", async () => {
    const w = await world();
    expect(await message(call(router.b1.write, { entity: "Quotations", data: { CardCode: "C1" } }, w.staff))).toContain("DocumentLines");
    const r = await call(router.b1.write, { entity: "Quotations", data: { CardCode: "C1", DocumentLines: [{ ItemCode: "A", Quantity: 1 }] } }, w.staff);
    expect("proposal" in r && r.proposal).toMatchObject({ op: "create", title: "New Quotations", changes: { CardCode: { before: null, after: "C1" } } });
    const rows = await db.select().from(assistantSettings).where(and(eq(assistantSettings.tenantId, w.tenantId)));
    expect(rows).toEqual([]); // nothing turned auto on by itself
  });
});
