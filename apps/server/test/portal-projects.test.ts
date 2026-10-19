import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db, configModel, configProject, configProjectEvent } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { revisionDiff } from "../src/project-lifecycle.ts";
import {
  call, insertSeat, makePortalSeat, makePortalUser, makeTenant, makeUser, tenantHeaders, TEST_MODEL,
} from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// Portal projects and their lifecycle (spec §7, §8): a client configures on the server, submits,
// staff accept, revise, send back, quote; the client answers; a re-quote modifies the quotation or,
// once SAP closed it, replaces it. Every hop goes through the real routers of both processes.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const NO_QUERY = { select: [], filter: [], orderby: [] };

let agent: MockAgent;
beforeAll(() => { agent = startMockAgent({}); });
afterAll(() => agent.stop());

async function setup(pricing: "indicative" | "request" = "indicative") {
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  const admin = await makeUser("admin", t.tenantId);
  const client = await makePortalUser();
  const company = await makePortalSeat(t.tenantId, client.userId, "buyer");
  const [model] = await db.insert(configModel)
    .values({ tenantId: t.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true, portalPricing: pricing })
    .returning();
  const staff = { context: { headers: tenantHeaders(t.slug, admin.cookie) } };
  const portal = { context: { headers: tenantHeaders(t.slug, client.cookie) } };
  const create = () => call(portalRouter.projects.create, { modelId: model!.id, name: "Kabel 1" }, portal);
  return { ...t, admin, client, company, model: model!, staff, portal, create };
}

const events = async (projectId: string) =>
  db.select().from(configProjectEvent).where(eq(configProjectEvent.projectId, projectId)).orderBy(asc(configProjectEvent.at));

/** Staff take a submitted request into review and pick the first candidate at every quantity. */
async function acceptAndPick(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await call(router.requests.accept, { id }, s.staff);
  const { project } = await call(router.configs.calculate, { id }, s.staff);
  await call(router.configs.select, {
    projectId: id, selection: project.candidates[0]!.perBatch.map((b) => ({ candidateIdx: 0, batchQty: b.batchQty })),
  }, s.staff);
}

const quote = async (s: Awaited<ReturnType<typeof setup>>, id: string) => {
  const d = await call(router.configs.quoteDraft, { projectId: id }, s.staff);
  return { draft: d, posted: await call(router.configs.createQuote, { projectId: id, commandId: d.commandId }, s.staff) };
};

describe("revisionDiff", () => {
  test("names what changed, row counts for tables, nothing when nothing did", () => {
    const base = { entries: { a: 1, b: "x" }, batches: [10], tables: { t: [{ q: 1 }] } };
    expect(revisionDiff(base, { ...base, entries: { b: "x", a: 1 } })).toBeNull(); // key order is not a change
    expect(revisionDiff(base, { entries: { a: 2 }, batches: [10, 20], tables: { t: [{ q: 1 }, { q: 2 }] } })).toEqual({
      entries: { a: [1, 2], b: ["x", undefined] }, batches: [[10], [10, 20]], tables: { t: [1, 2] },
    });
  });
});

