import { expect, test } from "bun:test";
import { B1Error, DirectTransport, type B1EntitySchema, type B1Field } from "@confire/b1";
import { ReportDefZ, type ReportDef } from "@confire/db";
import { ReportInvalid, runWith, type Sources } from "../src/reports/run.ts";
import type { KpiResult, TableResult } from "../src/reports/types.ts";
import { PIPELINE, PIPELINE_INPUT } from "./fixtures/pipeline-report.ts";

// The runner (reports spec §3.3) over an in-memory Service Layer: every page read, totals pushed down,
// the row-reading fallback when `$apply` is refused, the caps, lookups, validation. No DB.

const today = new Date("2026-11-03T00:00:00Z");
const f = (name: string, kind: B1Field["kind"]): B1Field => ({ name, kind, edmType: "" });
const schemaOf = (name: string, keys: string[], fields: B1Field[]): B1EntitySchema =>
  ({ name, entityType: name, table: name, label: name, entityClass: "standard", keys, fields });
const DOC = (name: string) => schemaOf(name, ["DocEntry"], [
  f("DocEntry", "number"), f("DocNum", "number"), f("DocDate", "date"), f("DocDueDate", "date"), f("CardCode", "string"),
  f("CardName", "string"), f("DocTotal", "number"), f("VatSum", "number"), f("SalesPersonCode", "number"), f("DocumentStatus", "string"),
]);
const SCHEMAS: Record<string, B1EntitySchema> = {
  Quotations: DOC("Quotations"), Orders: DOC("Orders"),
  SalesPersons: schemaOf("SalesPersons", ["SalesEmployeeCode"], [f("SalesEmployeeCode", "number"), f("SalesEmployeeName", "string")]),
  EmployeesInfo: schemaOf("EmployeesInfo", ["EmployeeID"], [f("EmployeeID", "number"), f("LastName", "string")]),
};

type Rows = Record<string, unknown>[];
/** A Service Layer over `store`: pages at `Prefer: odata.maxpagesize` with a nextLink, `$count` on
 *  request, `X eq v` conditions kept (an OR of them per field), and `$apply` answered from `apply`
 *  (by entity set) or refused with a 400. */
function fakeSap(store: Record<string, Rows>, o: { apply?: Record<string, Rows>; refuseApply?: boolean } = {}) {
  const calls: string[] = [];
  const t = new DirectTransport(async (req) => {
    calls.push(req.path);
    const [target = "", qs = ""] = req.path.split(/\?(.*)/s);
    const params = Object.fromEntries(qs.split("&").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), decodeURIComponent(kv.slice(kv.indexOf("=") + 1))]));
    const size = Number(/odata\.maxpagesize=(\d+)/.exec(req.headers?.Prefer ?? "")?.[1] ?? 20);
    const skip = Number(params.$skip ?? 0);
    let rows: Rows;
    if (params.$apply) {
      if (o.refuseApply) throw new B1Error(400, -1000, "Invalid $apply");
      rows = o.apply?.[target] ?? [];
    } else {
      const wanted = new Map<string, Set<string>>();
      for (const [, k, v] of (params.$filter ?? "").matchAll(/(\w+) eq '?([^' )]*)'?/g)) {
        if (!wanted.has(k!)) wanted.set(k!, new Set());
        wanted.get(k!)!.add(v!);
      }
      rows = (store[target] ?? []).filter((r) => [...wanted].every(([k, vs]) => vs.has(String(r[k]))));
    }
    const value = rows.slice(skip, skip + size);
    const rest = qs.split("&").filter((kv) => kv && !kv.startsWith("$skip=")).join("&");
    return {
      status: 200,
      data: {
        value,
        ...(params.$count ? { "@odata.count": rows.length } : {}),
        ...(skip + size < rows.length ? { "@odata.nextLink": `${target}?${rest}&$skip=${skip + size}` } : {}),
      },
    };
  });
  const src: Sources = {
    b1: t, company: "SBODEMO", currency: "EUR",
    schema: async (e) => SCHEMAS[e] ?? null,
    confire: async () => ({ rows: [], total: 0 }),
  };
  return { calls, src };
}

const quote = (i: number, extra: Record<string, unknown> = {}) => ({
  DocEntry: i, DocNum: 1000 + i, DocDate: "2026-10-01", DocDueDate: "2026-11-30", CardCode: "C1", CardName: "ACME",
  DocTotal: 100, VatSum: 21, SalesPersonCode: 1, DocumentStatus: "bost_Open", ...extra,
});
const ONE = (widgets: unknown[], datasets: unknown = { d: { from: [{ source: "b1", entity: "Quotations" }], select: ["DocDate", "DocTotal"], derive: [{ name: "month", field: "DocDate", bucket: "month" }] } }): ReportDef =>
  ReportDefZ.parse({ title: "t", assumptions: [], datasets, widgets });

test("every page is read: 600 open quotations through the fallback are all counted", async () => {
  const { src } = fakeSap({ Quotations: Array.from({ length: 600 }, (_, i) => quote(i + 1)), Orders: [], SalesPersons: [{ SalesEmployeeCode: 1, SalesEmployeeName: "Ana" }] }, { refuseApply: true });
  const r = await runWith(src, PIPELINE, "member", today);
  expect((r.widgets[1] as KpiResult).value).toBe(600);
  expect((r.widgets[0] as KpiResult).value).toBe(600 * 79);
  expect(r.datasets.docs!.fellBack).toBe(true);
  expect(r.company).toBe("SBODEMO");
});

