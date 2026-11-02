import { z } from "zod";
import * as Sentry from "@sentry/bun";
import { and, eq } from "drizzle-orm";
import { call, ORPCError, type AnyProcedure } from "@orpc/server";
import { getOpenAPIMeta } from "@orpc/openapi";
import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { configProject, ListQueryZ } from "@confire/db";
import { SourcesZ } from "../config-patch.ts";
import { LIST_CAP } from "../entity-read.ts";
import { configView } from "../config-view.ts";
import { internalVisible } from "../project-lifecycle.ts";
import { configsRouter } from "../orpc/routers/configs.ts";
import { entitiesRouter } from "../orpc/routers/entities.ts";
import { b1Router, type Proposal } from "../orpc/routers/b1.ts";
import { reportsRouter } from "../orpc/routers/reports.ts";
import { QUOTE_HEADER, type quoteDraft } from "../config-quote.ts";
import { ToolInputRequiredError } from "@tanstack/ai-mcp/server";
import { homeRouter } from "../orpc/routers/home.ts";
import { requestsRouter, timelineRouter } from "../orpc/routers/requests.ts";
import { startFromThread } from "../orpc/routers/assistant.ts";
import { extractInto, modelBlock } from "./extract.ts";
import { fileParts } from "./files.ts";
import { CUSTOMERS_ONLY, readRequest } from "./intake.ts";
import { lastDrop, type Thread } from "./threads.ts";
import type { Meter } from "./usage.ts";

// The chat's tools (assistant spec §4.5): the existing procedures, called through their own builders
// with the chat request's headers, so the session, the membership join and every procedure's rules
// apply exactly as for the page. Names, descriptions and input schemas come from the procedures. A
// few are stricter than their procedure (calculate needs a source per value) or shaped for a card
// (lists capped at what the card shows). The SAP tools (`b1_*`, b1-tools spec) are the b1 router's
// procedures as they are — MCP gets them bare, so their caps and proposals live in the handlers. Only
// b1_write/b1_copy write to SAP, and outside auto mode they answer a proposal the user posts.

export type ToolCtx = { headers: Headers; tenantId: string; userId: string; thread: Thread; meter: Meter };

export { LIST_CAP };

/** A procedure's error is an answer the model can correct itself from; anything else is a bug, and
 *  its message stays in the log. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ORPCError) throw new Error(e.message || e.code);
    Sentry.captureException(e);
    throw new Error("The tool failed");
  }
}

const capped = (out: unknown) => {
  const o = out as { rows?: unknown[] };
  return Array.isArray(o?.rows) ? { ...o, rows: o.rows.slice(0, LIST_CAP) } : out;
};

/** What a tool's procedure call runs as: the chat request's headers (and its thread), or over MCP the
 *  token's user. */
export type CallCtx = { headers: Headers; thread?: { id: string }; mcpUserId?: string };
/** The chat builds its tools per run around one CallCtx; MCP builds them once (mcp.ts) and reads the
 *  CallCtx off each tool call, which carries its own request's (createMCPServer's `ctx.context`). */
export type CtxOf = CallCtx | ((call: unknown) => CallCtx);
const resolve = (ctx: CtxOf, call: unknown): CallCtx => (typeof ctx === "function" ? ctx(call) : ctx);
// The thread and the MCP user ride in the call's context, which no request can fill: b1.write reads
// the thread for auto mode's file exception, and the MCP user is who the call is (orpc/base.ts).
const contextOf = (c: CallCtx) => ({
  headers: c.headers,
  ...(c.thread ? { assistantThreadId: c.thread.id } : {}),
  ...(c.mcpUserId ? { mcpUserId: c.mcpUserId } : {}),
});

