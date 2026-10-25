import { ORPCError } from "@orpc/server";
import type { ChatMiddleware, TokenUsage } from "@tanstack/ai";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, aiUsage, assistantSettings, type AiUsageKind } from "@confire/db";
import { ASSISTANT_MODEL, available } from "./model.ts";

// The meter, the monthly limit, the switch and the rate limit (assistant spec §4.7, §4.8). One row per
// model call; the limit is what it protects, the count of assisted configurations what gets reported.

/** $ per million tokens. Verified 2026-10-24 on platform.claude.com/docs/en/about-claude/pricing. */
type Price = { input: number; cacheWrite: number; cacheRead: number; output: number; over100k?: Omit<Price, "over100k"> };
export const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.10, output: 10 },
  "claude-haiku-5-5": {
    input: 0.10, cacheWrite: 0.125, cacheRead: 0.01, output: 0.50,
    over100k: { input: 0.50, cacheWrite: 0.625, cacheRead: 0.05, output: 2.50 },
  },
};
if (!PRICES[ASSISTANT_MODEL]) throw new Error(`ASSISTANT_MODEL ${ASSISTANT_MODEL} has no price in usage.ts`);

export type Tokens = { input: number; cacheRead: number; cacheWrite: number; output: number };

/** TanStack's usage counts the cache parts inside `promptTokens`; the meter keeps them apart. */
export function tokensOf(u: TokenUsage): Tokens {
  const cacheRead = u.promptTokensDetails?.cachedTokens ?? 0;
  const cacheWrite = u.promptTokensDetails?.cacheWriteTokens ?? 0;
  return { input: u.promptTokens - cacheRead - cacheWrite, cacheRead, cacheWrite, output: u.completionTokens };
}

/** USD. A model without a row (a test's fake) is priced as the configured one.
 *  ponytail: 1h cache writes priced as 5m; split when promptCache "long" is used. */
export function costOf(model: string, t: Tokens): number {
  const p = PRICES[model] ?? PRICES[ASSISTANT_MODEL]!;
  const r = p.over100k && t.input + t.cacheRead + t.cacheWrite > 100_000 ? p.over100k : p;
  return (t.input * r.input + t.cacheWrite * r.cacheWrite + t.cacheRead * r.cacheRead + t.output * r.output) / 1e6;
}

/** Who a run is billed to. Mutable: a run that creates a configuration sets `projectId` midway. */
export type Meter = { tenantId: string; userId: string; threadId: string | null; projectId: string | null; kind: AiUsageKind };

/** One `ai_usage` row per model call: onUsage fires for each agent-loop call and for a structured
 *  output's own call. Awaited, so a run's rows are written when its stream ends. */
export function meter(m: Meter): ChatMiddleware {
  return {
    name: "meter",
    onUsage: async (ctx, usage) => {
      const t = tokensOf(usage);
      const model = PRICES[ctx.model] ? ctx.model : ASSISTANT_MODEL;
      await db.insert(aiUsage).values({
        tenantId: m.tenantId, userId: m.userId, threadId: m.threadId, projectId: m.projectId, kind: m.kind, model,
        inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite,
        cost: costOf(model, t).toFixed(6),
      });
    },
  };
}

// ponytail: one env default; per-workspace override when a customer needs a different limit.
export const MONTHLY_LIMIT_USD = Number(process.env.ASSISTANT_MONTHLY_LIMIT_USD ?? 25);

const THIS_MONTH = sql`date_trunc('month', now())`;

/** This month's spend and the configurations it went to. */
export async function monthUsage(tenantId: string): Promise<{ cost: number; assisted: number }> {
  const [r] = await db
    .select({
      cost: sql<string>`coalesce(sum(${aiUsage.cost}), 0)`,
      assisted: sql<number>`count(distinct ${aiUsage.projectId})::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.tenantId, tenantId), gte(aiUsage.at, THIS_MONTH)));
  return { cost: Number(r?.cost ?? 0), assisted: r?.assisted ?? 0 };
}

export const assistantOn = async (tenantId: string): Promise<boolean> => {
  const [s] = await db.select({ on: assistantSettings.assistant }).from(assistantSettings)
    .where(eq(assistantSettings.tenantId, tenantId)).limit(1);
  return !!s?.on;
};

/** Before any model call: the workspace's switch, a provider to call, and money left this month. */
export async function assertAssistant(tenantId: string): Promise<void> {
  if (!available() || !(await assistantOn(tenantId)))
    throw new ORPCError("ASSISTANT_OFF", { message: "The assistant is off for this workspace" });
  if ((await monthUsage(tenantId)).cost >= MONTHLY_LIMIT_USD)
    throw new ORPCError("ASSISTANT_LIMIT", { message: "This workspace has used its assistant budget for this month" });
}

// ponytail: per process; a shared store when there is more than one staff process.
const windows = new Map<string, { start: number; n: number }>();
const PER_MINUTE = 20;

/** A fixed window of 20 calls a minute per user, across every assistant entry point. */
export function rateLimit(userId: string): void {
  const now = Date.now();
  const w = windows.get(userId);
  if (!w || now - w.start >= 60_000) { windows.set(userId, { start: now, n: 1 }); return; }
  if (++w.n > PER_MINUTE) throw new ORPCError("TOO_MANY_REQUESTS", { message: "Too many assistant requests — wait a minute" });
}

/** The plain route's answer to a coded refusal (oRPC answers its own). */
export const REFUSAL_STATUS: Record<string, number> = {
  ASSISTANT_OFF: 403, ASSISTANT_LIMIT: 429, THREAD_BUSY: 409, TOO_MANY_REQUESTS: 429,
};
