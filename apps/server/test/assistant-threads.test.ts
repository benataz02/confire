import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { db, assistantFile, configModel, configProjectEvent, projectFile } from "@confire/db";
import { utils, write } from "xlsx";
import { assistantFileRoutes, copyToProject, filePart, fileParts, unlabeled, type FileRef } from "../src/assistant/files.ts";
import {
  appendMessages, clearThread, dehydrate, hydrate, lastDrop, newThread, ownThread, stamped, threadFor, withThread,
} from "../src/assistant/threads.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// Threads (assistant spec §4.7): one per (user, configuration) plus general ones, server-owned,
// append-only, one run at a time; their dropped files stored apart and referenced, never inlined.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const PDF = Buffer.from("%PDF-1.7 drawing");
const XLSX = (() => {
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet([["Customer", "Net"], ["ACME", 100]]), "Sales");
  return Buffer.from(write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
})();

async function world() {
  const { tenantId, slug } = await makeTenant();
  const a = await makeUser("member", tenantId);
  const b = await makeUser("member", tenantId);
  const [m] = await db.insert(configModel).values({ tenantId, name: "Cable", definition: TEST_MODEL }).returning({ id: configModel.id });
  const ctx = { context: { headers: tenantHeaders(slug, a.cookie) } };
  const { id: projectId } = await call(router.configs.create, { modelId: m!.id, name: "Cable", customer: null }, ctx);
  return { tenantId, slug, a, b, projectId };
}

// The adapter spreads a text part's metadata onto Claude's block, which refuses `fileLabel` (400).
test("a file label reaches the model without its metadata; the file keeps its own", () => {
  const ref: FileRef = { kind: "assistant", id: crypto.randomUUID(), name: "drawing.pdf", mime: "application/pdf" };
  const doc = filePart(ref, PDF)!;
  const label = { type: "text" as const, content: "File: drawing.pdf", metadata: { fileLabel: true } };
  expect(unlabeled([label, doc])).toEqual([{ type: "text", content: "File: drawing.pdf" }, doc]);
});

test("each stored message carries when it was stored, on the message, never on a part", () => {
  const at = new Date("2026-11-06T13:34:00Z");
  const [u, a] = stamped([
    { role: "user", content: [{ type: "text", content: "hi" }] },
    { role: "assistant", content: "ok", metadata: { prefix: "p" } },
  ], at);
  expect(u!.metadata).toEqual({ at: "2026-11-06T13:34:00.000Z" });
  expect(a!.metadata).toEqual({ prefix: "p", at: "2026-11-06T13:34:00.000Z" });
  expect((u!.content as { metadata?: unknown }[])[0]!.metadata).toBeUndefined();
  expect(stamped([u!], new Date("2026-11-07T00:00:00Z"))[0]!.metadata).toEqual({ at: "2026-11-06T13:34:00.000Z" });
});

