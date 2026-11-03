import { ReportDefZ, type ReportDef } from "@confire/db";

// "Sales pipeline by month" as the assistant would first draft it (the approved mockup): open
// quotations and open orders of the last 12 months, five widgets over one union dataset, and the
// documents behind them. Shared by the reports tests.

const sum = (label: string, extra: Record<string, unknown> = {}) =>
  ({ dataset: "docs", agg: "sum", field: "DocTotal", minus: "VatSum", label, format: "money", ...extra });

export const PIPELINE_INPUT = {
  title: "Sales pipeline by month",
  subtitle: "Open quotations and orders",
  assumptions: [
    { label: "Data", value: "open Quotations + open Orders" },
    { label: "Period", value: "last 12 months, by document date" },
    { label: "Value", value: "net total, local currency" },
  ],
  datasets: {
    docs: {
      from: [
        { source: "b1", entity: "Quotations", label: "Quotation" },
        { source: "b1", entity: "Orders", label: "Order" },
      ],
      select: ["DocNum", "DocDate", "DocDueDate", "CardCode", "CardName", "DocTotal", "VatSum", "SalesPersonCode"],
      filter: [
        { field: "DocumentStatus", op: "eq", value: "bost_Open" },
        { field: "DocDate", op: "ge", value: "@today-12M" },
      ],
      lookups: [{ name: "salesPerson", field: "SalesPersonCode", entity: "SalesPersons", key: "SalesEmployeeCode", value: "SalesEmployeeName" }],
      derive: [
        { name: "month", field: "DocDate", bucket: "month" },
        { name: "age", field: "DocDate", bucket: { ageDays: [30, 60, 90] } },
      ],
    },
  },
  widgets: [
    { kind: "kpi", title: "Open pipeline", value: sum("Net value") },
    { kind: "kpi", title: "Open quotations", value: { dataset: "docs", agg: "count", label: "Quotations", filter: [{ field: "_source", op: "eq", value: "Quotation" }] } },
    { kind: "chart", title: "Pipeline by month", chart: "composed", size: "wide", dimension: "month", series: "_source", measures: [sum("Net value")] },
    { kind: "chart", title: "By sales employee", chart: "donut", dimension: "salesPerson", measures: [sum("Net value")] },
    { kind: "chart", title: "Top 10 customers", chart: "bar", dimension: "CardName", top: 10, measures: [sum("Net value")] },
    { kind: "chart", title: "Pipeline age", chart: "column", dimension: "age", measures: [sum("Net value")] },
    {
      kind: "table", title: "Open documents", dataset: "docs",
      columns: ["month", "_source", "DocNum", "CardName", "salesPerson", "DocDueDate", "DocTotal"],
      groupBy: ["month"], sortBy: [{ field: "DocTotal", dir: "desc" }],
    },
  ],
};

export const PIPELINE: ReportDef = ReportDefZ.parse(PIPELINE_INPUT);