/** A procedure as a tool: `configs.get` is `configs_get`, the same name in the chat and over MCP. */
export function procedureTool(path: string, p: AnyProcedure, ctx: CtxOf, o: {
  name?: string; input?: z.ZodType; describe?: string; slim?: (out: unknown) => unknown; cap?: boolean;
  prepare?: (input: Record<string, unknown>) => Record<string, unknown>;
} = {}): AnyServerTool {
  const meta = getOpenAPIMeta(p);
  const description = [
    o.describe ?? meta?.description ?? meta?.summary ?? path,
    o.cap ? `At most ${LIST_CAP} rows; \`total\` says how many match.` : "",
  ].filter(Boolean).join(" ");
  const inputSchema = o.input ?? (p["~orpc"].inputSchemas?.at(-1) as z.ZodType | undefined) ?? z.object({});
  return toolDefinition({ name: o.name ?? path.replaceAll(".", "_"), description, inputSchema }).server(async (args: unknown, toolCall: unknown) => {
    const c = resolve(ctx, toolCall);
    let input = (args ?? {}) as Record<string, unknown>;
    if (o.cap) input = { ...input, top: Math.min(Number(input.top ?? LIST_CAP) || LIST_CAP, LIST_CAP) };
    if (o.prepare) input = o.prepare(input);
    let out = await run(() => call(p, input, { context: contextOf(c) }));
    if (o.cap) out = capped(out);
    return o.slim ? o.slim(out) : out;
  }) as AnyServerTool;
}

type CalcInput = {
  set?: Record<string, unknown>; tables?: Record<string, unknown>; batches?: unknown;
  customer?: unknown; sources?: Record<string, unknown>;
};

/** Every value a calculate writes without saying where it came from. `unset` and `name` need none. */
export function missingSources(input: CalcInput & Record<string, unknown>): string[] {
  const has = (k: string) => !!input.sources?.[k];
  return [
    ...Object.keys(input.set ?? {}), ...Object.keys(input.tables ?? {}),
    ...(input.batches !== undefined ? ["batches"] : []), ...(input.customer !== undefined ? ["customer"] : []),
  ].filter((k) => !has(k));
}

/** `configs.calculate` with a source required for every written value: no value from nowhere. */
export function sourcedCalculate(ctx: CtxOf): AnyServerTool {
  const base = configsRouter.calculate["~orpc"].inputSchemas!.at(-1) as unknown as z.ZodObject;
  // No margin: it is the shop's commercial call, not a value read off a request.
  const input = base.omit({ margin: true }).extend({
    sources: SourcesZ.describe("Where each written value came from, by field key (a parameter, a table, `batches`, `customer`): `{ file, page, quote }` with the exact text read off a file, or `{ chat }` with the user's own words from this chat."),
  });
  return procedureTool("configs.calculate", configsRouter.calculate as AnyProcedure, ctx, {
    input,
    describe: `${getOpenAPIMeta(configsRouter.calculate)?.description ?? ""} A source is the exact text read from a file (with file and page) or the user's own words from this chat. Never write a value you cannot quote.`,
    prepare: (i) => {
      const missing = missingSources(i as CalcInput);
      if (missing.length) throw new Error(`Not written: every value needs a source, and these have none: ${missing.join(", ")}. Quote the file or the user's words, or ask the user.`);
      return i;
    },
  });
}

/** The quotation as the quote page would post it; the panel draws it with "Review and post". */
export const proposeQuotation = (ctx: ToolCtx): AnyServerTool =>
  procedureTool("configs.quoteDraft", configsRouter.quoteDraft as AnyProcedure, ctx, {
    name: "propose_quotation",
    describe: "Prepare the quotation of a configuration's picks for the user to review: the lines and totals SAP would get. It posts nothing: the user reviews and posts it on the quote page, from the card this shows.",
  });

/** The fields a card needs to draw a row: title, status, figures. Always read, whatever the model
 *  selects, so the card never meets a row without them. */
export const CARD_FIELDS = {
  Quotations: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocCurrency", "DocumentStatus"],
  Orders: ["DocEntry", "DocNum", "CardCode", "CardName", "DocDate", "DocTotal", "DocCurrency", "DocumentStatus"],
  BusinessPartners: ["CardCode", "CardName", "CardType"],
} as const;
type SapEntity = keyof typeof CARD_FIELDS;

/** SAP reads for the chat: three entity sets, the card's fields always in, the total asked for.
 *  Business partners are customers only: the chat looks them up to be a configuration's customer. */
