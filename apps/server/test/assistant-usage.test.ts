import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { chat } from "@tanstack/ai";
import { fakeText } from "@tanstack/ai/testing";
import { db, aiUsage, assistantSettings } from "@confire/db";
import { useTestAdapter } from "../src/assistant/model.ts";
import {
  assertAssistant, costOf, meter, MONTHLY_LIMIT_USD, rateLimit, tokensOf,
} from "../src/assistant/usage.ts";
import { makeTenant } from "./harness.ts";

// The assistant's provider seam and its meter (spec §4.7, §4.8): prices, the switch, the monthly
// limit and the per-user rate limit. No test calls a model: the fake adapter answers.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
afterEach(() => useTestAdapter(null));

test("costOf: Sonnet 5.5 per MTok, cache reads at 0.10", () => {
  expect(costOf("claude-sonnet-5-5", { input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 })).toBeCloseTo(2 + 0.10 + 2.5 + 10);
});
test("costOf: Haiku 5.5 switches to long-context prices past 100k prompt tokens", () => {
  expect(costOf("claude-haiku-5-5", { input: 100_001, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(100_001 * 0.5 / 1e6);
  expect(costOf("claude-haiku-5-5", { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeCloseTo(100_000 * 0.1 / 1e6);
});
test("tokensOf: promptTokens includes the cache parts", () => {
  expect(tokensOf({
    promptTokens: 100, completionTokens: 7, totalTokens: 107,
    promptTokensDetails: { cachedTokens: 60, cacheWriteTokens: 30 },
  })).toEqual({ input: 10, cacheRead: 60, cacheWrite: 30, output: 7 });
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
    useTestAdapter(null); // and no API key in tests: unavailable
    expect(await codeOf(assertAssistant(tenantId))).toBe("ASSISTANT_OFF");
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
});
