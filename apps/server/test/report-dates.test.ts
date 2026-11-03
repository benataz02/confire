import { expect, test } from "bun:test";
import { ReportDefZ } from "@confire/db";
import { resolveDate, resolveFilter } from "../src/reports/dates.ts";
import { PIPELINE_INPUT } from "./fixtures/pipeline-report.ts";

// Relative dates (reports spec §3.1): a saved report's "last 12 months" stays the last 12 months.

const today = new Date("2026-11-03T10:00:00Z"); // a Tuesday

test.each([
  ["@today", "2026-11-03"], ["@today-12M", "2025-11-03"], ["@today+30D", "2026-12-03"],
  ["@startOfMonth", "2026-11-01"], ["@startOfQuarter", "2026-10-01"], ["@startOfYear-1Y", "2025-01-01"],
  ["@startOfWeek", "2026-11-02"], ["@today-1W", "2026-10-27"],
])("%s → %s", (tok, want) => expect(resolveDate(tok, today)).toBe(want));

test("a month back from the 31st lands on the month's last day, never the next month", () => {
  expect(resolveDate("@today-1M", new Date("2026-03-31T00:00:00Z"))).toBe("2026-02-28");
});

test("a filter's tokens resolve, inside `in` too; other values pass", () => {
  expect(resolveFilter([
    { field: "DocDate", op: "ge", value: "@today-12M" },
    { field: "CardCode", op: "eq", value: "@acme" },
    { field: "DocDueDate", op: "in", value: ["@today", 5] },
  ], today)).toEqual([
    { field: "DocDate", op: "ge", value: "2025-11-03" },
    { field: "CardCode", op: "eq", value: "@acme" },
    { field: "DocDueDate", op: "in", value: ["2026-11-03", 5] },
  ]);
});

test("the pipeline fixture parses, defaults filled", () => {
  const def = ReportDefZ.parse(PIPELINE_INPUT);
  expect(def.datasets.docs!.lines).toBe(false);
  expect(def.widgets).toHaveLength(7);
});

test("a definition with no widget, or an unknown chart, is refused", () => {
  expect(ReportDefZ.safeParse({ ...PIPELINE_INPUT, widgets: [] }).success).toBe(false);
  expect(ReportDefZ.safeParse({ ...PIPELINE_INPUT, widgets: [{ kind: "chart", title: "x", chart: "map", dimension: "month", measures: [] }] }).success).toBe(false);
});
