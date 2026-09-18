import { describe, expect, test } from "bun:test";
import type { B1Snapshot } from "@confire/db";
import { buildOverview, type ProjectRow } from "../src/dashboard.ts";

const NOW = new Date("2026-08-19T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

const emptySnapshot: B1Snapshot = {
  months: {}, openQuotes: [], openQuotesTruncated: false,
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

describe("buildOverview series and pipeline split", () => {
  test("orderValue.series is always twelve months ending at now", () => {
    const out = buildOverview({
      ...base,
      snapshot: {
        payload: {
          ...emptySnapshot,
          months: {
            "2026-07": { "": { orders: { count: 1, value: 100, grossProfit: null }, quotes: { count: 0, closed: 0, value: 0 } } },
            "2026-08": { "": { orders: { count: 1, value: 250, grossProfit: null }, quotes: { count: 0, closed: 0, value: 0 } } },
          },
        },
        computedAt: NOW, lastError: null,
      },
    });
    expect(out.orderValue.series).toHaveLength(12);
    expect(out.orderValue.series[0]!.month).toBe("2025-09");
    expect(out.orderValue.series.at(-1)).toEqual({ month: "2026-08", value: 250 });
    expect(out.orderValue.series.find((s) => s.month === "2026-07")).toEqual({ month: "2026-07", value: 100 });
    expect(out.orderValue.total).toBe(250);
  });

  test("pipeline splits Confire vs other by b1DocEntry", () => {
    const out = buildOverview({
      ...base,
      snapshot: {
        payload: {
          ...emptySnapshot,
          openQuotes: [
            { docEntry: 10, docNum: 1, cardCode: "C1", cardName: "Acme", docDate: "2026-08-18", docTotal: 400, salesPersonCode: 0 },
            { docEntry: 99, docNum: 2, cardCode: "C2", cardName: "Beta", docDate: "2026-08-18", docTotal: 100, salesPersonCode: 0 },
          ],
        },
        computedAt: NOW, lastError: null,
      },
      projects: [project({ id: "d", status: "quoted", quotedAt: NOW, b1DocEntry: 10 })],
    });
    const young = out.pipeline.find((p) => p.bucket === "0-7d")!;
    expect(young.value).toBe(500);
    expect(young.confire).toBe(400);
    expect(young.other).toBe(100);
    expect(young.docEntries).toEqual([10]);
  });
});
