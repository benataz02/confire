import { z } from "zod";
import * as Sentry from "@sentry/bun";
import { and, eq } from "drizzle-orm";
import { call, ORPCError, type AnyProcedure } from "@orpc/server";
import { getOpenAPIMeta } from "@orpc/openapi";
import { toolDefinition, type AnyServerTool } from "@tanstack/ai";
import { configProject, ListQueryZ } from "@confire/db";
import { SourcesZ } from "../config-patch.ts";
import { configView } from "../config-view.ts";
import { internalVisible } from "../project-lifecycle.ts";
import { configsRouter } from "../orpc/routers/configs.ts";
import { entitiesRouter } from "../orpc/routers/entities.ts";
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
// (lists capped at what the card shows). None posts to SAP.

export type ToolCtx = { headers: Headers; tenantId: string; userId: string; thread: Thread; meter: Meter };

/** Joule's list card maximum: the card shows these rows and the model reads no more than that. */
export const LIST_CAP = 20;

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

/** A procedure as a tool: `configs.get` is `configs_get` (the name MCP derives too). */
export function procedureTool(path: string, p: AnyProcedure, ctx: { headers: Headers }, o: {
  name?: string; input?: z.ZodType; describe?: string; slim?: (out: unknown) => unknown; cap?: boolean;
  prepare?: (input: Record<string, unknown>) => Record<string, unknown>;
} = {}): AnyServerTool {
  const meta = getOpenAPIMeta(p);
  const description = [
    o.describe ?? meta?.description ?? meta?.summary ?? path,
    o.cap ? `At most ${LIST_CAP} rows; \`total\` says how many match.` : "",
  ].filter(Boolean).join(" ");
  const inputSchema = o.input ?? (p["~orpc"].inputSchemas?.at(-1) as z.ZodType | undefined) ?? z.object({});
  return toolDefinition({ name: o.name ?? path.replaceAll(".", "_"), description, inputSchema }).server(async (args: unknown) => {
    let input = (args ?? {}) as Record<string, unknown>;
    if (o.cap) input = { ...input, top: Math.min(Number(input.top ?? LIST_CAP) || LIST_CAP, LIST_CAP) };
    if (o.prepare) input = o.prepare(input);
    let out = await run(() => call(p, input, { context: { headers: ctx.headers } }));
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
export function sourcedCalculate(ctx: ToolCtx): AnyServerTool {
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
export const readSap = (ctx: ToolCtx): AnyServerTool =>
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
      return v ? { ...r, model: modelBlock(v.live.model.definition, v.view.form), missing: v.view.missing.map((m) => m.message) } : r;
    })) as AnyServerTool,
    requests_rows: t("requests.rows", requestsRouter.rows, { cap: true }),
    home_overview: t("home.overview", homeRouter.overview),
    timeline_list: t("timeline.list", timelineRouter.list),
    entities_rows: readSap(ctx),
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
    propose_quotation: configsRouter.quoteDraft,
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
