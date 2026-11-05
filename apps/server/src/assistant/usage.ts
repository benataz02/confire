import { ORPCError } from "@orpc/server";
import type { ChatMiddleware, TokenUsage } from "@tanstack/ai";
import { and, eq, gte, sql, type AnyColumn } from "drizzle-orm";
import { db, aiUsage, assistantSettings, user, type AiUsageKind } from "@confire/db";
import { ASSISTANT_MODEL, available, INTAKE_MODEL } from "./model.ts";
import { t as text } from "../i18n/index.ts";

// The meter, the monthly limit, the switch and the rate limit (assistant spec §4.7, §4.8). One row per
// model call; the limit is what it protects, the count of assisted configurations what gets reported.

/** $ per million tokens; `cacheWrite` is the 5-minute write, `cacheWrite1h` the 1-hour one. Checked
 *  2026-11-02 against the Claude API skill's pricing (Sonnet 5.5 cache reads are $0.20, not 0.1x). */
type Price = { input: number; cacheWrite: number; cacheWrite1h: number; cacheRead: number; output: number; over100k?: Omit<Price, "over100k"> };
export const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.20, output: 10 },
  "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.20, output: 20 },
  "claude-haiku-5-5": {
    input: 0.10, cacheWrite: 0.125, cacheWrite1h: 0.20, cacheRead: 0.01, output: 0.50,
    over100k: { input: 0.50, cacheWrite: 0.625, cacheWrite1h: 1, cacheRead: 0.05, output: 2.50 },
  },
};
for (const m of [ASSISTANT_MODEL, INTAKE_MODEL])
  if (!PRICES[m]) throw new Error(`Assistant model ${m} has no price in usage.ts`);

/** `cacheWrite` counts every write; `cacheWrite1h` is the 1-hour part of it. */
export type Tokens = { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; output: number };

/** TanStack's usage counts the cache parts inside `promptTokens`; the meter keeps them apart. */
export function tokensOf(u: TokenUsage): Tokens {
  const cacheRead = u.promptTokensDetails?.cachedTokens ?? 0;
  const cacheWrite = u.promptTokensDetails?.cacheWriteTokens ?? 0;
  const cacheWrite1h = u.promptTokensDetails?.cacheWrite1hTokens ?? 0;
  return { input: u.promptTokens - cacheRead - cacheWrite, cacheRead, cacheWrite, cacheWrite1h, output: u.completionTokens };
}

