import { ORPCError } from "@orpc/server";
import type { ContentPart, ModelMessage } from "@tanstack/ai";
import { and, desc, eq, ilike, isNull, or, lt, sql } from "drizzle-orm";
import { db, assistantFile, assistantReport, assistantThread, configProject } from "@confire/db";
import { internalVisible } from "../project-lifecycle.ts";
import { fileBytes, type Fence, type FileMeta, type FileRef } from "./files.ts";
import { cachedSheetText } from "./sheet.ts";
import { t as text } from "../i18n/index.ts";

// The assistant's threads (assistant spec §4.7): server-owned history, loaded by id and never taken
// from the client. Append-only — Sonnet 5.5 refuses edited history (preserved thinking), so nothing
// here rewrites or deletes a stored message — and one run at a time per thread, under a lease.

/** `projectId`: a configuration's chat; `reportId`: a report's (reports spec §4); neither: a general chat. */
export type Thread = { id: string; tenantId: string; userId: string; projectId: string | null; reportId: string | null; messages: ModelMessage[] };

const cols = {
  id: assistantThread.id, tenantId: assistantThread.tenantId, userId: assistantThread.userId,
  projectId: assistantThread.projectId, reportId: assistantThread.reportId, messages: assistantThread.messages,
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
    .where(and(eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId), isNull(assistantThread.projectId), isNull(assistantThread.reportId)))
    .orderBy(desc(assistantThread.updatedAt), desc(assistantThread.createdAt)).limit(1);
  return latest ? asThread(latest) : newThread(tenantId, userId);
}

export async function newThread(tenantId: string, userId: string): Promise<Thread> {
  const [t] = await db.insert(assistantThread).values({ tenantId, userId }).returning(cols);
  return asThread(t!);
}

/** New chat with no configuration: the user's blank one if there is one (no message, no file, not
 *  answering), made the latest again, so New chat over and over leaves no trail of empty
 *  chats. Else a new one. */
export async function blankThread(tenantId: string, userId: string): Promise<Thread> {
  const [t] = await db.update(assistantThread).set({ updatedAt: new Date() }).where(and(
    eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId), isNull(assistantThread.projectId),
    isNull(assistantThread.reportId),
    sql`jsonb_array_length(${assistantThread.messages}) = 0`,
    or(isNull(assistantThread.busyUntil), lt(assistantThread.busyUntil, sql`now()`)),
    sql`not exists (select 1 from ${assistantFile} where ${assistantFile.threadId} = ${assistantThread.id})`,
  )).returning(cols);
  return t ? asThread(t) : newThread(tenantId, userId);
}

export type ThreadRow = {
  id: string; title: string; projectId: string | null; projectName: string | null;
  reportId: string | null; reportTitle: string | null; pinned: boolean; updatedAt: Date;
};

/** The panel's chat drawer: the user's chats with anything in them, pinned first, then the latest. `q`
 *  matches the title, the configuration's name, and the words of the chat — the user's and the
 *  assistant's text, not tool output, which holds field names that would match nearly anything. */
