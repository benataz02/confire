import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db, configModel, configProject } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { aggregate, dayOf, ReportSpecZ, specProblems, type FieldInfo, type ReportSpec } from "../src/report.ts";
import { GENERAL } from "../src/assistant/pages.ts";
import { MCP_TOOL_NAMES } from "../src/assistant/tools.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The assistant's charts: the pure engine (report.ts), then both sources through their procedures.

const FIELDS = new Map<string, FieldInfo>([
  ["CardName", { label: "Customer", kind: "string" }],
  ["DocDate", { label: "Date", kind: "date" }],
  ["DocTotal", { label: "Total", kind: "number" }],
  ["DocumentStatus", { label: "Status", kind: "enum" }],
]);
const spec = (s: Partial<ReportSpec>): ReportSpec => ReportSpecZ.parse({ title: "T", chart: "column", measures: [{ fn: "count" }], ...s });
const run = (rows: Record<string, unknown>[], s: Partial<ReportSpec>) => aggregate(rows, spec(s), FIELDS, { total: rows.length, truncated: false });

const ROWS = [
  { CardName: "ACME", DocDate: "2026-01-15T00:00:00Z", DocTotal: 100, DocumentStatus: "bost_Open" },
  { CardName: "ACME", DocDate: "2026-01-20", DocTotal: 50, DocumentStatus: "bost_Close" },
  { CardName: "Beta", DocDate: "2026-03-02", DocTotal: 300, DocumentStatus: "bost_Open" },
  { CardName: "Gamma", DocDate: "2026-03-30", DocTotal: "25.5", DocumentStatus: "bost_Open" },
  { CardName: null, DocDate: null, DocTotal: null, DocumentStatus: "bost_Open" },
];

test("categories by the first measure, largest first; the rest is Other; empty values are (none)", () => {
  const r = run(ROWS, { groupBy: { field: "CardName" }, measures: [{ fn: "sum", field: "DocTotal", money: true }, { fn: "count" }], top: 2 });
  expect(r.rows.map((x) => [x.key, x.label, x.values])).toEqual([
    ["Beta", "Beta", [300, 1]],
    ["ACME", "ACME", [150, 2]],
    [null, "Other", [25.5, 2]],
  ]);
  expect(r.measures).toEqual([
    { label: "Sum Total", fn: "sum", field: "DocTotal", money: true },
    { label: "Count", fn: "count", money: false },
  ]);
  expect(r.dimension).toEqual({ field: "CardName", label: "Customer" });
  const all = run(ROWS, { groupBy: { field: "CardName" }, sort: "label" });
  expect(all.rows.map((x) => x.label)).toEqual(["ACME", "Beta", "Gamma", "(none)"]);
});

test("a time axis: in order, gaps filled with zeros, each bucket's key a date range; no Other", () => {
  const r = run(ROWS, { groupBy: { field: "DocDate", bucket: "month" }, measures: [{ fn: "sum", field: "DocTotal" }], top: 1 });
  expect(r.rows).toEqual([
    { key: "2026-01-01~2026-01-31", label: "2026-01", values: [150] },
    { key: "2026-02-01~2026-02-28", label: "2026-02", values: [0] },
    { key: "2026-03-01~2026-03-31", label: "2026-03", values: [325.5] },
    { key: null, label: "(none)", values: [0] },
  ]);
  const q = run(ROWS, { groupBy: { field: "DocDate", bucket: "quarter" } });
  expect(q.rows[0]).toEqual({ key: "2026-01-01~2026-03-31", label: "2026 Q1", values: [4] });
});

test("a series splits one measure; a kpi without groupBy is one row; avg, min and max", () => {
  const r = run(ROWS, { groupBy: { field: "DocDate", bucket: "year" }, series: { field: "DocumentStatus" } });
  expect(r.measures.map((m) => m.label)).toEqual(["bost_Open", "bost_Close"]);
  expect(r.rows[0]).toEqual({ key: "2026-01-01~2026-12-31", label: "2026", values: [3, 1] });
  const k = run(ROWS, { chart: "kpi", measures: [{ fn: "avg", field: "DocTotal" }, { fn: "min", field: "DocTotal" }, { fn: "max", field: "DocTotal" }] });
  expect(k.rows).toEqual([{ key: "", label: "T", values: [118.88, 25.5, 300] }]);
  expect(k.dimension).toBeNull();
});

test("a spec's mistakes are named before any row is read", () => {
  expect(specProblems(spec({ groupBy: { field: "CardName", bucket: "month" }, measures: [{ fn: "sum", field: "CardName" }, { fn: "avg" }] }), FIELDS)).toEqual([
    "CardName: only a date field takes a bucket", "CardName: sum needs a numeric field", "avg: needs a numeric field",
  ]);
  expect(specProblems(spec({ series: { field: "CardName" }, measures: [{ fn: "count" }, { fn: "count" }] }), FIELDS))
    .toEqual(["series: one measure only", "series: needs groupBy"]);
  expect(dayOf(new Date("2026-05-04T22:00:00Z"))?.toISOString()).toBe("2026-05-04T00:00:00.000Z");
  expect(dayOf("not a date")).toBeNull();
});

test("the chat's general page and MCP both have the report tools", () => {
  expect(GENERAL.tools).toEqual(expect.arrayContaining(["reports_sap", "reports_configs"]));
  expect(MCP_TOOL_NAMES).toEqual(expect.arrayContaining(["reports_sap", "reports_configs"]));
});