describe.skipIf(!process.env.DATABASE_URL)("threads", () => {
  test("one thread per (user, configuration); general threads are the user's own", async () => {
    const w = await world();
    const t1 = await threadFor(w.tenantId, w.a.userId, w.projectId);
    expect((await threadFor(w.tenantId, w.a.userId, w.projectId)).id).toBe(t1.id);
    expect((await threadFor(w.tenantId, w.b.userId, w.projectId)).id).not.toBe(t1.id);
    expect(await codeOf(ownThread(w.tenantId, w.b.userId, t1.id))).toBe("NOT_FOUND");
    expect(await codeOf(threadFor(w.tenantId, w.a.userId, crypto.randomUUID()))).toBe("NOT_FOUND");

    const g = await threadFor(w.tenantId, w.a.userId, null);
    expect(g.projectId).toBeNull();
    expect((await threadFor(w.tenantId, w.a.userId, null)).id).toBe(g.id); // the latest general thread
    const fresh = await newThread(w.tenantId, w.a.userId);
    expect((await threadFor(w.tenantId, w.a.userId, null)).id).toBe(fresh.id);
  });

  test("a configuration's chat starts over: a new empty thread, never under a running answer", async () => {
    const w = await world();
    const t = await threadFor(w.tenantId, w.a.userId, w.projectId);
    await appendMessages(t.id, [{ role: "user", content: "Make it 3 m" }]);
    const other = await threadFor(w.tenantId, w.b.userId, w.projectId);
    let inside!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const run = withThread(t.id, async () => { inside(); await new Promise((r) => setTimeout(r, 50)); });
    await entered;
    expect(await codeOf(clearThread(w.tenantId, w.a.userId, w.projectId))).toBe("THREAD_BUSY");
    await run;

    const fresh = await clearThread(w.tenantId, w.a.userId, w.projectId);
    expect(fresh.id).not.toBe(t.id);
    expect(fresh.messages).toEqual([]);
    expect((await threadFor(w.tenantId, w.a.userId, w.projectId)).id).toBe(fresh.id);
    expect(await codeOf(ownThread(w.tenantId, w.a.userId, t.id))).toBe("NOT_FOUND");
    expect((await threadFor(w.tenantId, w.b.userId, w.projectId)).id).toBe(other.id); // b's chat is b's
  });

  test("one run per thread", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    let inside!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const first = withThread(t.id, async () => { inside(); await new Promise((r) => setTimeout(r, 50)); });
    await entered; // the first run holds the lease
    expect(await codeOf(withThread(t.id, async () => "second"))).toBe("THREAD_BUSY");
    await first;
    expect(await withThread(t.id, async () => "after")).toBe("after"); // released
  });

  test("append-only; files are stored as references and come back hydrated", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    const [f] = await db.insert(projectFile).values({ tenantId: w.tenantId, projectId: w.projectId, name: "RFQ.pdf", mime: "application/pdf", size: PDF.length, data: PDF }).returning({ id: projectFile.id });
    const ref: FileRef = { kind: "project", id: f!.id, name: "RFQ.pdf", mime: "application/pdf" };
    const user: ModelMessage = {
      role: "user",
      content: [
        { type: "document", source: { type: "data", value: PDF.toString("base64"), mimeType: "application/pdf" }, metadata: { title: "RFQ.pdf", file: ref } },
        { type: "text", content: "50 pcs" },
      ],
    };
    await appendMessages(t.id, [dehydrate(user)], "ACME bracket");
    await appendMessages(t.id, [{ role: "assistant", content: "Read it." }], "ignored: a title is set once");
    const stored = await ownThread(w.tenantId, w.a.userId, t.id);
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(stored.messages)).not.toContain(PDF.toString("base64"));
    expect(JSON.stringify(await hydrate(w.tenantId, stored.messages))).not.toContain(PDF.toString("base64")); // no project named: not read
    const [back] = await hydrate(w.tenantId, stored.messages, { projectId: w.projectId });
    expect((back!.content as { source?: { value: string } }[])[0]!.source!.value).toBe(PDF.toString("base64"));
    expect(lastDrop(stored.messages)).toEqual({ refs: [ref], text: "50 pcs" });
    expect(stored.messages.every((m) => typeof (m.metadata as { at?: unknown } | undefined)?.at === "string")).toBe(true);
    const ui = await call(router.assistant.thread, { id: t.id }, { context: { headers: tenantHeaders(w.slug, w.a.cookie) } });
    expect(ui.messages.every((m) => typeof m.metadata?.at === "string")).toBe(true); // survives modelMessagesToUIMessages
  });

  test("the AI page's list: own chats with something in them, pinned first, searched, renamed, deleted", async () => {
    const w = await world();
    const as = (u: { cookie: string }) => ({ context: { headers: tenantHeaders(w.slug, u.cookie) } });
    const list = (q?: string, u = w.a) => call(router.assistant.threads, q === undefined ? undefined : { q }, as(u));

    // New chat on a blank chat is that chat again; a chat with a message is never reused.
    const { id: blank } = await call(router.assistant.newThread, undefined, as(w.a));
    expect((await call(router.assistant.newThread, undefined, as(w.a))).id).toBe(blank);
    const older = await newThread(w.tenantId, w.a.userId);
    const tick = () => Bun.sleep(5); // updatedAt is the order: no two writes in one millisecond
    await appendMessages(older.id, [{ role: "user", content: "Quote 50 brackets for ACME" }], "Brackets");
    await tick();
    await appendMessages(blank, [
      { role: "user", content: [{ type: "text", content: "And a cable" }] },
      { role: "tool", toolCallId: "x", content: JSON.stringify({ name: "Bracket steel" }) },
      { role: "assistant", content: "The cable comes in steel or aluminium." },
    ]);
    expect((await call(router.assistant.newThread, undefined, as(w.a))).id).not.toBe(blank);
    const configChat = await threadFor(w.tenantId, w.a.userId, w.projectId);
    await tick();
    await appendMessages(configChat.id, [{ role: "user", content: "What is missing?" }], "What is missing?");

    // Blank chats are left out; the latest first; a configuration's chat carries its name.
    expect((await list()).map((t) => t.id)).toEqual([configChat.id, blank, older.id]);
    expect((await list())[0]).toMatchObject({ projectId: w.projectId, projectName: "Cable", pinned: false });

    // Search: title, configuration name, and the chat's words — not tool output; LIKE characters are literal.
    expect((await list("brack")).map((t) => t.id)).toEqual([older.id]);
    expect((await list("cable")).map((t) => t.id)).toEqual([configChat.id, blank]);
    expect((await list("ALUMINIUM")).map((t) => t.id)).toEqual([blank]);
    expect(await list("%")).toEqual([]);

    // Pin and rename keep the order of the rest: neither touches updatedAt.
    await call(router.assistant.pinThread, { id: older.id, pinned: true }, as(w.a));
    await call(router.assistant.renameThread, { id: blank, title: "  Cable for ACME " }, as(w.a));
    const after = await list();
    expect(after.map((t) => t.id)).toEqual([older.id, configChat.id, blank]);
    expect(after[2]!.title).toBe("Cable for ACME");

    // Someone else's chat is not theirs to see, read, rename, pin or delete.
    expect(await list(undefined, w.b)).toEqual([]);
    expect(await Promise.all([
      call(router.assistant.thread, { id: older.id }, as(w.b)),
      call(router.assistant.renameThread, { id: older.id, title: "mine" }, as(w.b)),
      call(router.assistant.pinThread, { id: older.id, pinned: false }, as(w.b)),
      call(router.assistant.deleteThread, { id: older.id }, as(w.b)),
    ].map(codeOf))).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);

    // Delete: never mid-answer; the configuration stays.
    let inside!: () => void;
    const entered = new Promise<void>((r) => (inside = r));
    const run = withThread(configChat.id, async () => { inside(); await Bun.sleep(50); });
    await entered;
    expect(await codeOf(call(router.assistant.deleteThread, { id: configChat.id }, as(w.a)))).toBe("THREAD_BUSY");
    await run;
    await call(router.assistant.deleteThread, { id: configChat.id }, as(w.a));
    expect((await list()).map((t) => t.id)).toEqual([older.id, blank]);
    expect((await call(router.configs.get, { id: w.projectId }, as(w.a))).project.name).toBe("Cable");
    expect((await call(router.assistant.thread, { id: blank }, as(w.a))).id).toBe(blank);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("assistant files", () => {
  const upload = (slug: string, threadId: string, cookie: string, name: string, body: Buffer) =>
    assistantFileRoutes().request(`/files/${slug}/assistant/${threadId}?name=${encodeURIComponent(name)}`, {
      method: "POST", body: new Uint8Array(body), headers: { cookie },
    });

  test("PDF, PNG, JPEG and spreadsheets, by their bytes", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    const docx = await upload(w.slug, t.id, w.a.cookie, "rfq.pdf", Buffer.from("PK\x03\x04 word document"));
    expect(docx.status).toBe(415);
    expect(((await docx.json()) as { message: string }).message).toContain("PDF, PNG, JPEG");
    expect(await db.select().from(assistantFile).where(eq(assistantFile.threadId, t.id))).toHaveLength(0);
    const pdf = await upload(w.slug, t.id, w.a.cookie, "x.bin", PDF);
    expect(pdf.status).toBe(201);
    expect(((await pdf.json()) as { ref: FileRef }).ref).toMatchObject({ kind: "assistant", name: "x.bin", mime: "application/pdf" });
    const sheet = await upload(w.slug, t.id, w.a.cookie, "Q1.xlsx", XLSX);
    expect(sheet.status).toBe(201);
    expect(((await sheet.json()) as { ref: FileRef }).ref.mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // someone else's thread is not a place to upload to
    expect((await upload(w.slug, t.id, w.b.cookie, "y.pdf", PDF)).status).toBe(404);
  });

  test("a spreadsheet is read as text, stored as a reference, and read again on hydrate", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    const { ref } = (await (await upload(w.slug, t.id, w.a.cookie, "Q1.xlsx", XLSX)).json()) as { ref: FileRef };
    const parts = await fileParts(w.tenantId, [ref], { threadId: t.id });
    expect(parts[1]).toMatchObject({ type: "text", metadata: { file: { id: ref.id } } });
    expect((parts[1] as { content: string }).content).toContain("ACME,100");
    const msg: ModelMessage = { role: "user", content: [...parts, { type: "text", content: "rebuild this" }] };
    const stored = dehydrate(msg);
    expect(JSON.stringify(stored)).not.toContain("ACME");
    expect(lastDrop([stored])).toEqual({ refs: [ref], text: "rebuild this" });
    const [back] = await hydrate(w.tenantId, [stored], { threadId: t.id });
    expect(JSON.stringify(back)).toContain("ACME,100");
    // on the wire a text part carries no Confire metadata
    expect(unlabeled(back!.content as never)[1]).toEqual({ type: "text", content: (parts[1] as { content: string }).content });
  });

  test("copy to project writes file events", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    const res = await upload(w.slug, t.id, w.a.cookie, "RFQ_ACME.pdf", PDF);
    const { ref } = (await res.json()) as { ref: FileRef };
    const [copied] = await copyToProject(w.tenantId, w.projectId, { userId: w.a.userId, side: "internal" }, [ref]);
    expect(copied).toMatchObject({ kind: "project", name: "RFQ_ACME.pdf" });
    const [row] = await db.select().from(projectFile).where(eq(projectFile.id, copied!.id));
    expect(row!.data.equals(PDF)).toBe(true);
    const events = await db.select().from(configProjectEvent)
      .where(and(eq(configProjectEvent.projectId, w.projectId), eq(configProjectEvent.kind, "file")));
    expect(events).toHaveLength(1);
  });
});