describe("portal projects", () => {
  test("configure on the server, submit, accept, revise, send back, resubmit", async () => {
    const s = await setup();
    const { id } = await s.create();

    // A client's draft is private: no internal read sees it.
    expect(await codeOf(call(router.configs.get, { id }, s.staff))).toBe("NOT_FOUND");
    const inbox = () => call(router.requests.rows, { query: NO_QUERY, top: 50 }, s.staff);
    expect((await inbox()).rows).toHaveLength(0);
    expect((await call(router.configs.rows, { query: NO_QUERY, top: 50 }, s.staff)).rows).toHaveLength(0);

    // One edit is one call: the inputs are written and, complete, calculated — the page gets the
    // projection and the live indicative figures, never a candidate.
    const pl = await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, s.portal);
    expect(pl.project.calculatedAt).not.toBeNull();
    expect(pl.prices.kind).toBe("live");
    expect(pl.prices.kind === "live" && pl.prices.rows.map((r) => r.batchQty)).toEqual([100, 500]);
    expect(JSON.stringify(pl)).not.toContain("candidates");
    expect(pl.model.definition.routing).toEqual([]);

    await call(portalRouter.projects.submit, { id }, s.portal);
    const [submitted] = (await events(id)).filter((e) => e.kind === "submitted");
    expect(submitted!.payload).toMatchObject({ inputs: { entries: { material: "steel" } }, prices: [{ batchQty: 100 }, { batchQty: 500 }] });

    // Submitted: nobody edits. The client withdraws or waits; staff accept first.
    expect(await codeOf(call(portalRouter.projects.calculate, { id, entries: {} }, s.portal))).toBe("CONFLICT");
    expect(await codeOf(call(router.configs.calculate, { id, entries: {} }, s.staff))).toBe("CONFLICT");
    expect((await inbox()).rows.map((r) => r.status)).toEqual(["submitted"]);

    await call(router.requests.accept, { id }, s.staff);
    const [row] = await db.select().from(configProject).where(eq(configProject.id, id));
    expect(row).toMatchObject({ status: "in_review", assigneeId: s.admin.userId });

    // Staff edits write no event of their own; the transition that closes the round writes one.
    await call(router.configs.calculate, { id, entries: { material: "alu" } }, s.staff);
    expect((await events(id)).some((e) => e.kind === "revised")).toBe(false);
    await call(router.requests.sendBack, { id, note: "Aluminium is what we can do" }, s.staff);
    const kinds = (await events(id)).map((e) => e.kind);
    expect(kinds.slice(-2)).toEqual(["revised", "returned"]);

    // The client reads the diff, never the frozen inputs.
    const tl = await call(portalRouter.timeline.list, { projectId: id }, s.portal);
    const revised = tl.events.find((e) => e.kind === "revised")!;
    expect(revised.payload).toEqual({ entries: { material: ["steel", "alu"] }, tables: {} });
    expect(JSON.stringify(tl.events.find((e) => e.kind === "submitted")!.payload)).not.toContain("inputs");
    expect(tl.labels.material).toBe("Material");

    // Returned: the client's again.
    await call(portalRouter.projects.calculate, { id, entries: { material: "alu", coated: true } }, s.portal);
    await call(portalRouter.projects.resubmit, { id }, s.portal);
    expect((await inbox()).rows.map((r) => r.status)).toEqual(["submitted"]);
  });

  test("quote, decline, re-quote modifies the same quotation; a closed one is replaced; accept is final", async () => {
    const s = await setup("request");
    const { id } = await s.create();
    await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, s.portal);
    // A request model shows no number before the quotation.
    expect((await call(portalRouter.projects.get, { id }, s.portal)).prices.kind).toBe("request");
    await call(portalRouter.projects.submit, { id }, s.portal);
    await acceptAndPick(s, id);

    const first = await quote(s, id);
    expect(first.draft.replaces).toBeNull();
    expect(first.posted).toMatchObject({ mode: "created", reused: false });
    const doc = agent.store.Quotations!.find((q) => q.DocEntry === first.posted.docEntry)!;
    expect(doc.CardCode).toBe(s.company.cardCode); // the company, lead or customer

    const pl = await call(portalRouter.projects.get, { id }, s.portal);
    expect(pl.project.status).toBe("quoted");
    expect(pl.prices).toEqual({ kind: "quotation", declined: false });
    expect((await call(portalRouter.projects.quotation, { id }, s.portal))?.docNum).toBe(Number(doc.DocNum));

    // Declined: back in review, same assignee, the quotation stays the current one.
    await call(portalRouter.projects.respondQuote, { id, accept: false, note: "Too expensive" }, s.portal);
    const reopened = (await db.select().from(configProject).where(eq(configProject.id, id)))[0]!;
    expect(reopened).toMatchObject({ status: "in_review", quoteResponse: "declined", assigneeId: s.admin.userId, b1DocEntry: first.posted.docEntry });

    // Re-quote an open quotation: PATCH in place, collections replaced, the key rewritten.
    await call(router.configs.calculate, { id, entries: { material: "alu" } }, s.staff);
    const { project: p2 } = await call(router.configs.calculate, { id }, s.staff);
    await call(router.configs.select, { projectId: id, selection: [{ candidateIdx: 0, batchQty: p2.candidates[0]!.perBatch[0]!.batchQty }] }, s.staff);
    const second = await quote(s, id);
    expect(second.draft.replaces).toEqual({ docEntry: first.posted.docEntry });
    expect(second.posted).toMatchObject({ mode: "updated", docEntry: first.posted.docEntry });
    const patch = agent.calls.filter((c) => c.route === "/update" && c.body.key === first.posted.docEntry).at(-1)!;
    expect(patch.body.replaceCollections).toBe(true);
    expect(patch.body.data).not.toHaveProperty("CardCode");
    expect(doc.U_CF_Key).toBe(second.draft.commandId);
    const quotedEvents = (await events(id)).filter((e) => e.kind === "quoted");
    expect(quotedEvents.map((e) => (e.payload as { mode: string }).mode)).toEqual(["created", "updated"]);
    expect((await events(id)).map((e) => e.kind)).toContain("revised");
    expect((await db.select().from(configProject).where(eq(configProject.id, id)))[0]!.quoteResponse).toBeNull();

    // Declined again, and staff close the quotation in SAP: the next quote is a new document.
    await call(portalRouter.projects.respondQuote, { id, accept: false }, s.portal);
    await call(router.entities.close, { entity: "Quotations", key: first.posted.docEntry }, s.staff);
    expect(doc.DocumentStatus).toBe("bost_Close");
    const third = await quote(s, id);
    expect(third.posted.mode).toBe("created");
    expect(third.posted.docEntry).not.toBe(first.posted.docEntry);

    // Both quotations stay on the timeline; the closed one is superseded.
    const docs = await call(portalRouter.timeline.documents, { projectId: id }, s.portal);
    expect(docs.quotations.map((q) => [q.quotation.docEntry, q.current])).toEqual([
      [third.posted.docEntry, true], [first.posted.docEntry, false],
    ]);

    // Accept is final.
    await call(portalRouter.projects.respondQuote, { id, accept: true }, s.portal);
    expect((await db.select().from(configProject).where(eq(configProject.id, id)))[0]).toMatchObject({ status: "quoted", quoteResponse: "accepted" });
    expect(await codeOf(call(portalRouter.projects.respondQuote, { id, accept: false }, s.portal))).toBe("CONFLICT");
  });

  test("the fences: another company, a viewer, a refused input, staff-only notes, staff deletes", async () => {
    const s = await setup();
    const { id } = await s.create();

    const other = await makePortalUser();
    await makePortalSeat(s.tenantId, other.userId, "owner", "Andere GmbH");
    const otherCtx = { context: { headers: tenantHeaders(s.slug, other.cookie) } };
    expect(await codeOf(call(portalRouter.projects.get, { id }, otherCtx))).toBe("NOT_FOUND");
    expect((await call(portalRouter.projects.rows, { query: NO_QUERY, top: 50 }, otherCtx)).rows).toHaveLength(0);

    const viewer = await makePortalUser();
    await insertSeat(s.tenantId, s.company.cardCode, viewer.userId, "viewer");
    const viewerCtx = { context: { headers: tenantHeaders(s.slug, viewer.cookie) } };
    expect(await codeOf(call(portalRouter.projects.get, { id }, viewerCtx))).toBe("OK");
    expect(await codeOf(call(portalRouter.projects.calculate, { id, entries: { material: "alu" } }, viewerCtx))).toBe("FORBIDDEN");

    // Only the model's parameters, and never the read-only ones.
    expect(await codeOf(call(portalRouter.projects.calculate, { id, entries: { bogus: 1 } }, s.portal))).toBe("BAD_REQUEST");
    // Value help only over a table the model names.
    expect(await codeOf(call(portalRouter.projects.queryPage, { modelId: s.model.id, table: "anything" }, s.portal))).toBe("NOT_FOUND");

    await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, s.portal);
    await call(portalRouter.projects.submit, { id }, s.portal);

    // Staff may not delete a request or change its model; an internal note never reaches the client.
    expect(await codeOf(call(router.configs.remove, { ids: [id] }, s.staff))).toBe("CONFLICT");
    await call(router.requests.accept, { id }, s.staff);
    expect(await codeOf(call(router.configs.update, { id, modelId: s.model.id }, s.staff))).toBe("BAD_REQUEST");
    await call(router.timeline.comment, { projectId: id, note: "Margin is thin", internalOnly: true }, s.staff);
    await call(router.timeline.comment, { projectId: id, note: "We are on it" }, s.staff);
    await call(portalRouter.timeline.comment, { projectId: id, note: "Thanks" }, viewerCtx);
    const seen = (await call(portalRouter.timeline.list, { projectId: id }, s.portal)).events.map((e) => e.note).filter(Boolean);
    expect(seen).toEqual(["We are on it", "Thanks"]);
    const all = (await call(router.timeline.list, { projectId: id }, s.staff)).events.map((e) => e.note).filter(Boolean);
    expect(all).toEqual(["Margin is thin", "We are on it", "Thanks"]);

    // A draft is the client's to delete; anything later is not.
    expect(await codeOf(call(portalRouter.projects.remove, { id }, s.portal))).toBe("CONFLICT");
  });

  test("an unpublished model is not in the catalog and cannot be started", async () => {
    const s = await setup();
    await db.update(configModel).set({ portal: false }).where(eq(configModel.id, s.model.id));
    expect(await call(portalRouter.models.list, undefined, s.portal)).toEqual([]);
    expect(await codeOf(s.create())).toBe("NOT_FOUND");
  });
});
