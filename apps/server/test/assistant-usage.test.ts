import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { chat, toolDefinition, type ModelMessage } from "@tanstack/ai";
import { fakeText } from "@tanstack/ai/testing";
import { z } from "zod";
import { db, aiUsage, assistantSettings } from "@confire/db";
import { useTestAdapter } from "../src/assistant/model.ts";
import { SKILLS } from "../src/assistant/skills.ts";
import {
  assertAssistant, costOf, meter, MONTHLY_LIMIT_USD, rateLimit, tokensOf, usageReport,
} from "../src/assistant/usage.ts";
import { makeTenant } from "./harness.ts";

// The assistant's provider seam and its meter (spec §4.7, §4.8): prices, the switch, the monthly
// limit and the per-user rate limit. No test calls a model: the fake adapter answers.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
afterEach(() => useTestAdapter(null));

test("costOf: Sonnet 5.5 per MTok, cache reads at 0.20, 1-hour writes at 4", () => {
  expect(costOf("claude-sonnet-5-5", { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 })).toBeCloseTo(2 + 0.20 + 2.5 + 10);
  expect(costOf("claude-sonnet-5-5", { input: 0, cacheRead: 0, cacheWrite: 2e6, cacheWrite1h: 1e6, output: 0 })).toBeCloseTo(2.5 + 4);
  expect(costOf("claude-opus-5-5", { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 })).toBeCloseTo(4 + 0.20 + 20);
});
test("costOf: Haiku 5.5 switches to long-context prices past 100k prompt tokens", () => {
  expect(costOf("claude-haiku-5-5", { input: 100_001, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(100_001 * 0.5 / 1e6);
  expect(costOf("claude-haiku-5-5", { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(100_000 * 0.1 / 1e6);
});
test("tokensOf: promptTokens includes the cache parts", () => {
  expect(tokensOf({
    promptTokens: 100, completionTokens: 7, totalTokens: 107,
    promptTokensDetails: { cachedTokens: 60, cacheWriteTokens: 30 },
  })).toEqual({ input: 10, cacheRead: 60, cacheWrite: 30, cacheWrite1h: 0, output: 7 });
});
test("rateLimit: the 21st call in a minute is refused", () => {
  const u = crypto.randomUUID();
  for (let i = 0; i < 20; i++) rateLimit(u);
  expect(() => rateLimit(u)).toThrow(expect.objectContaining({ code: "TOO_MANY_REQUESTS" }));
  rateLimit(crypto.randomUUID()); // another user is not held back
});

describe.skipIf(!process.env.DATABASE_URL)("budget", () => {
  test("off until an admin turns it on", async () => {
    const { tenantId } = await makeTenant();
    useTestAdapter(fakeText());
    expect(await codeOf(assertAssistant(tenantId))).toBe("ASSISTANT_OFF");
    await db.insert(assistantSettings).values({ tenantId, assistant: true });
    expect(await codeOf(assertAssistant(tenantId))).toBe("OK");
    useTestAdapter(null); // the switch is on, but this server has no API key: a different refusal
    expect(await codeOf(assertAssistant(tenantId))).toBe("ASSISTANT_UNAVAILABLE");
  });

  test("refuses at the limit; last month's spend does not count", async () => {
    const { tenantId } = await makeTenant();
    useTestAdapter(fakeText());
    await db.insert(assistantSettings).values({ tenantId, assistant: true });
    const row = { tenantId, userId: "u", model: "claude-sonnet-5-5", kind: "chat" as const, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await db.insert(aiUsage).values({ ...row, cost: String(MONTHLY_LIMIT_USD), at: lastMonth });
    expect(await codeOf(assertAssistant(tenantId))).toBe("OK");
    await db.insert(aiUsage).values({ ...row, cost: String(MONTHLY_LIMIT_USD) });
    expect(await codeOf(assertAssistant(tenantId))).toBe("ASSISTANT_LIMIT");
  });

  test("meter writes one row per model call", async () => {
    const { tenantId } = await makeTenant();
    const m = { tenantId, userId: "u1", threadId: null, projectId: null, kind: "chat" as const };
    const fake = fakeText();
    fake.setResponses([{ text: "a" }]);
    for await (const _ of chat({ adapter: fake, threadId: "t1", messages: [{ role: "user", content: "hi" }], middleware: [meter(m)] }));
    const rows = await db.select().from(aiUsage).where(and(eq(aiUsage.tenantId, tenantId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u1", kind: "chat", threadId: null });
    expect(Number(rows[0]!.cost)).toBeGreaterThan(0);
  });

  test("meter tags each call with the chat's skill and the tools whose results it read", async () => {
    const { tenantId } = await makeTenant();
    const m = { tenantId, userId: "u1", threadId: null, projectId: null, kind: "chat" as const };
    const lookup = toolDefinition({ name: "lookup", description: "x", inputSchema: z.object({}) }).server(async () => "ok");
    const fake = fakeText();
    fake.setResponses([
      { toolCalls: [{ name: "load_skill", input: { name: "configure" } }] },
      { toolCalls: [{ name: "lookup", input: {} }, { name: "lookup", input: {} }] },
      { text: "done" },
    ]);
    for await (const _ of chat({ adapter: fake, threadId: "t1", messages: [{ role: "user", content: "hi" }], tools: [lookup], middleware: [SKILLS, meter(m)] }));
    const rows = () => db.select().from(aiUsage).where(eq(aiUsage.tenantId, tenantId)).orderBy(aiUsage.at);
    expect((await rows()).map((r) => [r.skill, r.tools])).toEqual([[null, []], ["configure", ["load_skill"]], ["configure", ["lookup"]]]);

    // A later turn: the skill loaded earlier is still in the history, so its first call is already that skill's.
    const history: ModelMessage[] = [
      { role: "user", content: "a report" },
      { role: "assistant", content: null, toolCalls: [{ id: "s1", type: "function", function: { name: "load_skill", arguments: '{"name":"report"}' } }] },
      { role: "tool", toolCallId: "s1", content: "{}" },
      { role: "user", content: "again" },
    ];
    fake.setResponses([{ text: "ok" }]);
    for await (const _ of chat({ adapter: fake, threadId: "t2", messages: history, middleware: [meter({ ...m })] }));
    expect((await rows()).at(-1)).toMatchObject({ skill: "report", tools: [] });
  });

  test("usageReport: this month's totals, steps, skills, tools and users; every day and six months, gaps included", async () => {
    const { tenantId } = await makeTenant();
    const row = { tenantId, model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 };
    const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await db.insert(aiUsage).values([
      { ...row, userId: "a", kind: "chat", cost: "1.5" },
      { ...row, userId: "a", kind: "intake", cost: "0.5", skill: "configure", tools: ["read_request"] },
      { ...row, userId: "b", kind: "chat", cost: "3", skill: "report", tools: ["b1_read", "b1_schema"] },
      { ...row, userId: "a", kind: "chat", cost: "100", at: lastMonth },
    ]);
    const r = await usageReport(tenantId);
    expect(r.totals).toMatchObject({ cost: 5, calls: 3, input: 30, cacheRead: 300 });
    expect(r.steps.map((s) => [s.step, s.cost]).sort()).toEqual([["intake", 0.5], ["reply", 1.5], ["tools", 3]]);
    expect(r.skills.map((s) => [s.skill, s.cost]).sort()).toEqual([[null, 1.5], ["configure", 0.5], ["report", 3]]);
    // b's call read two tools: each gets half of it.
    expect(r.tools.map((x) => [x.tool, x.cost, x.calls]).sort()).toEqual([["b1_read", 1.5, 1], ["b1_schema", 1.5, 1], ["read_request", 0.5, 1]]);
    expect(r.users.map((u) => [u.userId, u.cost, u.calls])).toEqual([["b", 3, 1], ["a", 2, 2]]);
    expect(r.days).toHaveLength(new Date().getUTCDate());
    expect(r.days.at(-1)).toMatchObject({ cost: 5, calls: 3 });
    expect(r.months.map((m) => m.cost)).toEqual([0, 0, 0, 0, 100, 5]);
  });
});

test("compose's empty variables mean the defaults, not an empty model and a zero budget", () => {
  // docker-compose passes an unset `${X:-}` as "" — read at module load, so in a fresh process.
  const r = Bun.spawnSync(["bun", "-e", `const u = await import("${import.meta.dir}/../src/assistant/usage.ts"); const m = await import("${import.meta.dir}/../src/assistant/model.ts"); console.log(JSON.stringify([m.ASSISTANT_MODEL, u.MONTHLY_LIMIT_USD]))`], {
    env: { ...process.env, ASSISTANT_MODEL: "", ASSISTANT_MONTHLY_LIMIT_USD: "" },
  });
  expect(r.stderr.toString()).toBe("");
  expect(JSON.parse(r.stdout.toString())).toEqual(["claude-sonnet-5-5", 25]);
});