/** USD. A model without a row (a test's fake) is priced as the configured one. */
export function costOf(model: string, t: Tokens): number {
  const p = PRICES[model] ?? PRICES[ASSISTANT_MODEL]!;
  const r = p.over100k && t.input + t.cacheRead + t.cacheWrite > 100_000 ? p.over100k : p;
  const long = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  return (t.input * r.input + (t.cacheWrite - long) * r.cacheWrite + long * r.cacheWrite1h + t.cacheRead * r.cacheRead + t.output * r.output) / 1e6;
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
export const MONTHLY_LIMIT_USD = Number(process.env.ASSISTANT_MONTHLY_LIMIT_USD || 25); // "" from compose = unset

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

const sum = (col: AnyColumn) => sql<number>`coalesce(sum(${col}), 0)`.mapWith(Number);
const SUMS = {
  cost: sum(aiUsage.cost),
  calls: sql<number>`count(*)`.mapWith(Number),
  chats: sql<number>`count(distinct ${aiUsage.threadId})`.mapWith(Number),
  assisted: sql<number>`count(distinct ${aiUsage.projectId})`.mapWith(Number),
  input: sum(aiUsage.inputTokens), output: sum(aiUsage.outputTokens),
  cacheRead: sum(aiUsage.cacheReadTokens), cacheWrite: sum(aiUsage.cacheWriteTokens),
};

/** Cost and calls per day of this month, or per month of the last six, gaps included (generate_series).
 *  ponytail: days and months in the database's time zone (UTC); a workspace zone if anyone asks. */
async function series(tenantId: string, step: "day" | "month") {
  const start = step === "day" ? THIS_MONTH : sql`date_trunc('month', now()) - interval '5 months'`;
  const { rows } = await db.execute<{ at: string; cost: number; calls: number }>(sql`
    select to_char(s, ${step === "day" ? "YYYY-MM-DD" : "YYYY-MM"}) as at,
      coalesce(sum(u.cost), 0)::float8 as cost, count(u.id)::int as calls
    from generate_series(${start}, now(), ${`1 ${step}`}::interval) s
    left join ai_usage u on u.tenant_id = ${tenantId} and u.at >= s and u.at < s + ${`1 ${step}`}::interval
    group by s order by s`);
  return rows;
}

/** The usage dashboard: this month's totals and who and what they went to, its days, the last six months. */
export async function usageReport(tenantId: string) {
  const month = and(eq(aiUsage.tenantId, tenantId), gte(aiUsage.at, THIS_MONTH));
  const [[totals], kinds, users, days, months] = await Promise.all([
    db.select(SUMS).from(aiUsage).where(month),
    db.select({ kind: aiUsage.kind, ...SUMS }).from(aiUsage).where(month).groupBy(aiUsage.kind),
    db.select({ userId: aiUsage.userId, name: user.name, ...SUMS }).from(aiUsage).leftJoin(user, eq(user.id, aiUsage.userId))
      .where(month).groupBy(aiUsage.userId, user.name).orderBy(sql`sum(${aiUsage.cost}) desc`),
    series(tenantId, "day"),
    series(tenantId, "month"),
  ]);
  return { limit: MONTHLY_LIMIT_USD, model: ASSISTANT_MODEL, totals: totals!, kinds, users, days, months };
}

export const assistantOn = async (tenantId: string): Promise<boolean> => {
  const [s] = await db.select({ on: assistantSettings.assistant }).from(assistantSettings)
    .where(eq(assistantSettings.tenantId, tenantId)).limit(1);
  return !!s?.on;
};

/** Why the assistant cannot run here, or null: the workspace's switch (an admin's to turn on), or no
 *  API key on this server (the operator's to set) — two different fixes, so two different answers. */
export async function offReason(tenantId: string): Promise<"switch" | "no_key" | null> {
  if (!(await assistantOn(tenantId))) return "switch";
  return available() ? null : "no_key";
}

export const overLimit = async (tenantId: string): Promise<boolean> => (await monthUsage(tenantId)).cost >= MONTHLY_LIMIT_USD;

/** Before any model call: the workspace's switch, a provider to call, and money left this month. */
export async function assertAssistant(tenantId: string): Promise<void> {
  const off = await offReason(tenantId);
  if (off === "switch") throw new ORPCError("ASSISTANT_OFF", { message: text("ASSISTANT_OFF") });
  if (off === "no_key") throw new ORPCError("ASSISTANT_UNAVAILABLE", { message: text("ASSISTANT_UNAVAILABLE") });
  if (await overLimit(tenantId)) throw new ORPCError("ASSISTANT_LIMIT", { message: text("ASSISTANT_LIMIT") });
}

/** The limit inside a run: a chat's loop takes up to 12 model calls, and other runs spend meanwhile,
 *  so the month's spend is read again before each further call. Over it, the loop stops after the
 *  tools it just ran (their results are kept) — the next turn is then refused before any call. */
export function budget(tenantId: string): ChatMiddleware {
  return { name: "budget", onShouldContinue: async () => !(await overLimit(tenantId)) };
}

// ponytail: per process; a shared store when there is more than one staff process.
const windows = new Map<string, { start: number; n: number }>();
const PER_MINUTE = 20;

/** A fixed window of 20 calls a minute per user, across every assistant entry point. */
export function rateLimit(userId: string): void {
  const now = Date.now();
  const w = windows.get(userId);
  if (!w || now - w.start >= 60_000) { windows.set(userId, { start: now, n: 1 }); return; }
  if (++w.n > PER_MINUTE) throw new ORPCError("TOO_MANY_REQUESTS", { message: text("ASSISTANT_RATE_LIMIT") });
}

/** The plain route's answer to a coded refusal (oRPC answers its own). */
export const REFUSAL_STATUS: Record<string, number> = {
  ASSISTANT_OFF: 403, ASSISTANT_UNAVAILABLE: 503, ASSISTANT_LIMIT: 429, THREAD_BUSY: 409, TOO_MANY_REQUESTS: 429,
};
