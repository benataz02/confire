import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { db, assistantFile, configModel, configProjectEvent, projectFile } from "@confire/db";
import { assistantFileRoutes, copyToProject, type FileRef } from "../src/assistant/files.ts";
import {
  appendMessages, dehydrate, hydrate, lastDrop, newThread, ownThread, threadFor, withThread,
} from "../src/assistant/threads.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// Threads (assistant spec §4.7): one per (user, configuration) plus general ones, server-owned,
// append-only, one run at a time; their dropped files stored apart and referenced, never inlined.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const PDF = Buffer.from("%PDF-1.7 drawing");

async function world() {
  const { tenantId, slug } = await makeTenant();
  const a = await makeUser("member", tenantId);
  const b = await makeUser("member", tenantId);
  const [m] = await db.insert(configModel).values({ tenantId, name: "Cable", definition: TEST_MODEL }).returning({ id: configModel.id });
  const ctx = { context: { headers: tenantHeaders(slug, a.cookie) } };
  const { id: projectId } = await call(router.configs.create, { modelId: m!.id, name: "Cable", customer: null }, ctx);
  return { tenantId, slug, a, b, projectId };
}

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

  test("one run per thread", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    const first = withThread(t.id, () => new Promise((r) => setTimeout(r, 50)));
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
    const [back] = await hydrate(w.tenantId, stored.messages);
    expect((back!.content as { source?: { value: string } }[])[0]!.source!.value).toBe(PDF.toString("base64"));
    expect(lastDrop(stored.messages)).toEqual({ refs: [ref], text: "50 pcs" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("assistant files", () => {
  const upload = (slug: string, threadId: string, cookie: string, name: string, body: Buffer) =>
    assistantFileRoutes().request(`/files/${slug}/assistant/${threadId}?name=${encodeURIComponent(name)}`, {
      method: "POST", body: new Uint8Array(body), headers: { cookie },
    });

  test("only PDF, PNG and JPEG, by their bytes", async () => {
    const w = await world();
    const t = await newThread(w.tenantId, w.a.userId);
    const docx = await upload(w.slug, t.id, w.a.cookie, "rfq.pdf", Buffer.from("PK\x03\x04 word document"));
    expect(docx.status).toBe(415);
    expect(((await docx.json()) as { message: string }).message).toContain("PDF, PNG and JPEG");
    expect(await db.select().from(assistantFile).where(eq(assistantFile.threadId, t.id))).toHaveLength(0);
    const pdf = await upload(w.slug, t.id, w.a.cookie, "x.bin", PDF);
    expect(pdf.status).toBe(201);
    expect(((await pdf.json()) as { ref: FileRef }).ref).toMatchObject({ kind: "assistant", name: "x.bin", mime: "application/pdf" });
    // someone else's thread is not a place to upload to
    expect((await upload(w.slug, t.id, w.b.cookie, "y.pdf", PDF)).status).toBe(404);
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