describe.skipIf(!process.env.DATABASE_URL)("reports", () => {
  let agent: MockAgent;
  const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
<edmx:DataServices><Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EntityType Name="Document"><Key><PropertyRef Name="DocEntry"/></Key>
    <Property Name="DocEntry" Type="Edm.Int32"/><Property Name="CardName" Type="Edm.String"/>
    <Property Name="DocDate" Type="Edm.DateTime"/><Property Name="DocTotal" Type="Edm.Double"/>
  </EntityType>
  <EntityType Name="EmployeeInfo"><Key><PropertyRef Name="EmployeeID"/></Key><Property Name="EmployeeID" Type="Edm.Int32"/></EntityType>
  <EntityContainer Name="ServiceLayer">
    <EntitySet Name="Invoices" EntityType="SAPB1.Document"/><EntitySet Name="EmployeesInfo" EntityType="SAPB1.EmployeeInfo"/>
  </EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
  beforeAll(() => { agent = startMockAgent(); agent.metadata.xml = EDMX; });
  afterAll(() => agent.stop());

  const world = async () => {
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser("member", tenantId);
    await connectTenant(tenantId, agent);
    return { tenantId, userId: u.userId, opts: { context: { headers: tenantHeaders(slug, u.cookie) } } };
  };
  const message = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

  test("reports.sap reads narrow rows from SAP and counts them here; wrong names are refused with the closest", async () => {
    const w = await world();
    agent.store.Invoices = ROWS.slice(0, 4).map((r, i) => ({ DocEntry: i + 1, ...r }));
    const out = await call(router.reports.sap, {
      entity: "Invoices", title: "Sales", chart: "bar",
      groupBy: { field: "CardName" }, measures: [{ fn: "sum", field: "DocTotal" }],
    }, w.opts);
    expect(out.entity).toBe("Invoices");
    expect(out.rows.map((r) => [r.label, r.values[0]])).toEqual([["Beta", 300], ["ACME", 150], ["Gamma", 25.5]]);
    expect(out).toMatchObject({ scanned: 4, truncated: false });
    const sent = agent.calls.filter((c) => c.route === "/entity-set").at(-1)!.body as { query: { select: string[] } };
    expect(sent.query.select.sort()).toEqual(["CardName", "DocEntry", "DocTotal"]);

    const filtered = await call(router.reports.sap, {
      entity: "Invoices", title: "ACME", chart: "kpi", measures: [{ fn: "count" }],
      filter: [{ field: "CardName", op: "eq", value: "ACME" }],
    }, w.opts);
    expect(filtered.rows[0]!.values).toEqual([2]);
    // A plain count is SAP's own $count over one row, not a scan.
    const counted = agent.calls.filter((c) => c.route === "/entity-set").at(-1)!.body as { query: { maxPageSize: number; count: boolean } };
    expect(counted.query).toMatchObject({ maxPageSize: 1, count: true });
    expect(filtered.scanned).toBe(1);

    expect(await message(call(router.reports.sap, { entity: "Invoices", title: "x", chart: "bar", groupBy: { field: "Cardname" }, measures: [{ fn: "count" }] }, w.opts)))
      .toContain("Cardname (did you mean CardName?)");
    expect(await message(call(router.reports.sap, { entity: "Invoices", title: "x", chart: "bar", measures: [{ fn: "sum", field: "CardName" }] }, w.opts)))
      .toContain("needs a numeric field");
    // An admin-only set stays admin-only.
    expect(await message(call(router.reports.sap, { entity: "EmployeesInfo", title: "x", chart: "kpi", measures: [{ fn: "count" }] }, w.opts)))
      .not.toBe("");
  });

  test("reports.configs counts the workspace's configurations, never another tenant's", async () => {
    const w = await world();
    const other = await world();
    const [m] = await db.insert(configModel).values({ tenantId: w.tenantId, name: "Door", definition: { name: "Door" } as never }).returning({ id: configModel.id });
    const [m2] = await db.insert(configModel).values({ tenantId: other.tenantId, name: "Door", definition: { name: "Door" } as never }).returning({ id: configModel.id });
    const base = { modelId: m!.id, tenantId: w.tenantId, createdBy: w.userId };
    await db.insert(configProject).values([
      { ...base, name: "a", status: "quoted", quotedValue: "1000", quotedCost: "600", customer: { cardCode: "C1", cardName: "ACME" } },
      { ...base, name: "b", status: "quoted", quotedValue: "500", quotedCost: "400", customer: { cardCode: "C1", cardName: "ACME" } },
      { ...base, name: "c", status: "draft", createdBy: "someone" },
      { modelId: m2!.id, tenantId: other.tenantId, createdBy: other.userId, name: "x", status: "quoted", quotedValue: "9999" },
    ]);
    const byStatus = await call(router.reports.configs, { title: "By status", chart: "donut", groupBy: { field: "status" }, measures: [{ fn: "count" }] }, w.opts);
    expect(byStatus.rows.map((r) => [r.key, r.values[0]])).toEqual([["quoted", 2], ["draft", 1]]);
    const margin = await call(router.reports.configs, {
      title: "Margin", chart: "kpi", measures: [{ fn: "sum", field: "quotedValue" }, { fn: "sum", field: "quotedMargin" }],
      filter: [{ field: "mine", op: "eq", value: "yes" }],
    }, w.opts);
    expect(margin.rows[0]!.values).toEqual([1500, 500]);
    const plain = await call(router.reports.configs, { title: "All", chart: "kpi", measures: [{ fn: "count" }] }, w.opts);
    expect(plain.rows[0]!.values).toEqual([3]);
  });
});
