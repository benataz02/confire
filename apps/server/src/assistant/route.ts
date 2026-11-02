import { Hono, type Context } from "hono";
import * as Sentry from "@sentry/bun";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  chat, chatParamsFromRequestBody, maxIterations, toServerSentEventsResponse,
  type AgentLoopStrategy, type ChatMiddleware, type ModelMessage, type UIMessage,
} from "@tanstack/ai";
import { and, eq } from "drizzle-orm";
import { configProject } from "@confire/db";
import { auth } from "../auth.ts";
import { configView } from "../config-view.ts";
import { membershipOf } from "../orpc/base.ts";
import { internalVisible } from "../project-lifecycle.ts";
import { errorStatus } from "../serve.ts";
import { TENANT_HEADER } from "../tenant.ts";
import { modelBlock } from "./extract.ts";
import { modelOptions, textAdapter } from "./model.ts";
import { CONFIGURE_CHAT, GENERAL, languageLine, LANGUAGES, pageFor, SYSTEM } from "./pages.ts";
import { appendMessages, dehydrate, hydrate, ownThread, releaseLease, takeLease, withoutThinking } from "./threads.ts";
import { unlabeled } from "./files.ts";
import { ASK_USER, B1_WRITES, toolsFor } from "./tools.ts";
import { assertAssistant, meter, rateLimit, REFUSAL_STATUS, type Meter } from "./usage.ts";
import { localizeError, t } from "../i18n/index.ts";

// POST /api/assistant (assistant spec §4.8): one chat turn, streamed as AG-UI events over SSE. The
// staff process mounts it; the portal has no assistant. The client sends its page and the user's
// text; the history is the server's own (the thread), so a client cannot put words in the
// assistant's mouth. Tools run through their procedures' builders with this request's headers.

const MAX_TEXT = 20_000;
const CACHE = { cache_control: { type: "ephemeral" as const } };

const PropsZ = z.object({
  route: z.object({ routeId: z.string(), params: z.record(z.string(), z.string()) }),
  dirty: z.boolean(),
  language: z.enum(Object.keys(LANGUAGES) as [keyof typeof LANGUAGES, ...(keyof typeof LANGUAGES)[]]),
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

/** Up to 12 model turns, and none after the model asked the user or proposed a SAP write: the engine
 *  consults this only once a turn's tools have run, so the stored history ends on that result and the
 *  answer (the pick, "Posted Order 1234") is the user's next message. */
export const untilAsked: AgentLoopStrategy = (s) => {
  const last = s.messages.findLast((m) => m.role === "assistant");
  return maxIterations(12)(s) && !last?.toolCalls?.some((c) => c.function.name === ASK_USER) && !proposed(s.messages);
};

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

export function assistantRoutes(): Hono {
  const app = new Hono();
  app.post("/api/assistant", async (c) => {
    const headers = c.req.raw.headers;
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session) return c.json({ code: "UNAUTHORIZED", message: t("SIGN_IN_AGAIN") }, 401);
    const userId = session.user.id;

    let tenantId: string;
    let thread: Awaited<ReturnType<typeof ownThread>>;
    let text: string;
    let props: z.infer<typeof PropsZ>;
    let ids: { threadId: string; runId: string };
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
      if (!text) throw new ORPCError("BAD_REQUEST", { message: t("CHAT_EMPTY") });
      if (text.length > MAX_TEXT) throw new ORPCError("BAD_REQUEST", { message: t("CHAT_TOO_LONG", MAX_TEXT) });
      ids = { threadId: thread.id, runId: params.runId };
      await takeLease(thread.id);
    } catch (e) {
      return refusal(c, e);
    }

    // The thread says what the chat is about, the route only whether its form is on screen: a
    // configuration's chat works on it from any page (one the chat just created, the panel on another
    // page), and a configure page whose thread is no configuration's is a general page.
    const hinted = pageFor(props.route.routeId);
    const page = thread.projectId ? (hinted.kind === "configure" ? hinted : CONFIGURE_CHAT)
      : hinted.kind === "configure" ? GENERAL : hinted;
    const user: ModelMessage = { role: "user", content: text };
    let hydrated: ModelMessage[];
    let block: string | null = null;
    let name: string | undefined;
    try {
      hydrated = await hydrate(tenantId, thread.messages, { threadId: thread.id, ...(thread.projectId ? { projectId: thread.projectId } : {}) });
      if (page.kind === "configure" && thread.projectId) {
        const where = and(eq(configProject.id, thread.projectId), eq(configProject.tenantId, tenantId), internalVisible)!;
        const { live, view } = await configView(tenantId, where).catch(() => ({ live: null, view: null }));
        if (live && view) { block = modelBlock(live.model.definition, view.form, live.lookups.tables); name = view.project.name; }
      }
    } catch (e) {
      await releaseLease(thread.id);
      return refusal(c, e);
    }

    // Saved once, whichever way the run ends; the lease is released after. An error or an abort keeps
    // the user's message alone — never lost, and two user turns in a row are valid history.
    let saved = false;
    const save = async (msgs: ModelMessage[]) => {
      if (saved) return;
      saved = true;
      try {
        await appendMessages(thread.id, msgs.map(dehydrate), text.slice(0, 80));
      } finally {
        await releaseLease(thread.id);
      }
    };
    const saver: ChatMiddleware = {
      name: "save",
      onFinish: (ctx) => save([user, ...ctx.messages.slice(hydrated.length + 1)]),
      onError: () => save([user]),
      onAbort: () => save([user]),
    };

    const m: Meter = { tenantId, userId, threadId: thread.id, projectId: thread.projectId, kind: "chat" };
    const abortController = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abortController.abort());
    const stream = chat({
      adapter: textAdapter(),
      ...ids,
      messages: [...hydrated.map((h) => withoutThinking(Array.isArray(h.content) ? { ...h, content: unlabeled(h.content) } : h)), user],
      systemPrompts: [
        { content: SYSTEM, metadata: CACHE },
        ...(block ? [{ content: block, metadata: CACHE }] : []),
        page.section({ projectId: thread.projectId ?? undefined, name, dirty: props.dirty }),
        languageLine(props.language),
      ],
      tools: toolsFor(page, { headers, tenantId, userId, thread, meter: m }),
      modelOptions: modelOptions(),
      agentLoopStrategy: untilAsked,
      // The model's default effort, with its thinking summarized so the panel can show it.
      reasoning: { level: "high", summary: true },
      promptCache: "short",
      middleware: [meter(m), saver],
      abortController,
    });
    return toServerSentEventsResponse(stream, { abortController });
  });
  return app;
}
