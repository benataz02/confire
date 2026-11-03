import { expect, test } from "bun:test";
import { ReportDefZ, type ReportDef, type Widget } from "@confire/db";
import { planReads, type Read } from "../src/reports/plan.ts";
import { bucketOf, evaluate, toParts, type PartRow } from "../src/reports/aggregate.ts";
import type { ChartResult, KpiResult } from "../src/reports/types.ts";
import { PIPELINE } from "./fixtures/pipeline-report.ts";

// The figures (reports spec §3.3): what to ask SAP for, and how its partial totals become a widget's
// numbers. Pure — the runner's reads are faked as the rows SAP would answer.

const today = new Date("2026-11-03T00:00:00Z");

test("buckets read the date's text, never a timezone", () => {
  expect(bucketOf("2026-11-01T00:00:00Z", "month", today)!.label).toBe("2026-11");
  expect(bucketOf("2026-11-01", "quarter", today)!.label).toBe("2026-Q4");
  expect(bucketOf("2025-12-29", "week", today)!.label).toBe("2026-W01");
  expect(bucketOf("2026-09-01", { ageDays: [30, 60, 90] }, today)!.label).toBe("61–90");
  expect(bucketOf("2026-11-01", { ageDays: [30, 60, 90] }, today)!.label).toBe("0–30");
  expect(bucketOf("2026-01-01", { ageDays: [30, 60, 90] }, today)!.label).toBe(">90");
  expect(bucketOf(25000, { ranges: [1000, 10000] }, today)!.label).toBe("≥10000");
  expect(bucketOf(500, { ranges: [1000, 10000] }, today)!.label).toBe("<1000");
  expect(bucketOf(null, "month", today)).toBeNull();
  expect(bucketOf("2026-10", "month", today)).toBeNull();
  // Buckets sort by time, not by text.
  expect(bucketOf("2026-01-05", "week", today)!.order).toBeLessThan(bucketOf("2026-03-02", "week", today)!.order);
});

test("plan: one read per source, grouped by the date field and the lookup's key, measures merged", () => {
  const p = planReads(PIPELINE, today);
  const byMonth = p.reads.filter((r) => r.agg.groupBy.includes("DocDate") && r.agg.groupBy.length === 1);
  expect(byMonth.map((r) => r.source).sort()).toEqual([0, 1]);
  expect(p.reads.some((r) => r.agg.groupBy.includes("SalesPersonCode"))).toBe(true);
  expect(p.reads.every((r) => r.filter.every((c) => typeof c.value !== "string" || !c.value.startsWith("@")))).toBe(true);
  // The same sum is asked once per read, whichever widgets share it.
  for (const r of p.reads) expect(new Set(r.agg.measures.map((m) => m.as)).size).toBe(r.agg.measures.length);
  // "Open quotations" filters `_source eq Quotation`: it reads the quotations only.
  expect(p.uses[1]![0]!.reads).toHaveLength(1);
  expect(p.reads.find((r) => r.key === p.uses[1]![0]!.reads[0])!.source).toBe(0);
});

/** What SAP would answer a read: two days, one in October and one in November, each with a
 *  DocTotal of 100 and a VatSum of 21. */
const fakeParts = (r: Read): PartRow[] => ["2026-10-15", "2026-11-02"].map((day) => {
  const row: PartRow = {};
  for (const g of r.agg.groupBy) row[g] = g === "DocDate" ? day : g === "SalesPersonCode" ? 1 : "ACME";
  for (const m of r.agg.measures) row[m.as] = m.agg === "count" ? 1 : m.field === "VatSum" ? 21 : 100;
  return row;
});

