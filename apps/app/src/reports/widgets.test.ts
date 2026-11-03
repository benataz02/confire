import { expect, test } from "bun:test";
import { chartComponent, chartProps, filterRows, formatValue, type ChartResult } from "./widgets.ts";

// A report's results as UI5 chart props (reports spec §6.2). Pure: which component, which accessors,
// the click filter and the numbers' formats.

const chart = (o: Partial<ChartResult>): ChartResult => ({
  kind: "chart", title: "t", size: "normal", chart: "column", dimension: "month", rows: [], measures: [], ...o,
});
const fmt = (v: number) => String(v);

test("composed: bars and a line, one dimension", () => {
  const p = chartProps(chart({ chart: "composed", rows: [{ month: "2026-11", m0: 5, m1: 2 }],
    measures: [{ key: "m0", label: "Value", format: "money" }, { key: "m1", label: "Count", format: "number", as: "line" }] }), fmt);
  expect(p.dimensions).toEqual([{ accessor: "month" }]);
  expect(p.measures.map((m) => [m.accessor, m.type])).toEqual([["m0", "bar"], ["m1", "line"]]);
  expect(p.dataset).toEqual([{ month: "2026-11", m0: 5, m1: 2 }]);
});

test("a series chart stacks every measure", () => {
  const p = chartProps(chart({ measures: [{ key: "s:Order", label: "Order", format: "money", stackId: "s" }, { key: "s:Quotation", label: "Quotation", format: "money", stackId: "s" }] }), fmt);
  expect(new Set(p.measures.map((m) => m.stackId))).toEqual(new Set(["s"]));
});

test("each kind has its UI5 chart", () => {
  expect(chartComponent("donut")).toBe("DonutChart");
  expect(chartComponent("columnTrend")).toBe("ColumnChartWithTrend");
  expect(chartComponent("bullet")).toBe("BulletChart");
});

test("a bullet's first measure is primary, the rest compare", () => {
  const p = chartProps(chart({ chart: "bullet", measures: [{ key: "m0", label: "Actual", format: "money" }, { key: "m1", label: "Last year", format: "money" }] }), fmt);
  expect(p.measures.map((m) => m.type)).toEqual(["primary", "comparison"]);
});

test("filterRows keeps the clicked category", () => {
  expect(filterRows([{ month: "2026-10" }, { month: "2026-11" }], "month", "2026-11")).toEqual([{ month: "2026-11" }]);
  expect(filterRows([{ n: 1 }, { n: 2 }], "n", "2")).toEqual([{ n: 2 }]);
});

test("formatValue: null is a dash, money compact with its currency, percent", () => {
  expect(formatValue(null, "money", "EUR", "en")).toBe("—");
  expect(formatValue(2840000, "money", "EUR", "en")).toBe("€2.8M");
  expect(formatValue(0.31, "percent", null, "en")).toBe("31%");
  expect(formatValue(612, "number", null, "en")).toBe("612");
  // A currency Intl does not know is written after the number.
  expect(formatValue(5, "money", "XX$", "en")).toBe("5 XX$");
});