// ponytail: the latest 100, and a search scans the user's own jsonb; paging and a tsvector column once
// someone has that many chats.
export async function listThreads(tenantId: string, userId: string, q?: string): Promise<ThreadRow[]> {
  const like = q?.trim() ? `%${q.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  const said = sql`exists (select 1 from jsonb_array_elements(${assistantThread.messages}) m
    where m->>'role' in ('user', 'assistant') and case jsonb_typeof(m->'content')
      when 'string' then m->>'content'
      when 'array' then (select string_agg(p->>'content', ' ') from jsonb_array_elements(m->'content') p
        where p->>'type' = 'text' and coalesce(p->'metadata'->>'pageContext', '') <> 'true')
    end ilike ${like})`;
  return db.select({
    id: assistantThread.id, title: assistantThread.title, projectId: assistantThread.projectId,
    projectName: configProject.name, reportId: assistantThread.reportId, reportTitle: assistantReport.title,
    pinned: assistantThread.pinned, updatedAt: assistantThread.updatedAt,
  }).from(assistantThread)
    .leftJoin(configProject, eq(configProject.id, assistantThread.projectId))
    .leftJoin(assistantReport, eq(assistantReport.id, assistantThread.reportId))
    .where(and(
      eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId),
      sql`jsonb_array_length(${assistantThread.messages}) > 0`,
      like ? or(ilike(assistantThread.title, like), ilike(configProject.name, like), ilike(assistantReport.title, like), said) : undefined,
    ))
    .orderBy(desc(assistantThread.pinned), desc(assistantThread.updatedAt))
    .limit(100);
}

/** Rename or pin one of the user's chats. `updatedAt` stays, so the list keeps its order. */
export async function setThread(tenantId: string, userId: string, id: string, set: { title?: string; pinned?: boolean }): Promise<void> {
  const r = await db.update(assistantThread).set(set).where(and(
    eq(assistantThread.id, id), eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId),
  )).returning({ id: assistantThread.id });
  if (!r.length) throw new ORPCError("NOT_FOUND");
}

/** Delete one of the user's chats, under the lease so never mid-answer. Its dropped files go with it;
 *  what it filled stays on its configuration (`sources`), and `ai_usage` rows keep its id. */
export async function deleteThread(tenantId: string, userId: string, id: string): Promise<void> {
  const t = await ownThread(tenantId, userId, id);
  await withThread(t.id, () => db.delete(assistantThread).where(eq(assistantThread.id, t.id)));
}

/** A thread of this user in this workspace, or NOT_FOUND. */
export async function ownThread(tenantId: string, userId: string, threadId: string): Promise<Thread> {
  const [t] = await db.select(cols).from(assistantThread).where(and(
    eq(assistantThread.id, threadId), eq(assistantThread.tenantId, tenantId), eq(assistantThread.userId, userId),
  )).limit(1);
  if (!t) throw new ORPCError("NOT_FOUND");
  return asThread(t);
}

/** One run at a time: a five-minute lease taken in one UPDATE, held by the id it answers. A second
 *  tab sending meanwhile is refused rather than interleaved into the history. The streamed chat takes
 *  it, renews it on every model call (`renewLease`) and releases it; everything else goes through
 *  `withThread`. Only the holder renews or releases: a run that outlived its lease cannot free the
 *  next run's. */
export async function takeLease(threadId: string): Promise<string> {
  const leaseId = crypto.randomUUID();
  const taken = await db.update(assistantThread)
    .set({ busyUntil: sql`now() + interval '5 minutes'`, leaseId })
    .where(and(eq(assistantThread.id, threadId), or(isNull(assistantThread.busyUntil), lt(assistantThread.busyUntil, sql`now()`))))
    .returning({ id: assistantThread.id });
  if (!taken.length) throw new ORPCError("THREAD_BUSY", { message: text("CHAT_BUSY") });
  return leaseId;
}

/** Five more minutes for the holder; false when the lease is no longer its own. */
export async function renewLease(threadId: string, leaseId: string): Promise<boolean> {
  const r = await db.update(assistantThread).set({ busyUntil: sql`now() + interval '5 minutes'` })
    .where(and(eq(assistantThread.id, threadId), eq(assistantThread.leaseId, leaseId)))
    .returning({ id: assistantThread.id });
  return r.length > 0;
}

export async function releaseLease(threadId: string, leaseId: string): Promise<void> {
  await db.update(assistantThread).set({ busyUntil: null, leaseId: null })
    .where(and(eq(assistantThread.id, threadId), eq(assistantThread.leaseId, leaseId)));
}

/** `fn` under the thread's lease, released when it settles. */
export async function withThread<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const lease = await takeLease(threadId);
  try {
    return await fn();
  } finally {
    await releaseLease(threadId, lease);
  }
}

/** Each message with when it was stored (`metadata.at`), for the panel's stamps; one already stamped
 *  keeps its time. On the message, never on a part: the Anthropic adapter copies a part's metadata
 *  onto Claude's block, which refuses unknown keys (400, see `unlabeled`), and never reads a
 *  message's (`@tanstack/ai-anthropic` 1.0.0, `adapters/text.js`) — where `prefix` already lives, so
 *  the stamp never reaches the prompt or `prefixHash`. */
export function stamped(msgs: ModelMessage[], at: Date): ModelMessage[] {
  return msgs.map((m) => ((m.metadata as MessageMeta | undefined)?.at ? m : { ...m, metadata: { ...m.metadata, at: at.toISOString() } }));
}

/** Append, never replace, and answer what was stored. The title is set once, by the first append
 *  that names one. */
export async function appendMessages(threadId: string, msgs: ModelMessage[], title?: string): Promise<ModelMessage[]> {
  const stored = stamped(msgs, new Date());
  await db.update(assistantThread).set({
    messages: sql`${assistantThread.messages} || ${JSON.stringify(stored)}::jsonb`,
    updatedAt: new Date(),
    ...(title ? { title: sql`case when ${assistantThread.title} = '' then ${title} else ${assistantThread.title} end` } : {}),
  }).where(eq(assistantThread.id, threadId));
  return stored;
}

/** A general thread that started a configuration becomes that configuration's thread. */
export async function linkProject(threadId: string, projectId: string): Promise<void> {
  await db.update(assistantThread).set({ projectId, updatedAt: new Date() }).where(eq(assistantThread.id, threadId));
}

/** The file a part carries: a PDF or an image, or a spreadsheet read as text (sheet.ts). */
const fileOf = (p: ContentPart): FileRef | null =>
  (p.type === "document" || p.type === "image" || p.type === "text") ? ((p.metadata as FileMeta | undefined)?.file ?? null) : null;

/** A user turn's page context (route.ts `contextPart`): what the user is looking at, for the model
 *  only. It rides in the stored turn, so the prompt prefix stays the same from turn to turn; the
 *  panel, the chat search and `lastDrop` never show it. */
export const isContext = (p: ContentPart): boolean =>
  p.type === "text" && !!(p.metadata as { pageContext?: boolean } | undefined)?.pageContext;

/** Stored messages as the panel gets them: without the page context parts. */
export function withoutContext(ms: ModelMessage[]): ModelMessage[] {
  return ms.map((m) => (m.role === "user" && Array.isArray(m.content) && m.content.some(isContext)
    ? { ...m, content: m.content.filter((p) => !isContext(p)) } : m));
}

/** What an assistant message records about the run that produced it. `prefix` is the hash of that
 *  run's system prompts and tools (route.ts `prefixHash`); `resetThinking` on a user turn marks a
 *  thinking refusal, after which nothing older is replayed. `at` is when it was stored (`stamped`). */
export type MessageMeta = { prefix?: string; resetThinking?: boolean; at?: string };
const metaOf = (m: ModelMessage) => (m.metadata ?? {}) as MessageMeta;

/** An earlier run's message without its thinking. */
export function withoutThinking(m: ModelMessage): ModelMessage {
  if (!m.thinking?.length) return m;
  const { thinking: _t, blockOrder, ...rest } = m;
  const order = blockOrder?.filter((b) => b.type !== "thinking");
  return order?.length ? { ...rest, blockOrder: order } : rest;
}

/**
 * Stored messages with the thinking that may be sent back. A thinking block is signed against the
 * conversation it was made in — system prompts and tools included — and replayed into another one it
 * is refused: "Invalid `signature` in `thinking` block. The block is bound to a different
 * conversation" (400, verified 2026-10-28). So a block goes back only when its run's prefix hash is
 * this run's (the same prompts, tools, model, effort and adapter), and never from before a
 * `resetThinking` turn. A message stripped once is stripped in every later run with this prefix too,
 * so what a kept block was made against is what it is sent with. The stored message keeps its
 * thinking either way, so the panel still shows it.
 */
export function replayable(ms: ModelMessage[], prefix: string): ModelMessage[] {
  const reset = ms.findLastIndex((m) => m.role === "user" && metaOf(m).resetThinking);
  return ms.map((m, i) => (m.role === "assistant" && (i < reset || metaOf(m).prefix !== prefix) ? withoutThinking(m) : m));
}

/** A message as it is stored: every file part keeps its reference and drops its bytes. */
export function dehydrate(m: ModelMessage): ModelMessage {
  if (!Array.isArray(m.content)) return m;
  return {
    ...m,
    content: m.content.map((p) => !fileOf(p) ? p
      : p.type === "text" ? { ...p, content: "" }
      : (p.type === "document" || p.type === "image") && p.source.type === "data" ? { ...p, source: { ...p.source, value: "" } } : p) as ContentPart[],
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
      if (!data) return p;
      if (p.type === "text") return { ...p, content: cachedSheetText(ref.id, ref.name, data) ?? "" };
      return (p.type === "document" || p.type === "image") && p.source.type === "data"
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
      .filter((p) => p.type === "text" && !(p.metadata as { fileLabel?: boolean } | undefined)?.fileLabel && !isContext(p) && !fileOf(p))
      .map((p) => (p.type === "text" ? p.content : "")).join("\n");
    return { refs, text };
  }
  return null;
}
