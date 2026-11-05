import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { chat } from "@tanstack/ai";
import { fakeText } from "@tanstack/ai/testing";
import { db, aiUsage, assistantSettings } from "@confire/db";
import { useTestAdapter } from "../src/assistant/model.ts";
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

  test("usageReport: this month's totals, kinds and users; every day and six months, gaps included", async () => {
    const { tenantId } = await makeTenant();
    const row = { tenantId, model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 };
    const lastMonth = new Date(); lastMonth.setUTCDate(1); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    await db.insert(aiUsage).values([
      { ...row, userId: "a", kind: "chat", cost: "1.5", projectId: crypto.randomUUID() },
      { ...row, userId: "a", kind: "intake", cost: "0.5" },
      { ...row, userId: "b", kind: "chat", cost: "3" },
      { ...row, userId: "a", kind: "chat", cost: "100", at: lastMonth },
    ]);
    const r = await usageReport(tenantId);
    expect(r.totals).toMatchObject({ cost: 5, calls: 3, assisted: 1, input: 30, cacheRead: 300 });
    expect(r.kinds.sort((x, y) => x.kind.localeCompare(y.kind)).map((k) => [k.kind, k.cost])).toEqual([["chat", 4.5], ["intake", 0.5]]);
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
