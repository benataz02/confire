import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { fakeText, type FakeTextAdapter } from "@tanstack/ai/testing";
import { db, aiUsage, assistantSettings, assistantThread, configModel, configProject, configProjectEvent, projectFile } from "@confire/db";
import type { FileRef } from "../src/assistant/files.ts";
import { useTestAdapter } from "../src/assistant/model.ts";
import { MONTHLY_LIMIT_USD } from "../src/assistant/usage.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// The assistant's procedures (spec §4.1): the fixed intake steps the panel runs — read the request,
// start the configuration, read its values — plus the switch and the month's usage for admins.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const PDF = Buffer.from("%PDF-1.7 RFQ ACME bracket");
afterEach(() => useTestAdapter(null));

async function world() {
  const { tenantId, slug } = await makeTenant();
  const admin = await makeUser("admin", tenantId);
  const member = await makeUser("member", tenantId);
  await db.insert(assistantSettings).values({ tenantId, assistant: true });
  const [m] = await db.insert(configModel).values({
    tenantId, name: "Cable", definition: { ...TEST_MODEL, description: "Steel and aluminium cables" },
  }).returning({ id: configModel.id });
  const as = (u: { cookie: string }) => ({ context: { headers: tenantHeaders(slug, u.cookie) } });
  const fake = fakeText();
  useTestAdapter(fake);
  return { tenantId, slug, admin, member, modelId: m!.id, staff: as(member), adminCtx: as(admin), fake, as };
}

/** A drop as the panel makes one: a new general thread, one uploaded assistant file. */
async function drop(w: Awaited<ReturnType<typeof world>>) {
  const { id: threadId } = await call(router.assistant.newThread, undefined, w.staff);
  const { assistantFileRoutes } = await import("../src/assistant/files.ts");
  const res = await assistantFileRoutes().request(`/files/${w.slug}/assistant/${threadId}?name=RFQ_ACME.pdf`, {
    method: "POST", body: new Uint8Array(PDF), headers: { cookie: w.member.cookie },
  });
  const { ref } = (await res.json()) as { ref: FileRef };
  return { threadId, ref };
}

const proposalFor = (fake: FakeTextAdapter<string>, modelId: string | null, name = "ACME – Cable 3 m") =>
  fake.setResponses([{ text: JSON.stringify({ modelId, why: "A cable is asked for", customer: { name: "ACME", emailDomain: "acme.test" }, name }) }]);

