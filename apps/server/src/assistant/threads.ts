import { ORPCError } from "@orpc/server";
import type { ContentPart, ModelMessage } from "@tanstack/ai";
import { and, desc, eq, isNull, or, lt, sql } from "drizzle-orm";
import { db, assistantThread, configProject } from "@confire/db";
import { internalVisible } from "../project-lifecycle.ts";
import { fileBytes, type Fence, type FileMeta, type FileRef } from "./files.ts";

// The assistant's threads (assistant spec §4.7): server-owned history, loaded by id and never taken
// from the client. Append-only — Sonnet 5.5 refuses edited history (preserved thinking), so nothing
// here rewrites or deletes a stored message — and one run at a time per thread, under a lease.

export type Thread = { id: string; tenantId: string; userId: string; projectId: string | null; messages: ModelMessage[] };

const cols = {
  id: assistantThread.id, tenantId: assistantThread.tenantId, userId: assistantThread.userId,
  projectId: assistantThread.projectId, messages: assistantThread.messages,
};
// The one cast: @confire/db types the column loosely so it takes no @tanstack/ai dependency.
const asThread = (r: { messages: Record<string, unknown>[] } & Omit<Thread, "messages">): Thread =>
  ({ ...r, messages: r.messages as unknown as ModelMessage[] });

/** The user's thread for a configuration (created on first use; the configuration must be one staff
 *  may see), or with no configuration their latest general thread, or a new one. */
export async function threadFor(tenantId: string, userId: string, projectId: string | null): Promise<Thread> {
  if (projectId) {
    const [p] = await db.select({ id: configProject.id }).from(configProject)
      .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId), internalVisible)).limit(1);
    if (!p) throw new ORPCError("NOT_FOUND");
    // The partial unique index (tenant, user, project) is what makes two first opens one thread.
    await db.insert(assistantThread).values({ tenantId, userId, projectId }).onConflictDoNothing();
    const [t] = await db.select(cols).from(assistantThread).where(and(
      eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId), eq(assistantThread.projectId, projectId),
    )).limit(1);
    return asThread(t!);
  }
  const [latest] = await db.select(cols).from(assistantThread)
    .where(and(eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId), isNull(assistantThread.projectId)))
    .orderBy(desc(assistantThread.updatedAt), desc(assistantThread.createdAt)).limit(1);
  return latest ? asThread(latest) : newThread(tenantId, userId);
}

export async function newThread(tenantId: string, userId: string): Promise<Thread> {
  const [t] = await db.insert(assistantThread).values({ tenantId, userId }).returning(cols);
  return asThread(t!);
}

/** A configuration's chat starts over (the panel's New chat there): its thread is deleted, under the
 *  lease so never mid-answer, and a new empty one takes its place. Deleted, not kept: the unique index
 *  allows one per (user, configuration) and there is no thread list to reach an old one from. What the
 *  chat filled stays on the configuration (`sources`); `ai_usage` rows keep their thread id. */
export async function clearThread(tenantId: string, userId: string, projectId: string): Promise<Thread> {
  const t = await threadFor(tenantId, userId, projectId);
  await withThread(t.id, () => db.delete(assistantThread).where(eq(assistantThread.id, t.id)));
  return threadFor(tenantId, userId, projectId);
}

/** A thread of this user in this workspace, or NOT_FOUND. */
export async function ownThread(tenantId: string, userId: string, threadId: string): Promise<Thread> {
  const [t] = await db.select(cols).from(assistantThread).where(and(
    eq(assistantThread.id, threadId), eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId),
  )).limit(1);
  if (!t) throw new ORPCError("NOT_FOUND");
  return asThread(t);
}

/** One run at a time: a five-minute lease taken in one UPDATE. A second tab sending meanwhile is
 *  refused rather than interleaved into the history. The streamed chat takes and releases it around
 *  its run; everything else goes through `withThread`. */
export async function takeLease(threadId: string): Promise<void> {
  const taken = await db.update(assistantThread)
    .set({ busyUntil: sql`now() + interval '5 minutes'` })
    .where(and(eq(assistantThread.id, threadId), or(isNull(assistantThread.busyUntil), lt(assistantThread.busyUntil, sql`now()`))))
    .returning({ id: assistantThread.id });
  if (!taken.length) throw new ORPCError("THREAD_BUSY", { message: "This chat is still answering — wait for it to finish" });
}