export const readSap = (ctx: CtxOf): AnyServerTool =>
  procedureTool("entities.rows", entitiesRouter.rows as AnyProcedure, ctx, {
    cap: true,
    input: z.object({
      entity: z.enum(Object.keys(CARD_FIELDS) as [SapEntity, ...SapEntity[]]).describe("Which SAP records. BusinessPartners are customers only (CardType cCustomer), whatever the filter says"),
      query: ListQueryZ.describe("Fields, filters, sort and search, with SAP's field names"),
    }),
    prepare: (i) => {
      const entity = i.entity as SapEntity;
      const q = i.query as z.infer<typeof ListQueryZ>;
      const filter = entity === "BusinessPartners" ? [...q.filter, CUSTOMERS_ONLY] : q.filter;
      return { entity, query: { ...q, filter, select: [...new Set([...q.select, ...CARD_FIELDS[entity]])] }, count: true };
    },
  });

/** The panel's two steps, again on the thread's last drop. In every tool set: a thread's history
 *  holds their calls, and a request naming a tool it does not define is refused. */
function rerunTools(ctx: ToolCtx): Record<string, AnyServerTool> {
  const drop = () => {
    const d = lastDrop(ctx.thread.messages);
    if (!d) throw new Error("No files were dropped in this chat yet: ask the user to drop the client's files.");
    return d;
  };
  return {
    read_request: toolDefinition({
      name: "read_request",
      description: "Read the client's last dropped files and text again, and propose the model, the customer and a name. The panel already does this when files are dropped; call it only when the user asks to read them again.",
      inputSchema: z.object({}),
    }).server(async () => {
      const d = drop();
      const parts = await fileParts(ctx.tenantId, d.refs, { threadId: ctx.thread.id, ...(ctx.thread.projectId ? { projectId: ctx.thread.projectId } : {}) });
      return run(() => readRequest(ctx, { parts, text: d.text, meter: { ...ctx.meter, kind: "extract" } }));
    }) as AnyServerTool,
    extract_values: toolDefinition({
      name: "extract_values",
      description: "Read this configuration's values again from the client's last dropped files and text. It fills empty fields only and turns everything else into questions.",
      inputSchema: z.object({}),
    }).server(async () => {
      if (!ctx.thread.projectId) throw new Error("There is no configuration in this chat yet.");
      const projectId = ctx.thread.projectId;
      return run(() => extractInto({ ...ctx, threadId: ctx.thread.id }, projectId, drop()));
    }) as AnyServerTool,
  };
}

/** The SAP tools, each its b1 procedure. `b1.post` is the user's click and never one of them. */
export const B1_TOOLS = ["b1_find", "b1_schema", "b1_read", "b1_write", "b1_copy"] as const;
/** The SAP tools that write: a proposal they answer ends the run (route.ts), like ask_user. */
export const B1_WRITES: ReadonlySet<string> = new Set(["b1_write", "b1_copy"]);

/** The tool's name, which the route's loop strategy stops on. */
export const ASK_USER = "ask_user";

/** A choice for the user, drawn as buttons (the panel's ChoiceCard). The run ends after it: the
 *  pick comes back as the user's next message, so a value written from it has the user's words as
 *  its source. */
const askUser: AnyServerTool = toolDefinition({
  name: ASK_USER,
  description: "Ask the user to choose between known options: which customer, which option of a field, which of two readings, which model. The panel shows the options as buttons and the user may also type an answer. Your turn ends after this call; the answer comes as the user's next message. One question at a time.",
  inputSchema: z.object({
    question: z.string().describe("One short question, in the user's language"),
    options: z.array(z.object({
      label: z.string().describe("The answer as the user would say it, e.g. 'ACME S.L. (C0001)'"),
      description: z.string().optional().describe("Why it may be the one: where it was read, a rule, a past quote"),
    })).min(2).max(6),
  }),
}).server(async () => ({ asked: true, note: "The user answers in their next message." })) as AnyServerTool;

/** The model definition is the model block's, already in the prompt. */
const slimGet = (out: unknown) => {
  const o = out as { model?: { definition?: unknown } };
  if (!o?.model) return out;
  const { definition: _d, ...model } = o.model;
  return { ...o, model };
};