describe.skipIf(!process.env.DATABASE_URL)("assistant router", () => {
  test("intake proposes, appends user + read_request pair, meters, titles the thread", async () => {
    const w = await world();
    const { threadId, ref } = await drop(w);
    proposalFor(w.fake, w.modelId);
    const r = await call(router.assistant.intake, { threadId, text: "Please quote 50 cables", refs: [ref] }, w.staff);
    expect(r.proposal).toMatchObject({ model: { id: w.modelId, name: "Cable" }, name: "ACME – Cable 3 m", customers: [] });
    expect(r.proposal.customerError).toBeTruthy(); // no SAP here: the card's value help still works
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const [t] = await db.select().from(assistantThread).where(eq(assistantThread.id, threadId));
    expect(t!.title).toBe("ACME – Cable 3 m");
    expect(t!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(t!.messages)).not.toContain(PDF.toString("base64"));
    expect(await db.select().from(aiUsage).where(and(eq(aiUsage.tenantId, w.tenantId), eq(aiUsage.threadId, threadId)))).toHaveLength(1);
    // the request names a model that is not this tenant's: no proposal, never a foreign id
    proposalFor(w.fake, null);
    expect((await call(router.assistant.intake, { threadId, text: "x", refs: [ref] }, w.staff)).proposal.model).toBeNull();
  });

  test("start creates with via: assistant, links the thread, copies the drop's files", async () => {
    const w = await world();
    const { threadId, ref } = await drop(w);
    proposalFor(w.fake, w.modelId);
    await call(router.assistant.intake, { threadId, text: "50 cables", refs: [ref] }, w.staff);
    const { id } = await call(router.assistant.start, { threadId, modelId: w.modelId, name: "ACME – Cable", customer: null }, w.staff);
    const events = await db.select().from(configProjectEvent).where(eq(configProjectEvent.projectId, id));
    expect(events.find((e) => e.kind === "created")!.payload).toEqual({ via: "assistant" });
    expect(events.filter((e) => e.kind === "file")).toHaveLength(1);
    const files = await db.select().from(projectFile).where(eq(projectFile.projectId, id));
    expect(files.map((f) => f.name)).toEqual(["RFQ_ACME.pdf"]);
    expect((await db.select().from(assistantThread).where(eq(assistantThread.id, threadId)))[0]!.projectId).toBe(id);
    // a configuration's thread starts nothing else
    expect(await codeOf(call(router.assistant.start, { threadId, modelId: w.modelId, name: "Again", customer: null }, w.staff))).toBe("BAD_REQUEST");
  });

  test("extract after start reads the last drop and appends extract_values", async () => {
    const w = await world();
    const { threadId, ref } = await drop(w);
    proposalFor(w.fake, w.modelId);
    await call(router.assistant.intake, { threadId, text: "50 cables", refs: [ref] }, w.staff);
    const { id } = await call(router.assistant.start, { threadId, modelId: w.modelId, name: "ACME – Cable", customer: null }, w.staff);
    let sent = "";
    w.fake.setResponses([({ request }) => {
      sent = JSON.stringify(request.messages);
      return { text: JSON.stringify({ set: [{ key: "material", value: "steel", source: { file: "RFQ_ACME.pdf", page: 1, quote: "STEEL" } }], batches: null, tables: [], unsure: [], notes: [] }) };
    }]);
    const r = await call(router.assistant.extract, { threadId, projectId: id }, w.staff);
    expect(sent).toContain("RFQ_ACME.pdf");
    expect(sent).toContain("50 cables");
    expect(r.result.applied.map((a) => a.key)).toEqual(["material"]);
    expect((await db.select().from(configProject).where(eq(configProject.id, id)))[0]!.entries).toEqual({ material: "steel" });
    const [t] = await db.select().from(assistantThread).where(eq(assistantThread.id, threadId));
    expect(t!.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(JSON.stringify(t!.messages.at(-2))).toContain("extract_values");
    // a refusal appends nothing
    await db.update(configProject).set({ status: "quoted" }).where(eq(configProject.id, id));
    expect(await codeOf(call(router.assistant.extract, { threadId, projectId: id }, w.staff))).toBe("CONFLICT");
    expect((await db.select().from(assistantThread).where(eq(assistantThread.id, threadId)))[0]!.messages).toHaveLength(5);
  });

  test("intake on a general thread reads only its own drop: a project ref elsewhere is not read", async () => {
    const w = await world();
    const { threadId, ref } = await drop(w);
    const { id: other } = await call(router.configs.create, { modelId: w.modelId, name: "Someone else's", customer: null }, w.adminCtx);
    const [secret] = await db.insert(projectFile).values({ tenantId: w.tenantId, projectId: other, name: "secret.pdf", mime: "application/pdf", size: PDF.length, data: PDF }).returning({ id: projectFile.id });
    let sent = "";
    w.fake.setResponses([({ request }) => { sent = JSON.stringify(request.messages); return { text: JSON.stringify({ modelId: null, why: "", customer: { name: null, emailDomain: null }, name: "x" }) }; }]);
    await call(router.assistant.intake, { threadId, text: "x", refs: [ref, { kind: "project", id: secret!.id, name: "secret.pdf", mime: "application/pdf" }] }, w.staff);
    expect(sent).toContain("RFQ_ACME.pdf");
    expect(sent).not.toContain("secret.pdf");
  });

  test("a forged x-tenant is refused; another user's thread is not found", async () => {
    const w = await world();
    const other = await world();
    const { threadId, ref } = await drop(w);
    const forged = { context: { headers: tenantHeaders(other.slug, w.member.cookie) } };
    expect(await codeOf(call(router.assistant.intake, { threadId, text: "x", refs: [ref] }, forged))).toBe("FORBIDDEN");
    expect(await codeOf(call(router.assistant.intake, { threadId, text: "x", refs: [ref] }, w.adminCtx))).toBe("NOT_FOUND");
  });

  test("settings and usage are admin-only; status never throws", async () => {
    const w = await world();
    expect(await codeOf(call(router.assistant.settings, undefined, w.staff))).toBe("FORBIDDEN");
    expect(await codeOf(call(router.assistant.usage, undefined, w.staff))).toBe("FORBIDDEN");
    await call(router.assistant.saveSettings, { assistant: false }, w.adminCtx);
    expect(await call(router.assistant.settings, undefined, w.adminCtx)).toEqual({ assistant: false, available: true });
    expect(await call(router.assistant.status, undefined, w.staff)).toEqual({ enabled: false, reason: "switch", limitReached: false, isAdminHint: false });
    await call(router.assistant.saveSettings, { assistant: true }, w.adminCtx);
    await db.insert(aiUsage).values({
      tenantId: w.tenantId, userId: "u", projectId: crypto.randomUUID(), model: "claude-sonnet-5-5", kind: "chat",
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: String(MONTHLY_LIMIT_USD),
    });
    expect(await call(router.assistant.status, undefined, w.adminCtx)).toEqual({ enabled: true, reason: null, limitReached: true, isAdminHint: true });
    // switched on, but the server has no API key: say that, not "turn it on in Settings"
    useTestAdapter(null);
    expect(await call(router.assistant.status, undefined, w.adminCtx)).toMatchObject({ enabled: false, reason: "no_key" });
    expect(await call(router.assistant.usage, undefined, w.adminCtx)).toMatchObject({ cost: MONTHLY_LIMIT_USD, limit: MONTHLY_LIMIT_USD, assisted: 1 });
  });

  test("configs.models carries each model's description", async () => {
    const w = await world();
    expect(await call(router.configs.models, undefined, w.staff)).toEqual([{ id: w.modelId, name: "Cable", description: "Steel and aluminium cables" }]);
  });

  test("thread answers the stored history as UI messages", async () => {
    const w = await world();
    const { threadId, ref } = await drop(w);
    proposalFor(w.fake, w.modelId);
    await call(router.assistant.intake, { threadId, text: "50 cables", refs: [ref] }, w.staff);
    const t = await call(router.assistant.thread, {}, w.staff);
    expect(t.id).toBe(threadId);
    const toolPart = t.messages.flatMap((m) => m.parts).find((p) => p.type === "tool-call");
    expect(toolPart).toMatchObject({ name: "read_request" });
  });
});
