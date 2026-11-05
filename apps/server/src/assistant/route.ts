import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import * as Sentry from "@sentry/bun";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  chat, chatParamsFromRequestBody, maxIterations, toServerSentEventsResponse,
  type AgentLoopStrategy, type AnyServerTool, type ChatMiddleware, type ContentPart, type ModelMessage, type StreamChunk, type UIMessage,
} from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { configProject } from "@confire/db";
import { auth } from "../auth.ts";
import { configView } from "../config-view.ts";
import { membershipOf } from "../orpc/base.ts";
import { internalVisible } from "../project-lifecycle.ts";
import { errorStatus } from "../serve.ts";
import { TENANT_HEADER } from "../tenant.ts";
import { chatHasClientContent, readsClientContent } from "./auto.ts";
import { modelBlock } from "./extract.ts";
import { ASSISTANT_MODEL, CHAT_EFFORT, modelOptions, textAdapter } from "./model.ts";
import { CONFIGURE_CHAT, contextText, GENERAL, LANGUAGES, pageFor, REPORT, SYSTEM } from "./pages.ts";
import { LOAD_SKILL, SKILLS, SKILLS_FINGERPRINT } from "./skills.ts";
import {
  appendMessages, dehydrate, hydrate, ownThread, releaseLease, renewLease, replayable, takeLease, type MessageMeta,
} from "./threads.ts";
import { fileParts, FileRefZ, unlabeled, type FileRef } from "./files.ts";
import { ASK_USER, B1_WRITES, chatTools, type Taint } from "./tools.ts";
import { assertAssistant, budget, meter, rateLimit, REFUSAL_STATUS, type Meter } from "./usage.ts";
import { localizeError, t } from "../i18n/index.ts";

// POST /api/assistant (assistant spec §4.8): one chat turn, streamed as AG-UI events over SSE. The
// staff process mounts it; the portal has no assistant. The client sends its page and the user's
// text; the history is the server's own (the thread), so a client cannot put words in the
// assistant's mouth. Tools run through their procedures' builders with this request's headers.
//
// What the model is sent before the conversation — the tools, SYSTEM, the thread's model block — is
// the same from turn to turn; what changes per turn (the page, the language) opens the user's turn.
// So the prompt cache reads the whole history back, and an earlier turn's thinking can be replayed.

const MAX_TEXT = 20_000;
const CACHE = { cache_control: { type: "ephemeral" as const } };

/**
 * The chat's provider options. `cache_control` at the top is Claude's automatic caching: a marker on
 * the request's last block, so each model call of a run (up to 12) and the next turn read the history
 * from the cache. It must be set here: the system prompts carry markers of their own, and the adapter
 * then adds none (`promptCache` is a no-op once a request has a marker), so without it the history
 * was never cached. Context editing clears old tool results server-side once a long chat passes 80k
 * input tokens — at least 20k at a time, so the cache it invalidates is worth it — keeping the last 8
 * and never what was read off the client's files, asked, or a loaded skill.
 */
export const CHAT_OPTIONS = {
  cache_control: { type: "ephemeral" },
  context_management: {
    edits: [{
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 80_000 },
      keep: { type: "tool_uses", value: 8 },
      clear_at_least: { type: "input_tokens", value: 20_000 },
      exclude_tools: ["read_request", "extract_values", ASK_USER, LOAD_SKILL],
    }],
  },
} as const;

const PropsZ = z.object({
  route: z.object({ routeId: z.string(), params: z.record(z.string(), z.string()) }),
  dirty: z.boolean(),
  language: z.enum(Object.keys(LANGUAGES) as [keyof typeof LANGUAGES, ...(keyof typeof LANGUAGES)[]]),
  /** Files dropped with this turn, uploaded first (files.ts): the chat decides what they are for. */
  refs: z.array(FileRefZ).max(10).optional(),
});

/** A SAP write of the last turn answered a proposal: it waits for the user's click (b1-tools §5.6). */
export function proposed(messages: ModelMessage[]): boolean {
  const at = messages.findLastIndex((m) => m.role === "assistant");
  const ids = new Set((messages[at]?.toolCalls ?? []).filter((c) => B1_WRITES.has(c.function.name)).map((c) => c.id));
  if (!ids.size) return false;
  return messages.slice(at + 1).some((m) => {
    if (m.role !== "tool" || !ids.has(m.toolCallId ?? "") || typeof m.content !== "string") return false;
    try {
      return (JSON.parse(m.content) as { proposal?: unknown })?.proposal !== undefined;
    } catch {
      return false;
    }
  });
}

/** The tools whose card waits for the user: the choice card, and read_request's proposal (its Create
 *  starts the configuration — the model going on would start a second one). */