test("pushdown: SAP's totals are used as they come, lookups batched by 50", async () => {
  const totals = Array.from({ length: 120 }, (_, i) => ({ DocDate: "2026-10-01", SalesPersonCode: i + 1, CardName: "ACME", sum_DocTotal: 100, sum_VatSum: 21, n: 1 }));
  const persons = Array.from({ length: 120 }, (_, i) => ({ SalesEmployeeCode: i + 1, SalesEmployeeName: `P${i + 1}` }));
  const { src, calls } = fakeSap({ SalesPersons: persons, Quotations: [], Orders: [] }, { apply: { Quotations: totals } });
  const r = await runWith(src, PIPELINE, "member", today);
  expect((r.widgets[0] as KpiResult).value).toBe(120 * 79);
  expect(r.datasets.docs!.fellBack).toBe(false);
  expect(calls.filter((p) => p.startsWith("SalesPersons?")).length).toBe(3);
  expect(calls.some((p) => p.startsWith("Quotations?$apply="))).toBe(true);
});

test("more than 40 pages marks the dataset partial and warns", async () => {
  const { src } = fakeSap({ Quotations: Array.from({ length: 20_500 }, (_, i) => quote(i + 1)) }, { refuseApply: true });
  const r = await runWith(src, ONE([{ kind: "kpi", title: "n", value: { dataset: "d", agg: "count", label: "n" } }]), "member", today);
  expect(r.datasets.d!.partial).toEqual({ read: 20_000, total: 20_500 });
  expect((r.widgets[0] as KpiResult).value).toBe(20_000);
  expect(r.warnings.length).toBeGreaterThan(0);
});

test("validation: every problem in one refusal", async () => {
  const { src } = fakeSap({});
  const bad = {
    ...PIPELINE_INPUT,
    datasets: { docs: { ...PIPELINE_INPUT.datasets.docs, select: ["DocTotl"] } },
    widgets: [...PIPELINE_INPUT.widgets, { kind: "chart", title: "x", chart: "donut", dimension: "Nope", measures: [{ dataset: "docs", agg: "count", label: "n" }] }],
  };
  const e = await runWith(src, ReportDefZ.parse(bad), "member", today).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ReportInvalid);
  const text = (e as ReportInvalid).problems.join("\n");
  expect(text).toContain("DocTotl (did you mean DocTotal?)");
  expect(text).toContain("Nope");
  const two = ONE([{ kind: "chart", title: "x", chart: "column", dimension: "Foo", measures: [{ dataset: "missing", agg: "count", label: "n" }] }]);
  const e2 = (await runWith(src, two, "member", today).catch((x: unknown) => x)) as ReportInvalid;
  expect(e2.problems.length).toBeGreaterThanOrEqual(1);
  expect(e2.problems.join("\n")).toContain("missing");
});

test("an admin-only set is refused for a member, read for an admin", async () => {
  const { src } = fakeSap({ EmployeesInfo: [{ EmployeeID: 1, LastName: "Doe" }] }, { refuseApply: true });
  const def = ONE([{ kind: "kpi", title: "n", value: { dataset: "e", agg: "count", label: "n" } }], { e: { from: [{ source: "b1", entity: "EmployeesInfo" }] } });
  const e = (await runWith(src, def, "member", today).catch((x: unknown) => x)) as ReportInvalid;
  expect(e).toBeInstanceOf(ReportInvalid);
  expect(e.problems.join("\n")).toContain("EmployeesInfo");
  expect(((await runWith(src, def, "admin", today)).widgets[0] as KpiResult).value).toBe(1);
});

test("the table: at most 2,000 rows, its sort, the derived month and the entity attached", async () => {
  const rows = Array.from({ length: 2_500 }, (_, i) => quote(i + 1, { DocTotal: i }));
  const { src } = fakeSap({ Quotations: rows });
  const def = ONE([{ kind: "table", title: "docs", dataset: "d", columns: ["month", "DocNum", "DocTotal"], sortBy: [{ field: "DocTotal", dir: "desc" }] }]);
  const t = (await runWith(src, def, "member", today)).widgets[0] as TableResult;
  expect(t.rows).toHaveLength(2_000);
  expect(t.total).toBe(2_500);
  expect(t.partial).toBe(true);
  expect(t.rows[0]!.month).toMatch(/^\d{4}-\d{2}$/);
  expect(t.rows[0]!._entity).toBe("Quotations");
});

test("SAP not connected: a b1 dataset is refused, a Confire-only report runs", async () => {
  const { src } = fakeSap({});
  const off: Sources = { ...src, b1: null, confire: async () => ({ rows: [{ status: "quoted", quotedValue: 5 }, { status: "draft", quotedValue: null }], total: 2 }) };
  expect(await runWith(off, PIPELINE, "member", today).catch((x: unknown) => x)).toBeInstanceOf(ReportInvalid);
  const confire = ONE([{ kind: "kpi", title: "q", value: { dataset: "c", agg: "sum", field: "quotedValue", label: "q" } }], { c: { from: [{ source: "confire", entity: "Configurations" }] } });
  expect(((await runWith(off, confire, "member", today)).widgets[0] as KpiResult).value).toBe(5);
});

test("a filter SAP's grammar cannot take is a refusal the model can fix, before any read", async () => {
  const { src, calls } = fakeSap({});
  const bad = ONE([{ kind: "kpi", title: "n", value: { dataset: "d", agg: "count", label: "n" } }],
    { d: { from: [{ source: "b1", entity: "Quotations" }], filter: [{ field: "DocumentStatus", op: "eq", value: ["bost_Open"] }, { field: "DocTotal", op: "gt", value: "abc" }] } });
  const e = (await runWith(src, bad, "member", today).catch((x: unknown) => x)) as ReportInvalid;
  expect(e).toBeInstanceOf(ReportInvalid);
  expect(e.problems.join("\n")).toContain("DocumentStatus");
  expect(e.problems.join("\n")).toContain("abc");
  expect(calls).toEqual([]);
});
