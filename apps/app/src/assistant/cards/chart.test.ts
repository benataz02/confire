import { expect, test } from "bun:test";
import { chartChoices, chartCsv, drillLink, type ReportOut } from "./chart.ts";

const report = (o: Partial<ReportOut>): ReportOut => ({
  entity: "Invoices", title: "Sales", chart: "column", dimension: { field: "CardName", label: "Customer" }, series: null,
  measures: [{ label: "Total", fn: "sum", field: "DocTotal", money: true }], rows: [], scanned: 0, total: 0, truncated: false, ...o,
});

test("the charts a report may switch to: the one asked for first, a table always", () => {
  expect(chartChoices(report({ chart: "bar" }))).toEqual(["bar", "column", "donut", "table"]);
  expect(chartChoices(report({ chart: "pie" }))).toEqual(["pie", "column", "bar", "table"]);
  // A donut over two measures does not fit: the first that does is drawn.
  expect(chartChoices(report({ chart: "donut", measures: [report({}).measures[0]!, { label: "N", fn: "count", money: false }] })))
    .toEqual(["column", "bar", "table"]);
  expect(chartChoices(report({ chart: "column", dimension: { field: "DocDate", label: "Date", bucket: "month" } }))).toEqual(["column", "line", "table"]);
  expect(chartChoices(report({ chart: "bar", dimension: null }))).toEqual(["kpi", "table"]);
});

test("a bar opens its list: the tool's filters the list can take, its date bounds, the bar's value or range", () => {
  const pool = new Set(["documentstatus", "salespersoncode", "docdate", "cardname"]);
  const filter = [
    { field: "DocumentStatus", op: "eq", value: "bost_Open" },
    { field: "SalesPersonCode", op: "in", value: [1, 2] },
    { field: "DocDate", op: "ge", value: "2026-01-01" },
    { field: "DocDate", op: "le", value: "2026-06-30T00:00:00Z" },
    { field: "Comments", op: "eq", value: "not on the list" },
  ];
  expect(drillLink("/b1/Orders", filter, "CardName", "ACME", pool)).toEqual({
    to: "/b1/Orders", search: { DocumentStatus: "bost_Open", SalesPersonCode: "1,2", DocDate: "2026-01-01~2026-06-30", CardName: "ACME" },
  });
  // A bucket's own range wins over the tool's bounds.
  expect(drillLink("/b1/Orders", filter, "DocDate", "2026-03-01~2026-03-31", pool)?.search?.DocDate).toBe("2026-03-01~2026-03-31");
  expect(drillLink("/b1/Orders", [], null, null, pool)).toEqual({ to: "/b1/Orders", search: {} });
  // A bar whose field the list cannot filter on opens nothing.
  expect(drillLink("/b1/Orders", [], "Comments", "x", pool)).toBeNull();
});

test("CSV: raw numbers, quoted text, a formula never runs", () => {
  const csv = chartCsv(report({ rows: [{ key: "A", label: 'ACME, "Ltd"', values: [1500.5] }, { key: "=1+1", label: "=1+1", values: [2] }] }));
  expect(csv.split("\r\n")).toEqual(["Customer,Total", '"ACME, ""Ltd""",1500.5', `"'=1+1",2`]);
});
