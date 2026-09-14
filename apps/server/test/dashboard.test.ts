import { describe, expect, test } from "bun:test";
import type { B1Snapshot } from "@confire/db";
import { buildOverview, type ProjectRow } from "../src/dashboard.ts";

const NOW = new Date("2026-08-19T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

const emptySnapshot: B1Snapshot = {
  currency: "EUR", months: {}, openQuotes: [], openQuotesTruncated: false,
  grossProfitAvailable: false,
};

const project = (over: Partial<ProjectRow>): ProjectRow => ({
  id: "p1", name: "Pump", status: "draft", source: "internal", createdBy: "u1",
  createdAt: new Date(NOW.getTime() - 3 * day), customerName: "Acme",
  quotedAt: null, b1DocEntry: null, quotedValue: null, quotedCost: null, ...over,
});

const base = {
  window: "month" as const, now: NOW,
  snapshot: { payload: emptySnapshot, computedAt: NOW, lastError: null },
  projects: [] as ProjectRow[],
};

describe("buildOverview funnel", () => {
  test("priced drafts stay Draft — calculated is not a stage", () => {
    const out = buildOverview({
      ...base,
      projects: [
        project({ id: "a", status: "draft" }),
        project({ id: "b", status: "draft" }),
        project({ id: "c", status: "requested" }),
        project({ id: "d", status: "quoted", quotedAt: NOW, b1DocEntry: 10 }),
        project({ id: "e", status: "quoted", quotedAt: NOW, b1DocEntry: 11 }),
      ],
    });
    expect(out.funnel).toEqual([
      { stage: "Draft", count: 3 },
      { stage: "Quoted", count: 2 },
      { stage: "Ordered", count: 2 },
    ]);
  });
});