/** Every tool by name, for one chat run. */
function allTools(ctx: ToolCtx): Record<string, AnyServerTool> {
  const t = (path: string, p: unknown, o?: Parameters<typeof procedureTool>[3]) => procedureTool(path, p as AnyProcedure, ctx, o);
  return {
    configs_get: t("configs.get", configsRouter.get, { slim: slimGet }),
    configs_calculate: sourcedCalculate(ctx),
    configs_queryPage: t("configs.queryPage", configsRouter.queryPage, { cap: true }),
    configs_similar: t("configs.similar", configsRouter.similar),
    configs_select: t("configs.select", configsRouter.select),
    configs_models: t("configs.models", configsRouter.models),
    configs_rows: t("configs.rows", configsRouter.rows, { cap: true }),
    configs_create: toolDefinition({
      name: "configs_create",
      description: `${getOpenAPIMeta(configsRouter.create)?.description ?? ""} The chat becomes the new configuration's chat, and the files dropped here become its files. The answer carries its model (parameters, options, rules) and what is still missing, so you can go on with it at once: write what the user already told you with configs_calculate.`,
      inputSchema: configsRouter.create["~orpc"].inputSchemas!.at(-1) as unknown as z.ZodType<{ modelId: string; name: string; customer?: { cardCode: string; cardName: string } | null }>,
    }).server(async (input) => run(async () => {
      const r = await startFromThread(ctx, ctx.thread, input as never);
      ctx.meter.projectId = r.id;
      // The run goes on with this configuration, as its page's chat would: its model block and what is
      // missing. A view that cannot be built yet leaves the run a configs_get away from it.
      const where = and(eq(configProject.id, r.id), eq(configProject.tenantId, ctx.tenantId), internalVisible)!;
      const v = await configView(ctx.tenantId, where).catch(() => null);
      return v ? { ...r, model: modelBlock(v.live.model.definition, v.view.form, v.live.lookups.tables), missing: v.view.missing.map((m) => m.message) } : r;
    })) as AnyServerTool,
    requests_rows: t("requests.rows", requestsRouter.rows, { cap: true }),
    home_overview: t("home.overview", homeRouter.overview),
    timeline_list: t("timeline.list", timelineRouter.list),
    entities_rows: readSap(ctx),
    ...Object.fromEntries(B1_TOOLS.map((n) => [n, t(`b1.${n.slice(3)}`, b1Router[n.slice(3) as keyof typeof b1Router])])),
    reports_sap: t("reports.sap", reportsRouter.sap),
    reports_configs: t("reports.configs", reportsRouter.configs),
    propose_quotation: proposeQuotation(ctx),
    [ASK_USER]: askUser,
    ...rerunTools(ctx),
  };
}

/** The procedure behind a tool name, for checking what a tool set may reach. */
export function procedureOf(name: string): AnyProcedure | undefined {
  const map: Record<string, unknown> = {
    configs_get: configsRouter.get, configs_calculate: configsRouter.calculate, configs_queryPage: configsRouter.queryPage,
    configs_similar: configsRouter.similar, configs_select: configsRouter.select, configs_models: configsRouter.models,
    configs_rows: configsRouter.rows, configs_create: configsRouter.create, requests_rows: requestsRouter.rows,
    home_overview: homeRouter.overview, timeline_list: timelineRouter.list, entities_rows: entitiesRouter.rows,
    propose_quotation: configsRouter.quoteDraft, reports_sap: reportsRouter.sap, reports_configs: reportsRouter.configs,
    ...Object.fromEntries(B1_TOOLS.map((n) => [n, b1Router[n.slice(3) as keyof typeof b1Router]])),
  };
  return map[name] as AnyProcedure | undefined;
}

/** A page's tools, in its order. */
export function toolsFor(page: { tools: string[] }, ctx: ToolCtx): AnyServerTool[] {
  const all = allTools(ctx);
  return page.tools.map((n) => {
    const tool = all[n];
    if (!tool) throw new Error(`No assistant tool '${n}'`);
    return tool;
  });
}

// --- MCP (assistant spec §4.10) ------------------------------------------------------------------