export async function releaseLease(threadId: string): Promise<void> {
  await db.update(assistantThread).set({ busyUntil: null }).where(eq(assistantThread.id, threadId));
}

/** `fn` under the thread's lease, released when it settles. */
export async function withThread<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  await takeLease(threadId);
  try {
    return await fn();
  } finally {
    await releaseLease(threadId);
  }
}

/** Append, never replace. The title is set once, by the first append that names one. */
export async function appendMessages(threadId: string, msgs: ModelMessage[], title?: string): Promise<void> {
  await db.update(assistantThread).set({
    messages: sql`${assistantThread.messages} || ${JSON.stringify(msgs)}::jsonb`,
    updatedAt: new Date(),
    ...(title ? { title: sql`case when ${assistantThread.title} = '' then ${title} else ${assistantThread.title} end` } : {}),
  }).where(eq(assistantThread.id, threadId));
}

/** A general thread that started a configuration becomes that configuration's thread. */
export async function linkProject(threadId: string, projectId: string): Promise<void> {
  await db.update(assistantThread).set({ projectId, updatedAt: new Date() }).where(eq(assistantThread.id, threadId));
}

const fileOf = (p: ContentPart): FileRef | null =>
  (p.type === "document" || p.type === "image") ? ((p.metadata as FileMeta | undefined)?.file ?? null) : null;

/**
 * An earlier run's message as the model is sent it: without its thinking. Thinking is signed against
 * the conversation it was made in, prompts and tools included, and ours change between runs (the
 * page's section and tools, the model block, a deploy): replayed, a block is refused — "Invalid
 * `signature` in `thinking` block. The block is bound to a different conversation" (400, verified
 * 2026-10-28). A run's own thinking still goes back within the run, where nothing changes. The stored
 * message keeps it, so the panel still shows it.
 */
export function withoutThinking(m: ModelMessage): ModelMessage {
  if (!m.thinking?.length) return m;
  const { thinking: _t, blockOrder, ...rest } = m;
  const order = blockOrder?.filter((b) => b.type !== "thinking");
  return order?.length ? { ...rest, blockOrder: order } : rest;
}

/** A message as it is stored: every file part keeps its reference and drops its bytes. */
export function dehydrate(m: ModelMessage): ModelMessage {
  if (!Array.isArray(m.content)) return m;
  return {
    ...m,
    content: m.content.map((p) => (fileOf(p) && (p.type === "document" || p.type === "image") && p.source.type === "data"
      ? { ...p, source: { ...p.source, value: "" } } : p)) as ContentPart[],
  };
}

/** Stored messages as the model reads them: each file part's bytes loaded again by its reference. */
export async function hydrate(tenantId: string, ms: ModelMessage[], fence: Fence = {}): Promise<ModelMessage[]> {
  const refs = ms.flatMap((m) => (Array.isArray(m.content) ? m.content.map(fileOf).filter((r): r is FileRef => !!r) : []));
  if (!refs.length) return ms;
  const bytes = await fileBytes(tenantId, refs, fence);
  return ms.map((m) => !Array.isArray(m.content) ? m : {
    ...m,
    content: m.content.map((p) => {
      const ref = fileOf(p);
      const data = ref && bytes.get(ref.id);
      return data && (p.type === "document" || p.type === "image") && p.source.type === "data"
        ? { ...p, source: { ...p.source, value: data.toString("base64") } } : p;
    }) as ContentPart[],
  });
}

/** The files and text of the last user message that carried files: what a re-read reads. */
export function lastDrop(ms: ModelMessage[]): { refs: FileRef[]; text: string } | null {
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]!;
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    const refs = m.content.map(fileOf).filter((r): r is FileRef => !!r);
    if (!refs.length) continue;
    const text = m.content
      .filter((p) => p.type === "text" && !(p.metadata as { fileLabel?: boolean } | undefined)?.fileLabel)
      .map((p) => (p.type === "text" ? p.content : "")).join("\n");
    return { refs, text };
  }
  return null;
}