const WAITS = new Set([ASK_USER, "read_request"]);

/** Up to 12 model turns, and none after the model asked the user, proposed a configuration or a SAP
 *  write: the engine consults this only once a turn's tools have run, so the stored history ends on
 *  that result and the answer (the pick, "Posted Order 1234") is the user's next message. */
export const untilAsked: AgentLoopStrategy = (s) => {
  const last = s.messages.findLast((m) => m.role === "assistant");
  return maxIterations(12)(s) && !last?.toolCalls?.some((c) => WAITS.has(c.function.name)) && !proposed(s.messages);
};

/**
 * How many of a run's messages make a history that can be stored as it is: the whole run once it
 * finished; else up to the last step whose every tool call has its result (just the user's turn when
 * none has). A run cut short — an API error, a disconnect, the budget — thus keeps every tool that
 * ran: a configuration it created, a value it wrote, a record auto mode posted to SAP (which a retry
 * would otherwise post twice). A half-streamed answer after them is dropped.
 */
export function completeUpTo(msgs: ModelMessage[]): number {
  let cut = msgs.length ? 1 : 0;
  const open = new Set<string>();
  msgs.forEach((m, i) => {
    if (m.role === "assistant") { open.clear(); for (const c of m.toolCalls ?? []) open.add(c.id); }
    if (m.role === "tool") { open.delete(m.toolCallId ?? ""); if (!open.size) cut = i + 1; }
  });
  return cut;
}

/** A message the model never filled (a refusal before any output): nothing to store or send back. */
const empty = (m: ModelMessage) => m.role === "assistant" && !m.toolCalls?.length && !m.thinking?.length
  && (m.content === null || m.content === "" || (Array.isArray(m.content) && !m.content.length));

// The adapter's version is part of the prefix: a new one may put the same tools on the wire differently.
const ADAPTER_VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.resolve("@tanstack/ai-anthropic")), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();

const schemaOf = (s: unknown): unknown => {
  try {
    return s instanceof z.ZodType ? z.toJSONSchema(s, { unrepresentable: "any" }) : s ?? null;
  } catch {
    return String(s);
  }
};

/** What a thinking block is signed against, as one hash: the system prompts, the tools on the wire
 *  (the skills middleware's `load_skill` by its fingerprint),
 *  the model and its thinking settings, the provider options and the adapter. A deploy that changes
 *  any of them changes the hash, and the thinking of earlier runs is then not sent back (threads.ts
 *  `replayable`). Bump THINKING_EPOCH to drop every stored block once. */
const THINKING_EPOCH = 1;
export function prefixHash(system: { content: string }[], tools: AnyServerTool[]): string {
  return createHash("sha256").update(JSON.stringify({
    epoch: THINKING_EPOCH, adapter: ADAPTER_VERSION, model: ASSISTANT_MODEL, effort: CHAT_EFFORT, skills: SKILLS_FINGERPRINT,
    options: { ...modelOptions(), ...CHAT_OPTIONS },
    system: system.map((p) => p.content),
    tools: tools.map((x) => [x.name, x.description, schemaOf(x.inputSchema)]),
  })).digest("hex").slice(0, 32);
}

/** The 400 of a thinking block replayed into a conversation it was not made in (see `replayable`). */
const thinkingRefused = (e: unknown) => /thinking/i.test(String((e as Error)?.message ?? e)) && /signature|bound to a different/i.test(String((e as Error)?.message ?? e));

/** A refusal as JSON with its code, so the panel can say why (off, over budget, busy…). */
function refusal(c: Context, e: unknown) {
  if (e instanceof ORPCError) {
    const status = REFUSAL_STATUS[e.code] ?? errorStatus(e);
    return c.json({ code: e.code, message: (localizeError(e) as ORPCError<string, unknown>).message }, status as 400);
  }
  Sentry.captureException(e);
  return c.json({ code: "INTERNAL_SERVER_ERROR", message: t("SOMETHING_WENT_WRONG") }, 500);
}

/** The text of the client's last message: the only thing taken from its copy of the history. */
function textOf(m: UIMessage | ModelMessage): string {
  if ("parts" in m) return m.parts.map((p) => (p.type === "text" ? p.content : "")).join("");
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.content : "")).join("");
}

/** The CUSTOM event the panel shows a declined answer by (`stop_reason: "refusal"`). */
export const REFUSAL_EVENT = "confire.refusal";