/** What the user's AI may call over MCP: the chat's tools, less those that need a Confire thread
 *  (ask_user — its own chat asks; read_request/extract_values — it reads the files itself;
 *  propose_quotation — it draws a card), with configs_create bare (no thread to adopt it, `via: "mcp"`),
 *  plus the SAP writes, each confirmed by the user before it posts. `b1.post` is never a tool. */
export function mcpTools(ctx: (call: unknown) => CallCtx): AnyServerTool[] {
  const t = (path: string, p: unknown, o?: Parameters<typeof procedureTool>[3]) => procedureTool(path, p as AnyProcedure, ctx, o);
  return [
    t("configs.models", configsRouter.models),
    t("configs.rows", configsRouter.rows, { cap: true }),
    t("configs.get", configsRouter.get, { slim: slimGet }),
    t("configs.create", configsRouter.create),
    sourcedCalculate(ctx),
    t("configs.queryPage", configsRouter.queryPage, { cap: true }),
    t("configs.similar", configsRouter.similar),
    t("configs.select", configsRouter.select),
    t("requests.rows", requestsRouter.rows, { cap: true }),
    t("timeline.list", timelineRouter.list),
    t("home.overview", homeRouter.overview),
    readSap(ctx),
    t("b1.find", b1Router.find),
    t("b1.schema", b1Router.schema),
    t("b1.read", b1Router.read),
    t("reports.sap", reportsRouter.sap),
    t("reports.configs", reportsRouter.configs),
    confirmedB1("b1_write", b1Router.write as AnyProcedure, ctx),
    confirmedB1("b1_copy", b1Router.copy as AnyProcedure, ctx),
    postQuotation(ctx),
  ];
}

/** The names mcpTools registers: the MCP surface, which the tests hold to exactly. */
export const MCP_TOOL_NAMES = [
  "configs_models", "configs_rows", "configs_get", "configs_create", "configs_calculate", "configs_queryPage",
  "configs_similar", "configs_select", "requests_rows", "timeline_list", "home_overview", "entities_rows",
  "b1_find", "b1_schema", "b1_read", "reports_sap", "reports_configs", "b1_write", "b1_copy", "post_quotation",
] as const;

const CONFIRM_NOTE = "It posts nothing by itself: Confire asks the user to confirm in this client, showing exactly what will be written, and posts only when they accept. Tell the user in one sentence what you are about to propose before you call it, and never say it was posted unless the answer has `written`.";
const DESTRUCTIVE = { annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false, openWorldHint: false } };

/** One value as the confirmation shows it. */
const shown = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
};

/** The confirmation of a proposal, built here from what will be posted, never from the AI's words. */
export function proposalMessage(p: Proposal): string {
  const rows = Object.entries(p.changes ?? {}).map(([k, c]) => p.op === "update" ? `• ${k}: ${shown(c.before)} → ${shown(c.after)}` : `• ${k}: ${shown(c.after)}`);
  return [`${p.title ?? `${p.op} ${p.entity}`} — post to SAP?`, ...rows].join("\n");
}

type QuoteDraft = Awaited<ReturnType<typeof quoteDraft>>;
/** The quotation as it will be posted: the customer, the currency and every line, with the AI's header
 *  over the draft's — QUOTE_HEADER lets it set CardCode and DocCurrency, so the user sees both. */
export function quotationMessage(d: QuoteDraft, header: Record<string, unknown> = {}): string {
  const h: Record<string, unknown> = { ...d.data, ...header };
  const lines = (h.DocumentLines as Record<string, unknown>[] | undefined) ?? [];
  const head = Object.entries(h).filter(([k]) => k !== "DocumentLines").map(([k, v]) => {
    const changed = k in header && header[k] !== d.data[k];
    return `• ${k}: ${shown(v)}${changed ? ` (the configuration says ${shown(d.data[k])})` : ""}`;
  });
  const body = lines.map((l) => `  – ${shown(l.ItemCode ?? l.ItemDescription)} × ${shown(l.Quantity)} @ ${shown(l.UnitPrice ?? l.Price)}`);
  return [
    d.replaces ? `Update SAP quotation ${d.replaces.docEntry} for “${d.name}”?` : `Post a SAP quotation for “${d.name}”?`,
    ...head, `• Lines (${lines.length}):`, ...body, `• Total: ${shown(d.totals.value)}`,
  ].join("\n");
}