test("evaluate: months bucketed and stacked by source, net = DocTotal minus VatSum, empty is null not NaN", () => {
  const p = planReads(PIPELINE, today);
  const out = evaluate(PIPELINE, p, new Map(p.reads.map((r) => [r.key, fakeParts(r)])), new Map(), today);
  const kpi = out[0] as KpiResult;
  expect(kpi.value).toBe(4 * (100 - 21));
  expect((out[1] as KpiResult).value).toBe(2);
  const chart = out[2] as ChartResult;
  expect(chart.rows.map((r) => r.month)).toEqual(["2026-10", "2026-11"]);
  expect(chart.measures.map((m) => m.key).sort()).toEqual(["s:Order", "s:Quotation"]);
  expect(chart.rows[0]).toEqual({ month: "2026-10", "s:Quotation": 79, "s:Order": 79 });
  const empty = evaluate(PIPELINE, p, new Map(p.reads.map((r) => [r.key, []])), new Map(), today);
  expect((empty[0] as KpiResult).value).toBeNull();
  expect((empty[1] as KpiResult).value).toBe(0);
  expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
});

const ONE = (widgets: unknown[]): ReportDef => ReportDefZ.parse({
  title: "t", assumptions: [], widgets,
  datasets: { d: { from: [{ source: "b1", entity: "Orders" }], select: ["CardCode", "DocTotal", "DocDate"] } },
});
/** Each read answered from raw rows (the fallback's path), its `eq` filters applied. */
const run1 = (def: ReportDef, rows: Record<string, unknown>[]) => {
  const p = planReads(def, today);
  const keep = (r: Read) => rows.filter((x) => r.filter.every((c) => c.op !== "eq" || x[c.field] === c.value));
  return evaluate(def, p, new Map(p.reads.map((r) => [r.key, toParts(keep(r), r.agg)])), new Map(), today);
};

test("top-N sums the rest as Other; a ratio with a zero denominator is null", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ CardCode: `C${i + 1}`, DocTotal: (i + 1) * 10, DocDate: "2026-11-01" }));
  const [bar] = run1(ONE([{ kind: "chart", title: "top", chart: "bar", dimension: "CardCode", top: 10, measures: [{ dataset: "d", agg: "sum", field: "DocTotal", label: "v" }] }]), rows) as ChartResult[];
  expect(bar!.rows).toHaveLength(11);
  expect(bar!.rows[0]).toEqual({ CardCode: "C12", m0: 120 });
  expect(bar!.rows.at(-1)).toEqual({ CardCode: "Other", m0: 10 + 20 });
  const [kpi] = run1(ONE([{ kind: "kpi", title: "r", value: { dataset: "d", agg: "sum", field: "DocTotal", label: "v" }, per: { dataset: "d", agg: "sum", field: "DocTotal", label: "p", filter: [{ field: "CardCode", op: "eq", value: "none" }] } }]), rows) as KpiResult[];
  expect(kpi!.value).toBeNull();
});

test("countDistinct counts the grouped field, never sums it", () => {
  const rows = [{ CardCode: "C1", DocTotal: 1, DocDate: "2026-11-01" }, { CardCode: "C1", DocTotal: 1, DocDate: "2026-11-02" }, { CardCode: "C2", DocTotal: 1, DocDate: "2026-11-02" }];
  const [kpi] = run1(ONE([{ kind: "kpi", title: "c", value: { dataset: "d", agg: "countDistinct", field: "CardCode", label: "n" } }]), rows) as KpiResult[];
  expect(kpi!.value).toBe(2);
});

test("avg is the pushed sum over the pushed count; compare gives the deviation", () => {
  const rows = [{ CardCode: "C1", DocTotal: 10, DocDate: "2026-11-01" }, { CardCode: "C2", DocTotal: 30, DocDate: "2026-10-01" }];
  const w: Widget[] = [{
    kind: "kpi", title: "avg", value: { dataset: "d", agg: "avg", field: "DocTotal", label: "a", filter: [], format: "money" },
    compare: { dataset: "d", agg: "sum", field: "DocTotal", label: "c", filter: [{ field: "CardCode", op: "eq", value: "C2" }], format: "money" },
  }];
  const [kpi] = run1(ONE(w), rows) as KpiResult[];
  expect(kpi!.value).toBe(20);
  expect(kpi!.compare).toBe(30);
  expect(kpi!.deviation).toBeCloseTo(-1 / 3);
});