export function assistantRoutes(): Hono {
  const app = new Hono();
  app.post("/api/assistant", async (c) => {
    // Bun closes a socket idle for 10 s, and the stream is silent while the model reads a long turn
    // (two 40k-token b1_reads) and thinks: no timeout for this request. The env is the Bun server
    // (index.ts); tests calling `.request()` have none. A disconnect still aborts the run (abortController).
    (c.env as { timeout?: (req: Request, seconds: number) => void } | undefined)?.timeout?.(c.req.raw, 0);
    const headers = c.req.raw.headers;
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return c.json({ code: "UNAUTHORIZED", message: t("SIGN_IN_AGAIN") }, 401);
    const userId = session.user.id;

    let tenantId: string;
    let thread: Awaited<ReturnType<typeof ownThread>>;
    let text: string;
    let props: z.infer<typeof PropsZ>;
    let ids: { threadId: string; runId: string };
    let lease: string;
    try {
      tenantId = (await membershipOf(headers.get(TENANT_HEADER), userId)).tenantId;
      rateLimit(userId);
      await assertAssistant(tenantId);
      const params = await chatParamsFromRequestBody(await c.req.json()).catch(() => {
        throw new ORPCError("BAD_REQUEST", { message: t("CHAT_NOT_A_REQUEST") });
      });
      const parsed = PropsZ.safeParse(params.forwardedProps);
      if (!parsed.success) throw new ORPCError("BAD_REQUEST", { message: t("CHAT_NO_PAGE") });
      props = parsed.data;
      thread = await ownThread(tenantId, userId, params.threadId);
      // Client-sent tools and history are ignored: the last message's text is all that is taken.
      const last = params.messages.at(-1);
      text = last && last.role === "user" ? textOf(last).trim() : "";
      if (!text && !props.refs?.length) throw new ORPCError("BAD_REQUEST", { message: t("CHAT_EMPTY") });
      if (text.length > MAX_TEXT) throw new ORPCError("BAD_REQUEST", { message: t("CHAT_TOO_LONG", MAX_TEXT) });
      ids = { threadId: thread.id, runId: params.runId };
      lease = await takeLease(thread.id);
    } catch (e) {
      return refusal(c, e);
    }

    // The thread says what the chat is about, the route only whether its form is on screen: a
    // configuration's chat works on it from any page (one the chat just created, the panel on another
    // page), and a configure page whose thread is no configuration's is a general page.
    const hinted = pageFor(props.route.routeId);
    // A report's chat is the report's on any page; no other chat is a report page's.
    const page = thread.reportId ? REPORT
      : thread.projectId ? (hinted.kind === "configure" ? hinted : CONFIGURE_CHAT)
      : hinted.kind === "configure" || hinted.kind === "report" ? GENERAL : hinted;
    let hydrated: ModelMessage[];
    let files: ContentPart[] = [];
    let block: string | null = null;
    let name: string | undefined;
    const taint: Taint = { client: false };
    try {
      const fence = { threadId: thread.id, ...(thread.projectId ? { projectId: thread.projectId } : {}) };
      hydrated = await hydrate(tenantId, thread.messages, fence);
      // A ref outside this chat's fence (another thread's drop, another configuration's file) is
      // refused rather than skipped: the user would otherwise be answered about files never read.
      const refs = (props.refs ?? []) as FileRef[];
      files = refs.length ? await fileParts(tenantId, refs, fence) : [];
      if (files.length !== refs.length * 2) throw new ORPCError("BAD_REQUEST", { message: t("ASSISTANT_FILE_GONE") });
      taint.client = await chatHasClientContent(tenantId, userId, thread.id);
      if (thread.projectId) {
        const where = and(eq(configProject.id, thread.projectId), eq(configProject.tenantId, tenantId), internalVisible)!;
        const { live, view } = await configView(tenantId, where).catch(() => ({ live: null, view: null }));
        if (live && view) { block = modelBlock(live.model.definition, view.form, live.lookups.tables); name = view.project.name; }
      }
    } catch (e) {
      await releaseLease(thread.id, lease);
      return refusal(c, e);
    }

    // The turn as stored: the page's note first (the panel never shows it), then the user's words.
    const contextPart: ContentPart = {
      type: "text",
      content: contextText(page.section({ projectId: thread.projectId ?? undefined, name, dirty: props.dirty }), props.language),
      metadata: { pageContext: true },
    };
    const user: ModelMessage = { role: "user", content: [contextPart, ...files, ...(text ? [{ type: "text" as const, content: text }] : [])] };
    // The run's tools read the drop off the thread (read_request, a configuration started from it).
    if (files.length) thread.messages = [...thread.messages, dehydrate(user)];
    const title = (text || (props.refs ?? []).map((r) => r.name).join(", ")).slice(0, 80);

    const m: Meter = { tenantId, userId, threadId: thread.id, projectId: thread.projectId, kind: "chat" };
    const tools = chatTools({ headers, tenantId, userId, thread, meter: m, taint });
    const systemPrompts = [{ content: SYSTEM, metadata: CACHE }, ...(block ? [{ content: block, metadata: CACHE }] : [])];
    const prefix = prefixHash(systemPrompts, tools);

    // The run's messages are stored as they complete: after each step whose tools have all answered,
    // and once more when it ends, however it ends — so an error or a disconnect never loses what a
    // tool already did. One append at a time, in order; the lease is released after the last.
    let stored = 0;
    let chain: Promise<void> = Promise.resolve();
    const runMessages = (ctx: { messages: ReadonlyArray<ModelMessage> }) => [user, ...ctx.messages.slice(hydrated.length + 1)];
    const mark = (msg: ModelMessage, resetThinking: boolean): ModelMessage => {
      if (msg.role === "assistant") {
        const meta: MessageMeta & { clientContent?: boolean } = { prefix, ...(taint.client ? { clientContent: true } : {}) };
        return { ...msg, metadata: { ...msg.metadata, ...meta } };
      }
      return msg === user && resetThinking ? { ...msg, metadata: { ...msg.metadata, resetThinking: true } } : msg;
    };
    const store = (msgs: ModelMessage[], upTo: number, resetThinking = false) => {
      chain = chain.then(async () => {
        if (upTo <= stored) return;
        const add = msgs.slice(stored, upTo).filter((x) => !empty(x)).map((x) => dehydrate(mark(x, resetThinking)));
        stored = upTo;
        if (add.length) await appendMessages(thread.id, add, title);
      }).catch((e) => { Sentry.captureException(e); });
      return chain;
    };
    const end = async (msgs: ModelMessage[], upTo: number, resetThinking = false) => {
      try {
        await store(msgs, upTo, resetThinking);
      } finally {
        await releaseLease(thread.id, lease);
      }
    };
    const saver: ChatMiddleware = {
      name: "save",
      onIteration: async (ctx, info) => {
        if (info.iteration > 0) { const msgs = runMessages(ctx); await store(msgs, completeUpTo(msgs)); }
        // Each model call renews the lease; one taken over meanwhile stops the run (what ran is kept).
        if (!(await renewLease(thread.id, lease))) ctx.abort("lease lost");
      },
      onFinish: (ctx) => { const msgs = runMessages(ctx); return end(msgs, msgs.length); },
      onError: (ctx, info) => {
        const msgs = runMessages(ctx);
        // A replayed thinking block refused: this turn says so, and no older block is sent again.
        const reset = thinkingRefused(info.error);
        if (reset) Sentry.captureException(info.error);
        return end(msgs, Math.max(completeUpTo(msgs), 1), reset);
      },
      onAbort: (ctx) => { const msgs = runMessages(ctx); return end(msgs, Math.max(completeUpTo(msgs), 1)); },
    };

    // Auto mode's client-content exception, for this run: a tool that reads what a client wrote taints
    // it before it runs, so a SAP write later in the same step is already a proposal (auto.ts).
    const guard: ChatMiddleware = {
      name: "client-content",
      onGuardToolCall: async (_ctx, call) => {
        if (!taint.client && (await readsClientContent(tenantId, call.toolName, call.args))) taint.client = true;
      },
    };

    // A declined answer (`stop_reason: "refusal"`) ends the run with no text: the panel says so.
    const refusals: ChatMiddleware = {
      name: "refusal",
      onChunk: (_ctx, chunk: StreamChunk) => {
        if (chunk.type !== "RUN_FINISHED" || (chunk as { finishReason?: string }).finishReason !== "content_filter") return;
        const category = ((chunk as { rawEvent?: { category?: string | null } }).rawEvent?.category) ?? null;
        return [{ type: "CUSTOM", name: REFUSAL_EVENT, value: { category }, timestamp: Date.now() } as StreamChunk, chunk];
      },
    };

    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort());
    const stream = chat({
      adapter: textAdapter(),
      ...ids,
      messages: [
        ...replayable(hydrated, prefix).map((h) => (Array.isArray(h.content) ? { ...h, content: unlabeled(h.content) } : h)),
        { ...user, content: unlabeled(user.content as ContentPart[]) },
      ],
      systemPrompts,
      tools,
      modelOptions: { ...modelOptions(), ...CHAT_OPTIONS },
      agentLoopStrategy: untilAsked,
      // Thinking summarized, so the panel can show it (and Sonnet 5.5's notes between tool calls).
      reasoning: { level: CHAT_EFFORT, summary: true },
      promptCache: "short",
      middleware: [SKILLS, meter(m), budget(tenantId), guard, refusals, saver],
      abortController,
    });
    return toServerSentEventsResponse(stream, { abortController });
  });
  return app;
}