/** @tanstack/ai-mcp's error for a declined or cancelled input request (its `inputDeclinedMessage`,
 *  which the package does not export). */
const inputDeclinedMessage = "The user did not accept the input request.";

/** Ask the user to confirm, through the MCP client (elicitation). Resolves when they accept; answers why
 *  not otherwise. Spec 2026 ends the call here and runs the tool again with the answer, so everything
 *  before this runs twice — preparing a proposal reads SAP again, and its ETag decides. */
async function confirmed(toolCall: unknown, message: string): Promise<{ posted: false; note: string } | null> {
  const ask = (toolCall as { context?: { requestInput?: (r: { message: string }) => Promise<unknown> } })?.context?.requestInput;
  if (!ask) return { posted: false, note: "Not posted: this connection cannot ask the user to confirm." };
  try {
    await ask({ message });
    return null;
  } catch (e) {
    if (e instanceof ToolInputRequiredError) throw e;
    if (e instanceof Error && e.message === inputDeclinedMessage) return { posted: false, note: "Not posted: the user declined." };
    // ponytail: elicitation only — an approval page in Confire for MCP clients that cannot elicit.
    return { posted: false, note: "Not posted: this MCP client cannot ask the user to confirm a write, so nothing reaches SAP from it. The user can make the change in Confire." };
  }
}

/** b1_write/b1_copy over MCP: the same procedure (auto mode never applies to an MCP call, auto.ts), so it
 *  answers a proposal; the user confirms it; then b1.post posts exactly that proposal, re-checked with
 *  its ETag (a record changed since is CONFLICT). */
function confirmedB1(name: "b1_write" | "b1_copy", p: AnyProcedure, ctx: (call: unknown) => CallCtx): AnyServerTool {
  const meta = getOpenAPIMeta(p);
  return toolDefinition({
    name,
    description: `${(meta?.description ?? "").split("Unless auto mode is on")[0]!.trim()} ${CONFIRM_NOTE}`,
    inputSchema: p["~orpc"].inputSchemas!.at(-1) as z.ZodType,
    metadata: DESTRUCTIVE,
  }).server(async (args: unknown, toolCall: unknown) => {
    const context = contextOf(ctx(toolCall));
    const out = await run(() => call(p, args, { context })) as { proposal?: Proposal };
    if (!out.proposal) return out; // written already: cannot happen over MCP (autoWrite), kept honest
    const no = await confirmed(toolCall, proposalMessage(out.proposal));
    if (no) return no;
    return run(() => call(b1Router.post as AnyProcedure, { proposal: out.proposal }, { context }));
  }) as AnyServerTool;
}

/** The quotation over MCP: the draft as the quote page would post it, confirmed by the user, then
 *  createQuote with the draft's commandId (a retry is idempotent; picks moved since = CONFLICT). */
function postQuotation(ctx: (call: unknown) => CallCtx): AnyServerTool {
  return toolDefinition({
    name: "post_quotation",
    description: `Post this configuration's quotation (its picks, priced by Confire) to SAP as a Sales Quotation, or update the open one of a reopened request. \`header\` may set ${[...QUOTE_HEADER].join(", ")}. ${CONFIRM_NOTE}`,
    inputSchema: z.object({
      projectId: z.uuid().describe("The configuration's id"),
      header: z.record(z.string(), z.unknown()).optional().describe("Header fields to set, SAP's names; only the ones listed"),
    }),
    metadata: DESTRUCTIVE,
  }).server(async (args: unknown, toolCall: unknown) => {
    const { projectId, header } = args as { projectId: string; header?: Record<string, unknown> };
    const context = contextOf(ctx(toolCall));
    const draft = await run(() => call(configsRouter.quoteDraft as AnyProcedure, { projectId }, { context })) as QuoteDraft;
    if (draft.quoted) return { posted: false, note: `Already quoted: SAP quotation ${draft.quoted.docEntry}.` };
    const no = await confirmed(toolCall, quotationMessage(draft, header));
    if (no) return no;
    return run(() => call(configsRouter.createQuote as AnyProcedure, { projectId, commandId: draft.commandId, header }, { context }));
  }) as AnyServerTool;
}
