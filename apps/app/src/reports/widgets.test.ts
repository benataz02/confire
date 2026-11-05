import { expect, test } from "bun:test";
import { chartComponent, chartProps, filterBar, filterRows, formatValue, reportConstraints, reportMessages, type ChartResult, type Result } from "./widgets.ts";

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

test("messages: a partial dataset, a fallback, a failed run, and a table cut at its cap — never silent", () => {
  const t = (k: string, ...a: string[]) => `${k}(${a.join("|")})`;
  const result = {
    readAt: "2026-11-03T10:00:00Z", company: null, currency: null, warnings: [],
    datasets: { d: { rows: 1, partial: { read: 20000, total: 25000 }, fellBack: true } },
    widgets: [{ kind: "table", title: "Docs", columns: ["a"], groupBy: [], rows: [], total: null, partial: true }],
  } as unknown as Result;
  const m = reportMessages(result, "boom", "Report", t);
  expect(m.map((x) => [x.type, x.text])).toEqual([
    ["Negative", "REPORT_FAILED()"],
    ["Critical", "REPORT_PARTIAL(d)"],
    ["Information", "REPORT_FELL_BACK(d)"],
    ["Critical", "REPORT_TABLE_PARTIAL(Docs)"],
  ]);
  expect(reportMessages(null, null, "Report", t)).toEqual([]);
});

test("the filter bar: a value help by the field's entity set, options as they come, the run's values", () => {
  const { pool, values } = filterBar([
    { field: "CardCode", label: "Customer", type: "string", value: ["C1"], declared: true, default: ["C1"], lookup: { entitySet: "BusinessPartners", keyField: "CardCode" } },
    { field: "DocumentStatus", label: "Status", type: "enum", value: null, declared: false, options: [{ value: "bost_Open", label: "Open" }] },
    { field: "Project", label: "Project", type: "string", value: "", declared: false, lookup: { entitySet: "Projects", keyField: "Code" } },
  ]);
  expect(pool[0]!.cfl?.dialogConfig.source).toEqual({ kind: "entity", entitySet: "BusinessPartners" });
  expect(pool[1]!.options).toEqual([{ value: "bost_Open", label: "Open" }]);
  expect(pool[2]!.cfl).toBeUndefined();
  expect(pool.map((f) => [f.visible, f.defaultValue])).toEqual([[true, ["C1"]], [false, undefined], [false, undefined]]);
  expect(values).toEqual({ CardCode: ["C1"] });
});

test("the report's metadata: sets merged, lines as Lines.X; the bar labels an undeclared field by it", () => {
  const f = (Label: string, extra = {}) => ({ Type: "string", EdmType: "Edm.String", Label, ...extra }) as never;
  const meta = reportConstraints([
    { name: "Quotations", label: "", keys: [], writable: true, fields: { DocNum: f("Document No."), DocumentLines: f("Lines", { Fields: { ItemCode: f("Item No.") } }) } },
    undefined,
    { name: "Orders", label: "", keys: [], writable: true, fields: { DocNum: f("Order No."), CardName: f("Customer Name") } },
  ]);
  expect(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.Label]))).toEqual({
    DocNum: "Document No.", "Lines.ItemCode": "Item No.", CardName: "Customer Name",
  });
  const { pool } = filterBar([
    { field: "DocNum", label: "Number", type: "number", value: null, declared: true },
    { field: "CardName", label: "CardName", type: "string", value: null, declared: false },
  ], meta);
  expect(pool.map((p) => p.label)).toEqual(["Number", "Customer Name"]);
});
