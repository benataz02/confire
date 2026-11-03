# Assistant-built reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A *New report* page where the assistant turns one line ("sales pipeline by month") into a live
SAP/Confire report — KPIs, UI5 charts, a grouped table — refined by chat and saved as a home tile.

**Architecture:** The model writes a `ReportDef` (data, filters, grouping, measures, widgets) through one
tool, `report_set`; the server validates it, pushes the totals down to the Service Layer with `$apply`
(grouped by the date field itself, bucketed on our side), follows every `nextLink`, and answers a
`ReportResult` the page draws. `b1_read` gains the same `aggregate` option. Reports and their chats are
rows (`report`, `assistant_thread.report_id`); a saved report is a home tile showing its last run.

**Tech Stack:** Bun, Hono, oRPC v2 beta (pinned), Drizzle/Postgres, zod v4, TanStack AI, React 19,
UI5 Web Components for React 2.27 (`@ui5/webcomponents-react-charts` already installed).

**Spec:** `docs/superpowers/specs/2026-11-03-assistant-reports-design.md`

## Global Constraints

- Bun only (`bun test`, `bun install`, `bunx tsc`); no npm.
- Type-check per project: `bunx tsc -p apps/server/tsconfig.json --noEmit`, `bunx tsc -p packages/b1/tsconfig.json --noEmit`, `bunx tsc -p packages/db/tsconfig.json --noEmit`, `bunx tsc -p apps/app/tsconfig.json --noEmit`, `bun --cwd apps/app build`.
- Imports carry explicit `.ts`/`.tsx` extensions; `verbatimModuleSyntax` is on (`import type` for types).
- `packages/b1/src/query.ts` is the only module that builds a Service Layer URL; nothing else writes `$apply` text into a path.
- No OData string ever comes from the model or the browser: every query is structured and compiled server-side.
- Every figure is computed by the server; `report_set` never returns rows to the model.
- Schema change = `bun run db:push` in dev, then `bun run db:generate`, and the generated `packages/db/drizzle/NNNN_*.sql` is committed. New schema files re-exported from `packages/db/src/schema/index.ts`.
- Every colour a theme variable (`var(--sap…)`) or a chart's default `sapChart` palette; no raw colours.
- UI texts through `useI18n()` keys, in `apps/app/src/i18n/parts/report.{en,es,eu}.properties` (English the base).
- Tests never send mail or call Anthropic (the root `bunfig.toml` preload); run `bun test` from the repo root. DB-backed tests are `describe.skipIf(!process.env.DATABASE_URL)`.
- Shortcuts with a known ceiling get a `// ponytail:` comment naming the ceiling and the upgrade path.
- Values from the spec: page size **500**; at most **40 pages** (20,000 rows) per read, then `partial`; table rows to the browser **2,000**; lookup batch **50** keys; tile refresh after **60 minutes**; chat column docked **360 px**.
- Unverified on a live B1 (mark in code `unverified (reports spec §3.3)`): `$apply` encoding, `$apply` over `$crossjoin`, the shape of a crossjoin's grouped rows.

## Review Focus

1. **A report's chat picked as the user's general chat.** `blankThread` and `threadFor(…, null)` select `projectId is null`; a report thread is that too. Expect: the AI page never opens a report's chat. → test in Task 6.
2. **No rows, or a zero denominator.** A wrong status filter or an empty company. Expect: KPIs `null` (drawn "—"), ratios `null`, charts with no rows — never `NaN`/`Infinity` in a result. → test in Task 4.
3. **Dates bucketed through a timezone.** B1 sends `"2026-11-01"` or `"2026-11-01T00:00:00Z"`; `new Date()` in a UTC−x zone shifts it into October. Expect: buckets read the text's `YYYY-MM-DD`. → test in Task 4.
4. **A tile from another SAP company.** The agent switched companies since the last run. Expect: the tile shows no figure until a run in the current company. → test in Task 6.
5. **Delete or re-run while the chat is answering.** Expect: `reports.delete` goes through the thread's lease and answers `THREAD_BUSY` mid-run, never deleting under a live run. → test in Task 6.

---

### Task 1: `$apply` in the B1 query layer, and paging any first page

**Files:**
- Modify: `packages/b1/src/types.ts` (`QueryOptions`, `CrossJoinSpec`)
- Modify: `packages/b1/src/query.ts` (`queryString`, `crossJoinPath`)
- Modify: `packages/b1/src/client.ts` (`crossJoin` sends the page header)
- Modify: `packages/b1/src/paging.ts` (`followPages`; `readPages` uses it)
- Test: `packages/b1/test/paging.test.ts`

**Interfaces:**
- Produces: `QueryOptions.apply?: string`; `CrossJoinSpec.apply?: string` and `CrossJoinSpec.maxPageSize?: number`; `followPages(t: B1Transport, first: B1Response, opts: { pageSize: number; maxPages: number }): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }>` (page 1 is `first`; follows `@odata.nextLink` with `readNext(link, pageSize)` until none or `maxPages` pages read).

- [ ] **Step 1: Write the failing tests** (append to `packages/b1/test/paging.test.ts`, reusing its `spy()`)

```ts
describe("$apply", () => {
  test("an entity set read carries $apply after $filter, the value encoded like $filter", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Orders", { apply: "groupby((CardCode),aggregate(DocTotal with sum as a0))", maxPageSize: 500 });
    expect(calls[0]!.path).toBe(`Orders?$apply=${encodeURIComponent("groupby((CardCode),aggregate(DocTotal with sum as a0))")}`);
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=500" });
  });
  test("a crossjoin carries $apply and pages with Prefer", async () => {
    const { calls, t } = spy();
    await t.crossJoin({ entities: ["Orders", "Orders/DocumentLines"], expand: [], apply: "aggregate($count as n)", maxPageSize: 500 });
    expect(calls[0]!.path).toBe(`$crossjoin(Orders,Orders/DocumentLines)?$apply=${encodeURIComponent("aggregate($count as n)")}`);
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=500" });
  });
});

describe("followPages", () => {
  test("follows every nextLink from a first page it did not read, and stops at maxPages", async () => {
    const pages = [{ value: [{ i: 2 }], "@odata.nextLink": "Orders?$skip=2" }, { value: [{ i: 3 }] }];
    const t = new DirectTransport(async () => ({ status: 200, data: pages.shift() }));
    const first = { status: 200, data: { value: [{ i: 1 }], "@odata.nextLink": "Orders?$skip=1" } };
    expect(await followPages(t, first, { pageSize: 1, maxPages: 10 })).toEqual({ rows: [{ i: 1 }, { i: 2 }, { i: 3 }], truncated: false });
    const capped = await followPages(t, { status: 200, data: { value: [{ i: 1 }], "@odata.nextLink": "x" } }, { pageSize: 1, maxPages: 1 });
    expect(capped.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/b1/test/paging.test.ts`
Expected: FAIL (`apply` not emitted, `followPages` not exported).

- [ ] **Step 3: Implement**

`queryString`: `if (q.apply) set("$apply", q.apply)` right after `$filter`. `crossJoinPath`: push `$apply=${encodeURIComponent(spec.apply)}` after `$filter`. `DirectTransport.crossJoin`: `this.get(crossJoinPath(spec), pageHeader({ maxPageSize: spec.maxPageSize }))`. `followPages` holds the loop `readPages` has today; `readPages` reads page 1 and calls it. Add the comment `// unverified (reports spec §3.3): $apply encoded like $filter; if a live B1 400s on it, compose it unencoded as crossJoinPath does $expand.`

- [ ] **Step 4: Run them to verify they pass, and type-check**

Run: `bun test packages/b1/test && bunx tsc -p packages/b1/tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/b1 && git commit -m "b1: \$apply on reads and crossjoins; followPages pages any first page"
```

---

### Task 2: `compileAggregate`, and `b1.read` answers totals

**Files:**
- Modify: `apps/server/src/entity-list.ts` (extract `compileFilter`; add `compileAggregate`, `compileLinesAggregate`, `flattenJoined`)
- Modify: `apps/server/src/entity-read.ts` (`RowsArgs.aggregate`)
- Modify: `apps/server/src/orpc/routers/b1.ts` (`read` input `aggregate`, name check, description)
- Modify: `apps/server/test/mock-agent.ts` (parse `$apply`, `$skip`; emit `@odata.nextLink`; `applyRows` fixtures; `noApply` set)
- Test: `apps/server/test/aggregate-compile.test.ts` (new, pure), `apps/server/test/b1-tools.test.ts`

**Interfaces:**
- Consumes: `QueryOptions.apply`, `CrossJoinSpec.apply/maxPageSize` (Task 1).
- Produces (all in `entity-list.ts`):
  - `type Agg = "sum" | "count" | "countDistinct" | "avg" | "min" | "max"`
  - `type AggSpec = { groupBy: string[]; measures: { field?: string; agg: Agg; as: string }[] }`
  - `compileFilter(fields: Map<string, B1Field>, filter: FilterCond[], name?: (field: string) => string): string | undefined` — the filter half of `compileList`, which now calls it; `name` maps a field to its path (default: itself).
  - `compileAggregate(schema: B1EntitySchema, filter: FilterCond[], agg: AggSpec, opts: { pageSize: number; extraFilter?: string }): QueryOptions` → `{ apply, maxPageSize }`, where apply = `filter(<f>)/groupby((A,B),aggregate(<m>,…))`, the `filter(…)/` part only when there is a filter, `groupby((…),…)` only when `groupBy` is non-empty. A measure is `<field> with sum|average|min|max|countdistinct as <as>`; `count` is `$count as <as>`. Names through `assertName`.
  - `compileLinesAggregate(header: B1EntitySchema, set: string, filter: FilterCond[], agg: AggSpec, opts: { pageSize: number }): CrossJoinSpec` — fields `X` → `<set>/X`, `Lines.X` → `<set>/DocumentLines/X` (line fields from `collectionOf(header, "DocumentLines").fields`); the filter always starts with `<set>/DocEntry eq <set>/DocumentLines/DocEntry`; a measure on a line field is `<set>/DocumentLines(<X> with sum as <as>)`, on a header field `<set>(<X> with … as <as>)` (the skill's documented crossjoin form; unverified).
  - `flattenJoined(row: Record<string, unknown>, set: string): Record<string, unknown>` — a crossjoin row back to dataset names: a nested `{ "<set>": {…} }` spreads bare, `{ "<set>/DocumentLines": {…} }` spreads as `Lines.*`, a flat `"<set>/DocumentLines/ItemCode"` key becomes `Lines.ItemCode`, other keys (the aliases) stay.
- `b1.read` input gains `aggregate?: AggSpec` (zod `AggSpecZ`, exported from `entity-list.ts`); `readRows`' `RowsArgs` gains `aggregate?: AggSpec`, compiled with `compileAggregate` (its `extraFilter` inside `filter(…)`) instead of `compileList` on page 1.

- [ ] **Step 1: Write the failing pure tests** (`apps/server/test/aggregate-compile.test.ts`), with a small inline `B1EntitySchema` for `Orders` (DocEntry, DocDate date, CardCode string, DocTotal number, VatSum number, DocumentStatus enum `bost_Open|bost_Close`, DocumentLines collection with ItemCode string, LineTotal number)

```ts
test("groupby + aggregates after the filter", () => {
  const q = compileAggregate(ORDERS, [{ field: "DocumentStatus", op: "eq", value: "bost_Open" }],
    { groupBy: ["DocDate", "CardCode"], measures: [{ field: "DocTotal", agg: "sum", as: "a0" }, { agg: "count", as: "n" }] }, { pageSize: 500 });
  expect(q.apply).toBe("filter(DocumentStatus eq 'bost_Open')/groupby((DocDate,CardCode),aggregate(DocTotal with sum as a0,$count as n))");
  expect(q.maxPageSize).toBe(500);
});
test("no groupBy is one total; no filter has no filter step", () => {
  expect(compileAggregate(ORDERS, [], { groupBy: [], measures: [{ field: "DocTotal", agg: "avg", as: "a0" }] }, { pageSize: 500 }).apply)
    .toBe("aggregate(DocTotal with average as a0)");
});
test("an injected quote is escaped; an unknown field is refused", () => {
  expect(compileAggregate(ORDERS, [{ field: "CardCode", op: "eq", value: "O'Neil" }], { groupBy: [], measures: [{ agg: "count", as: "n" }] }, { pageSize: 500 }).apply)
    .toContain("CardCode eq 'O''Neil'");
  expect(() => compileAggregate(ORDERS, [], { groupBy: ["Nope"], measures: [{ agg: "count", as: "n" }] }, { pageSize: 500 })).toThrow("Nope");
});
test("lines: the DocEntry join first, prefixed names, line measures on the lines path", () => {
  const s = compileLinesAggregate(ORDERS, "Orders", [{ field: "Lines.ItemCode", op: "eq", value: "A" }],
    { groupBy: ["DocDate", "Lines.ItemCode"], measures: [{ field: "Lines.LineTotal", agg: "sum", as: "a0" }] }, { pageSize: 500 });
  expect(s.entities).toEqual(["Orders", "Orders/DocumentLines"]);
  expect(s.apply).toBe("filter(Orders/DocEntry eq Orders/DocumentLines/DocEntry and (Orders/DocumentLines/ItemCode eq 'A'))/groupby((Orders/DocDate,Orders/DocumentLines/ItemCode),aggregate(Orders/DocumentLines(LineTotal with sum as a0)))");
});
test("flattenJoined reads both answer shapes", () => {
  expect(flattenJoined({ Orders: { DocDate: "2026-11-01" }, "Orders/DocumentLines": { ItemCode: "A" }, a0: 5 }, "Orders"))
    .toEqual({ DocDate: "2026-11-01", "Lines.ItemCode": "A", a0: 5 });
  expect(flattenJoined({ "Orders/DocDate": "2026-11-01", "Orders/DocumentLines/ItemCode": "A", a0: 5 }, "Orders"))
    .toEqual({ DocDate: "2026-11-01", "Lines.ItemCode": "A", a0: 5 });
});
```

- [ ] **Step 2: Run to verify they fail** — `bun test apps/server/test/aggregate-compile.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Implement the compilers in `entity-list.ts`**; `compileList` calls `compileFilter` (behaviour unchanged — `bun test apps/server/test` stays green).

- [ ] **Step 4: Run the pure tests** — PASS.

- [ ] **Step 5: Extend the mock agent.** `operationOf` puts `$apply` into `query.apply` (entity set) and `body.apply` (crossjoin), and `$skip` into `query.skip`. `/entity-set` and `/cross-join`: when `apply` is set and the set is in `noApply` (a new `Set<string>` on `MockAgent`), fail `400, -1000, "Invalid $apply"`; else answer `store[`${set}#apply`]` (fixture rows). Paging: slice `rows.slice(skip, skip + page)` and, when rows remain, add `"@odata.nextLink": `${target}?${qs without $skip}&$skip=${skip + page}``.

- [ ] **Step 6: Write the failing router test** (in `b1-tools.test.ts`'s DB block)

```ts
test("b1.read: aggregate goes to SAP as $apply, names checked, totals paged", async () => {
  const w = await world();
  agent.store["Orders#apply"] = [{ CardCode: "C1", a0: 10 }, { CardCode: "C2", a0: 7 }];
  const out = await call(router.b1.read, { entity: "Orders", query: { filter: [{ field: "CardCode", op: "ne", value: "X" }] },
    aggregate: { groupBy: ["CardCode"], measures: [{ field: "DocTotal", agg: "sum", as: "a0" }] } }, w.staff);
  expect(out.rows).toEqual([{ CardCode: "C1", a0: 10 }, { CardCode: "C2", a0: 7 }]);
  expect(agent.calls.at(-1)!.body.query.apply).toBe("filter(CardCode ne 'X')/groupby((CardCode),aggregate(DocTotal with sum as a0))");
  expect(await message(call(router.b1.read, { entity: "Orders", aggregate: { groupBy: ["Cardcode"], measures: [{ agg: "count", as: "n" }] } }, w.staff)))
    .toContain("Cardcode (did you mean CardCode?)");
});
test("b1.read follows nextLink: 600 rows are two pages", async () => {
  const w = await world();
  agent.store.Orders = Array.from({ length: 600 }, (_, i) => ({ ...order(), DocEntry: i + 1 }));
  const p1 = await call(router.b1.read, { entity: "Orders", query: { select: ["DocNum"] } }, w.staff);
  expect(p1.rows).toHaveLength(500);
  const p2 = await call(router.b1.read, { entity: "Orders", query: { select: ["DocNum"] }, cursor: p1.nextCursor }, w.staff);
  expect(p2.rows).toHaveLength(100);
  expect(p2.nextCursor).toBeUndefined();
});
```

- [ ] **Step 7: Implement `b1.read`'s `aggregate`**: input `aggregate: AggSpecZ.optional()`; `checkQueryNames` also checks `aggregate.groupBy` and measure fields against the scalars; `readRows(…, { …, aggregate })`; rows are not projected when aggregating. Description gains one sentence: "`aggregate` asks SAP for totals instead of rows — `groupBy` fields and `measures` (`sum`, `count`, `countDistinct`, `avg`, `min`, `max`, each named by `as`); `query.filter` applies first. Use it for any total: never add rows up yourself."

- [ ] **Step 8: Run the server tests and type-check**

Run: `bun test apps/server/test/aggregate-compile.test.ts apps/server/test/b1-tools.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: PASS (DB tests run with `DATABASE_URL` set and Postgres up; ask the user to start it if the socket is denied).

- [ ] **Step 9: Commit**

```bash
git add apps/server && git commit -m "b1.read: SAP-side totals (\$apply) through compileAggregate"
```

---

### Task 3: The report's schema, definition and date tokens

**Files:**
- Create: `packages/db/src/schema/report.ts` (table `report`, `ReportDefZ` and its parts)
- Modify: `packages/db/src/schema/assistant.ts` (`assistantThread.reportId`, partial unique index)
- Modify: `packages/db/src/schema/index.ts` (re-export)
- Create: `packages/db/drizzle/NNNN_reports.sql` (generated)
- Create: `apps/server/src/reports/dates.ts`
- Create: `apps/server/test/fixtures/pipeline-report.ts` (the spec's pipeline example as a `ReportDef`, reused by Tasks 4–8)
- Test: `apps/server/test/report-dates.test.ts`

**Interfaces:**
- Produces (`@confire/db`):
  - `report` table: `id uuid pk`, `tenantId text`, `userId text`, `title text default ''`, `definition jsonb $type<ReportDef | null>` (null = nothing drafted yet), `saved boolean default false`, `lastResult jsonb $type<unknown>`, `lastRunAt timestamptz`, `createdAt`, `updatedAt`; index `(tenant_id, user_id, updated_at)`.
  - `assistantThread.reportId: uuid("report_id").references(() => report.id, { onDelete: "cascade" })` + `uniqueIndex("assistant_thread_report_uq").on(t.tenantId, t.userId, t.reportId).where(sql\`report_id is not null\`)`.
  - zod: `AggZ`, `MeasureZ`, `LookupZ`, `DeriveZ`, `DatasetZ`, `KpiWidgetZ`, `ChartWidgetZ`, `TableWidgetZ`, `WidgetZ` (discriminated on `kind`), `ReportDefZ`, with types `ReportDef`, `Dataset`, `Measure`, `Widget`, `Derive`, `Lookup`, `Format` (`"money" | "number" | "percent"`), `ChartKind` — exactly the spec §3.1 shapes (Measure has `minus?`; Lookup is `{ name, field, entity, key, value }`; `filter`, `select`, `lookups`, `derive` default `[]`, `lines` default `false`, `format` default `"number"`; `widgets` 1–12; `chart` enum as the spec lists).
- Produces (`apps/server/src/reports/dates.ts`): `resolveDate(token: string, today: Date): string` and `resolveFilter(filter: FilterCond[], today: Date): FilterCond[]`. Grammar: `@(today|startOfWeek|startOfMonth|startOfQuarter|startOfYear)([+-]\d+[DWMY])?`, ISO weeks start Monday, answered as `YYYY-MM-DD` in UTC; a value that is not a token passes through untouched (also inside `in` arrays).

- [ ] **Step 1: Write the failing date tests**

```ts
const today = new Date("2026-11-03T10:00:00Z"); // a Tuesday
test.each([
  ["@today", "2026-11-03"], ["@today-12M", "2025-11-03"], ["@today+30D", "2026-12-03"],
  ["@startOfMonth", "2026-11-01"], ["@startOfQuarter", "2026-10-01"], ["@startOfYear-1Y", "2025-01-01"],
  ["@startOfWeek", "2026-11-02"], ["@today-1W", "2026-10-27"],
])("%s → %s", (tok, want) => expect(resolveDate(tok, today)).toBe(want));
test("a filter's tokens resolve; other values pass", () => {
  expect(resolveFilter([{ field: "DocDate", op: "ge", value: "@today-12M" }, { field: "CardCode", op: "eq", value: "@acme" }], today))
    .toEqual([{ field: "DocDate", op: "ge", value: "2025-11-03" }, { field: "CardCode", op: "eq", value: "@acme" }]);
});
test("the pipeline fixture parses", () => expect(ReportDefZ.parse(PIPELINE)).toBeTruthy());
```

The fixture `PIPELINE`: datasets `docs` (from Quotations label "Quotation" + Orders label "Order", filter `DocumentStatus eq bost_Open`, `DocDate ge @today-12M`, select DocNum, DocDate, DocDueDate, CardCode, CardName, DocTotal, VatSum, SalesPersonCode; lookups `salesPerson` (SalesPersonCode → SalesPersons.SalesEmployeeCode value SalesEmployeeName); derive `month` (DocDate, month), `age` (DocDate, ageDays [30, 60, 90])); widgets: kpi "Open pipeline" (sum DocTotal minus VatSum, money), kpi "Open quotations" (count, filter `_source eq Quotation`), chart "Pipeline by month" (composed, wide, dimension `month`, series `_source`, one measure sum DocTotal), chart "By sales employee" (donut, dimension `salesPerson`), chart "Top 10 customers" (bar, dimension `CardName`, top 10), chart "Pipeline age" (column, dimension `age`), table (columns month, _source, DocNum, CardName, salesPerson, DocDueDate, DocTotal; groupBy month; sortBy DocTotal desc).

- [ ] **Step 2: Run to verify they fail** — `bun test apps/server/test/report-dates.test.ts` → FAIL.
- [ ] **Step 3: Implement the schema file, the thread column and `dates.ts`.**
- [ ] **Step 4: Sync and generate the migration**

Run: `bun run db:push && bun run db:generate`
Expected: a new `packages/db/drizzle/00NN_*.sql` creating `report` and adding `assistant_thread.report_id` with its index.

- [ ] **Step 5: Run tests and type-check** — `bun test apps/server/test/report-dates.test.ts && bunx tsc -p packages/db/tsconfig.json --noEmit && bunx tsc -p apps/server/tsconfig.json --noEmit` → PASS.
- [ ] **Step 6: Commit**

```bash
git add packages/db apps/server/src/reports/dates.ts apps/server/test && git commit -m "reports: schema, ReportDef, relative date tokens"
```

---

### Task 4: Read plan and aggregation (pure)

**Files:**
- Create: `apps/server/src/reports/plan.ts`
- Create: `apps/server/src/reports/aggregate.ts`
- Create: `apps/server/src/reports/types.ts` (`ReportResult` and friends)
- Test: `apps/server/test/report-aggregate.test.ts`

**Interfaces:**
- Consumes: `ReportDef` & parts (Task 3), `resolveFilter` (Task 3), `Agg`/`AggSpec` (Task 2).
- Produces (`types.ts`): exactly
  ```ts
  export type KpiResult = { kind: "kpi"; title: string; format: Format; value: number | null; compare: number | null; deviation: number | null; target: number | null };
  export type ChartResult = { kind: "chart"; title: string; note?: string; size: "wide" | "normal"; chart: ChartKind; dimension: string;
    rows: Record<string, string | number | null>[]; measures: { key: string; label: string; format: Format; as?: "bar" | "line" | "area"; stackId?: string }[] };
  export type TableResult = { kind: "table"; title: string; columns: string[]; groupBy: string[]; rows: Record<string, unknown>[]; total: number | null; partial: boolean };
  export type WidgetResult = KpiResult | ChartResult | TableResult;
  export type DatasetStat = { rows: number; partial: { read: number; total: number | null } | null; fellBack: boolean };
  export type ReportResult = { readAt: string; company: string | null; currency: string | null; datasets: Record<string, DatasetStat>; widgets: WidgetResult[]; warnings: string[] };
  ```
- Produces (`plan.ts`):
  - `type Read = { key: string; dataset: string; source: number; filter: FilterCond[]; agg: AggSpec }` — one pushed-down call (`source` indexes `Dataset.from`; `filter` = dataset ∧ source ∧ measure filters, tokens resolved, `_source` conditions removed and decided here: a measure filtered `_source eq Quotation` reads only that source).
  - `type Use = { reads: string[]; value: string; minus?: string; count?: string; distinct?: string }` — where a measure's numbers are: its reads' keys (one per source it covers), the alias holding its sum/min/max/count, `minus`'s sum alias, the `$count` alias an avg divides by, and for `countDistinct` the grouped field to count.
  - `planReads(def: ReportDef, today: Date): { reads: Read[]; uses: (Use | undefined)[][] }` — `uses[w][i]`: widget `w`'s measure `i` (KPI: 0 value, 1 per, 2 compare; chart: its measures in order). `groupBy` = the dataset fields under the widget's dimension and series (a derive's `field`; a lookup's chain followed to its dataset field; `_source` adds none), plus a `countDistinct` field. Reads with the same (dataset, source, filter, groupBy) merge their aggregates; aliases `a0…` and `n` per read.
  - `rootField(ds: Dataset, name: string): string | null` (null for `_source`).
- Produces (`aggregate.ts`):
  - `type PartRow = Record<string, unknown>` — a pushed-down row (group fields + aliases), lookups already attached by name, `_source` set.
  - `bucketOf(value: unknown, bucket: Derive["bucket"], today: Date): { label: string; order: number } | null` — dates by their text's first 10 characters: day `2026-11-03`, ISO week `2026-W45`, month `2026-11`, quarter `2026-Q4`, year `2026`; `{ ageDays: [30, 60, 90] }` → `0–30`, `31–60`, `61–90`, `>90` (days from the date to `today`); `{ ranges: [1000, 10000] }` → `<1000`, `1000–10000`, `≥10000`. `order` sorts buckets naturally. Non-date / missing → null.
  - `withDerived(row: PartRow, ds: Dataset, today: Date): PartRow` — adds each derive's label under its name.
  - `toParts(rows: Record<string, unknown>[], agg: AggSpec): PartRow[]` — raw rows (the fallback, Confire) as one-row partials: sum/min/max/avg alias = the field's value, count alias = 1.
  - `evaluate(def: ReportDef, plan: ReturnType<typeof planReads>, data: Map<string, PartRow[]>, tables: Map<number, Omit<TableResult, "kind" | "title" | "columns" | "groupBy">>, today: Date): WidgetResult[]` — recombines per final group (sum/count add, min/max fold, avg = Σsum ÷ Σcount, `minus` subtracts its sum, `countDistinct` counts distinct `distinct` values); KPI `value` = value ÷ per when `per` is set; `deviation` = (value − compare) ÷ |compare|; chart rows keyed by `dimension` plus `m0…` per measure, or with `series` one key per series value (`s:<value>`, at most 8, the rest summed as `s:Other`); `sort: "value"` (default for bar/donut/pie) by the first measure desc, `"dimension"` (default otherwise) by bucket order / text; `top` keeps N and sums the rest as an `Other` row for sum/count measures (none for avg/min/max).
  - Every number in a result is finite or `null`.

- [ ] **Step 1: Write the failing tests** (`report-aggregate.test.ts`)

```ts
const today = new Date("2026-11-03T00:00:00Z");
test("buckets read the date's text, never a timezone", () => {
  expect(bucketOf("2026-11-01T00:00:00Z", "month", today)!.label).toBe("2026-11");
  expect(bucketOf("2026-11-01", "quarter", today)!.label).toBe("2026-Q4");
  expect(bucketOf("2025-12-29", "week", today)!.label).toBe("2026-W01");
  expect(bucketOf("2026-09-01", { ageDays: [30, 60, 90] }, today)!.label).toBe("61–90");
  expect(bucketOf(25000, { ranges: [1000, 10000] }, today)!.label).toBe("≥10000");
  expect(bucketOf(null, "month", today)).toBeNull();
});
test("plan: one read per source, grouped by the date field and the lookup's key, measures merged", () => {
  const p = planReads(PIPELINE, today);
  const byMonth = p.reads.filter((r) => r.agg.groupBy.includes("DocDate") && r.agg.groupBy.length === 1);
  expect(byMonth.map((r) => r.source).sort()).toEqual([0, 1]);
  expect(p.reads.some((r) => r.agg.groupBy.includes("SalesPersonCode"))).toBe(true);
  expect(p.reads.every((r) => r.filter.every((c) => typeof c.value !== "string" || !c.value.startsWith("@")))).toBe(true);
});
test("evaluate: months bucketed and stacked by source, net = DocTotal minus VatSum, empty is null not NaN", () => {
  const p = planReads(PIPELINE, today);
  const data = new Map(p.reads.map((r) => [r.key, fakeParts(r)])); // helper: two days in Oct and Nov 2026 per source, DocTotal 100/VatSum 21 each
  const out = evaluate(PIPELINE, p, data, new Map(), today);
  const kpi = out[0] as KpiResult;
  expect(kpi.value).toBe(4 * (100 - 21));
  const chart = out[2] as ChartResult;
  expect(chart.rows.map((r) => r.month)).toEqual(["2026-10", "2026-11"]);
  expect(chart.measures.map((m) => m.key).sort()).toEqual(["s:Order", "s:Quotation"]);
  const empty = evaluate(PIPELINE, p, new Map(p.reads.map((r) => [r.key, []])), new Map(), today);
  expect((empty[0] as KpiResult).value).toBeNull();
  expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
});
const ONE = (widgets: Widget[]): ReportDef => ReportDefZ.parse({ title: "t", assumptions: [], datasets: { d: { from: [{ source: "b1", entity: "Orders" }], select: ["CardCode", "DocTotal", "DocDate"] } }, widgets });
const run1 = (def: ReportDef, rows: Record<string, unknown>[]) => {
  const p = planReads(def, today);
  return evaluate(def, p, new Map(p.reads.map((r) => [r.key, toParts(rows.map((x) => ({ ...x, _source: "Orders" })), r.agg)])), new Map(), today);
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
```

- [ ] **Step 2: Run to verify they fail** — `bun test apps/server/test/report-aggregate.test.ts` → FAIL.
- [ ] **Step 3: Implement `types.ts`, `plan.ts`, `aggregate.ts`.** The ISO week: Thursday rule on the parsed `YYYY-MM-DD` as a UTC date.
- [ ] **Step 4: Run to verify they pass** — PASS; `bunx tsc -p apps/server/tsconfig.json --noEmit` clean.
- [ ] **Step 5: Commit** — `git add apps/server && git commit -m "reports: read plan and aggregation"`

---

### Task 5: Validation, the Confire source and the runner

**Files:**
- Create: `apps/server/src/reports/validate.ts`
- Create: `apps/server/src/reports/confire.ts`
- Create: `apps/server/src/reports/run.ts`
- Test: `apps/server/test/report-run.test.ts` (pure, fake `DirectTransport`)

**Interfaces:**
- Consumes: Tasks 1–4; `closestNames` (`entity-write.ts`), `readableBy` (`entity-profiles.ts`), `scalarFields`, `collectionOf`, `compileQuery` (`list-sql.ts`), `internalVisible` (`project-lifecycle.ts`).
- Produces:
  - `validate.ts`: `checkReport(def: ReportDef, schemas: Map<string, B1EntitySchema | null>, role: string): string[]` — every problem, one line each: an entity not in `schemas` (null = no such set: "Foo is not an SAP entity set — find it with b1_find"), not readable by `role` (`ADMIN_ONLY_READS`), a field/filter/select/lookup/derive field not in the schema (with `closestNames`), a `Lines.*` field on a dataset without `lines`, a widget's dataset or field that does not exist, a chart's dimension missing from one of its measures' datasets, two date buckets in one widget, a `series` with more than one measure, a donut/pie without exactly one measure, a bullet without `target` or `compare` (on its KPI), a scatter without two numeric measures, `minus` on an agg other than sum/avg. Confire entities are checked against `CONFIRE_FIELDS`.
  - `confire.ts`: `CONFIRE_FIELDS: Record<"Configurations", SqlFields>` (name, model, customerCode, customerName, status, channel `portal|internal`, createdAt, updatedAt, quotedAt, quotedValue, quotedCost, margin, createdBy name, assignee name) and `readConfire(tenantId: string, entity: "Configurations", filter: FilterCond[], select: string[], cap: number): Promise<{ rows: Record<string, unknown>[]; total: number }>` — tenant-filtered and `internalVisible`, at most `cap` rows.
  - `run.ts`:
    - `type Sources = { b1: B1Transport | null; company: string | null; currency: string | null; schema: (entity: string) => Promise<B1EntitySchema | null>; confire: typeof readConfire extends (t: string, ...a: infer A) => infer R ? (...a: A) => R : never }`
    - `class ReportInvalid extends Error { problems: string[] }`
    - `runWith(src: Sources, def: ReportDef, role: string, today: Date): Promise<ReportResult>` — load schemas (each b1 entity of the def once, `DocumentLines` from the header schema), `checkReport` → throw `ReportInvalid`; `planReads`; for each read: lines ? `compileLinesAggregate` + `b1.crossJoin` : `compileAggregate` + `readEntitySet`, then `followPages(…, { pageSize: 500, maxPages: 40 })`, rows through `flattenJoined` for lines, `_source` set; on a `B1Error` with status 400 from that call, the **fallback**: read raw rows (`compileList` with the read's group fields and measure fields, or the crossjoin with `expand` selects), same paging, `toParts`, and mark the dataset `fellBack`; `truncated` → `partial: { read, total }` (`total` from a `$count` asked on the first raw page only). Confire reads go through `src.confire` with cap 20,000. **Lookups**: for each lookup in order, the distinct values of its `field` across the dataset's part rows, read in batches of 50 with an `in` filter on `key` selecting `key` and `value` (`readPages`, `maxPages: 1` per batch), attached as `row[name]`. **Tables**: rows of the table's dataset (each source, `compileList` with its columns' root fields and `sortBy`, at most 2,000 in total over 4 pages of 500), lookups and `withDerived` applied, `total` from `$count`. Reads run **one after another**: `// ponytail: sequential; parallel once a live agent is shown to take concurrent requests on one SAP session`. Then `evaluate`; `readAt = today.toISOString()`; warnings name partial and fallen-back datasets in plain words.
    - `runReport(ctx: { tenantId: string; role: string }, def: ReportDef, today?: Date): Promise<ReportResult>` — wires `tenantConnector(tenantId)` (its `b1`, `companyDb`), `entitySchema` (an unknown set → null), `tenantCurrency`, `readConfire`; a tenant without SAP still runs a Confire-only report (`b1: null`; a b1 dataset then fails validation with "SAP is not connected").

- [ ] **Step 1: Write the failing tests** (`report-run.test.ts`): a fake `B1Requester` over an in-memory `Quotations`/`Orders`/`SalesPersons` store that answers `$apply` from fixtures keyed by the path's apply text, pages raw rows with `@odata.nextLink` at the `Prefer` size, and 400s `$apply` when a flag is set; `schema` from a hand-written `B1EntitySchema` map.

```ts
test("every page is read: 600 open quotations through the fallback are all counted", async () => { /* apply refused → raw rows, 2 pages → the "Open quotations" KPI = 600, datasets.docs.fellBack = true */ });
test("pushdown: the KPI is one $apply call, lookups batched by 50", async () => { /* 120 sales persons → 3 lookup calls; KPI value from the fixture */ });
test("more than 40 pages marks the dataset partial and warns", async () => { /* 20,500 raw rows → partial.read 20000, warnings non-empty */ });
test("validation: every problem in one refusal", async () => {
  const bad = { ...PIPELINE, datasets: { docs: { ...PIPELINE.datasets.docs, select: ["DocTotl"] } }, widgets: [...PIPELINE.widgets, { kind: "chart", title: "x", chart: "donut", dimension: "Nope", measures: [] }] };
  const e = await runWith(src, ReportDefZ.parse(bad), "member", today).catch((x) => x);
  expect(e).toBeInstanceOf(ReportInvalid);
  expect(e.problems.join("\n")).toContain("DocTotl (did you mean DocTotal?)");
  expect(e.problems.join("\n")).toContain("Nope");
  expect(e.problems.length).toBeGreaterThanOrEqual(3);
});
test("an admin-only set is refused for a member", async () => { /* EmployeesInfo dataset, role member → problem mentions EmployeesInfo */ });
test("the table: at most 2,000 rows, derived month attached", async () => { /* 2,500 rows → rows.length 2000, total 2500, partial true, rows[0].month like /^\d{4}-\d{2}$/ */ });
```

- [ ] **Step 2: Run to verify they fail** — `bun test apps/server/test/report-run.test.ts` → FAIL.
- [ ] **Step 3: Implement `validate.ts`, `confire.ts`, `run.ts`.**
- [ ] **Step 4: Run to verify they pass**; type-check the server project.
- [ ] **Step 5: Commit** — `git add apps/server && git commit -m "reports: validation, Confire source, runner with SAP pushdown and fallback"`

---

### Task 6: Report threads and the reports router

**Files:**
- Modify: `apps/server/src/assistant/threads.ts` (`Thread.reportId`, `cols`, general-thread filters, `ThreadRow.reportId/reportTitle`, `listThreads` join)
- Create: `apps/server/src/reports/store.ts`
- Create: `apps/server/src/orpc/routers/reports.ts`
- Modify: `apps/server/src/orpc/router.ts` (`reports: reportsRouter`)
- Test: `apps/server/test/reports.test.ts` (DB)

**Interfaces:**
- Consumes: `runReport`, `ReportInvalid` (Task 5); `withThread`, `ownThread`, `deleteThread` (threads.ts).
- Produces:
  - `Thread` gains `reportId: string | null` (in `cols`); `threadFor(…, null)`, `blankThread` and `newThread`'s general siblings add `isNull(assistantThread.reportId)`; `ThreadRow` gains `reportId: string | null; reportTitle: string | null` (left join `report`).
  - `store.ts`: `blankReport(tenantId, userId): Promise<{ id: string; threadId: string }>` (the user's report with `definition` null whose thread has no messages and no lease, touched; else a new report + its thread in one transaction); `getReport(tenantId, userId, id)` → the row + `threadId` or `ORPCError("NOT_FOUND")`; `storeRun(id: string, def: ReportDef, result: ReportResult): Promise<void>` (definition, title = def.title, lastResult, lastRunAt, updatedAt); `staleSaved(tenantId: string, userId: string, olderThan: Date)`.
  - `reportsRouter` (all `userProcedure`): `set({ definition: ReportDefZ })` — the chat's only: refused (`FORBIDDEN`, "Reports are built on a report's page") unless `context.assistantThreadId` is set (the call's context, which no request can fill — as `b1.write` reads it) and that thread has a `reportId`; validates and runs with `context.role`, `storeRun`, answers `summarize(result)` (Task 7); `ReportInvalid` → `BAD_REQUEST` "Not built — fix these and call report_set again:\n" + problems. `create()` → `{ id, threadId }` (`blankReport`); `get({ id })` → `{ id, title, saved, definition, lastResult, lastRunAt, threadId }`; `run({ id })` → `ReportResult` (runs `definition` live with the caller's role, `storeRun`; no definition = `BAD_REQUEST`; `ReportInvalid` = `BAD_REQUEST` with the problems joined); `save({ id, saved: boolean })`; `rename({ id, title })`; `delete({ id })` (through `withThread(threadId, …)` so mid-run answers `THREAD_BUSY`; cascade removes the thread); `tiles()` → `{ id, title, subtitle, value: number | null, format, currency, state: "Positive" | "Negative" | null }[]` for saved reports, newest first — `value` from the first `kpi` in `lastResult`, null when `lastResult.company` ≠ the tenant's current `companyDb`; `state` from that KPI's `deviation` sign — and fires, off the request path, a re-run of each saved report whose `lastRunAt` is older than 60 minutes (`void refresh(...).catch(Sentry.captureException)`, as the owner with the owner's current member role, skipped when the owner is no longer staff).

- [ ] **Step 1: Write the failing tests** (`reports.test.ts`, harness `makeTenant`/`makeUser`/`call`, mock agent with `Quotations#apply` fixtures)

```ts
test("create reuses the blank report; its thread is never the user's general chat", async () => {
  const a = await call(router.reports.create, {}, w.staff);
  expect((await call(router.reports.create, {}, w.staff)).id).toBe(a.id);
  const general = await blankThread(w.tenantId, w.u.userId);
  expect(general.id).not.toBe(a.threadId);
  expect((await threadFor(w.tenantId, w.u.userId, null)).id).not.toBe(a.threadId);
});
test("run stores the result; another user's report is NOT_FOUND", async () => { /* storeRun via a stored PIPELINE definition → run → lastResult.widgets.length; colleague get → NOT_FOUND */ });
test("tiles: saved only, headline from the first KPI, hidden after a company switch", async () => {
  /* save a report with lastResult.company "SBODEMO" → tile value set; set sapConnection.companyDb to "OTHER" → value null */
});
test("delete mid-run is THREAD_BUSY; after, the thread is gone", async () => { /* takeLease(threadId) → delete → THREAD_BUSY; releaseLease → delete ok → ownThread NOT_FOUND */ });
test("the chat list names a report's chat by its report", async () => { /* append a message to the report thread → listThreads row has reportId and reportTitle */ });
```

- [ ] **Step 2: Run to verify they fail** — `bun test apps/server/test/reports.test.ts` → FAIL.
- [ ] **Step 3: Implement threads changes, `store.ts`, the router; register it.**
- [ ] **Step 4: Run the new tests and the thread/assistant suites** — `bun test apps/server/test/reports.test.ts apps/server/test/assistant-threads.test.ts apps/server/test/assistant-router.test.ts` → PASS; type-check server.
- [ ] **Step 5: Commit** — `git add apps/server && git commit -m "reports: storage, report threads, reports router and home tiles"`

---

### Task 7: The assistant builds reports (`report_set`, the guide)

**Files:**
- Modify: `apps/server/src/assistant/tools.ts` (`report_set` in `allTools`)
- Modify: `apps/server/src/assistant/pages.ts` (`CHAT_TOOLS` + `"report_set"`; `REPORT` page; `REPORT_GUIDE`; `PAGES["/$slug/reports/$id"]`)
- Modify: `apps/server/src/assistant/route.ts` (a report thread: page `REPORT`, second system prompt `REPORT_GUIDE`)
- Modify: `apps/server/src/assistant/auto.ts` (`readsClientContent`: `report_set` with a `confire` source taints)
- Modify: `apps/server/src/reports/aggregate.ts` (`summarize`)
- Modify: `apps/server/src/orpc/routers/reports.ts` (`set` answers `summarize(result)`)
- Test: `apps/server/test/assistant-route.test.ts`, `apps/server/test/assistant-tools.test.ts`

**Interfaces:**
- Consumes: `runReport`, `storeRun`, `ReportInvalid` (Tasks 5–6); `Thread.reportId`.
- Produces:
  - Tool `report_set` = `procedureTool("reports.set", reportsRouter.set, ctx, { name: "report_set", describe: … })` — the procedure (Task 6) does the work; the chat's call context carries `assistantThreadId` (`contextOf`). Add it to `procedureOf`'s map.
  - `summarize(r: ReportResult): { widgets: unknown[]; datasets: Record<string, DatasetStat>; warnings: string[] }` (exported from `reports/aggregate.ts`): KPI → `{ title, value, compare }`; chart → `{ title, categories: number, top: first 5 rows }`; table → `{ title, total }`. Never the table's rows.
  - `REPORT_GUIDE` (stable text, spec §5.2, every bullet there), including the `ReportDef` field reference with the date tokens and one compact example (the pipeline fixture's shape, abbreviated). `REPORT` page note: "The user is on this report's page, the report on screen beside this chat. Change it with report_set. No SAP writes and no configurations from here."
  - `route.ts`: `thread.reportId` → `page = REPORT`, `block = REPORT_GUIDE`.

- [ ] **Step 1: Write the failing tests**

```ts
// assistant-route.test.ts
test("a report's chat gets the report guide as its second system block and report_set in its tools", async () => {
  const w = await world();
  const r = await call(router.reports.create, {}, { context: { headers: tenantHeaders(w.slug, w.u.cookie) } });
  let system = ""; let tools: string[] = [];
  w.fake.setResponses([({ request }) => { system = JSON.stringify(request.systemPrompts); tools = (request.tools ?? []).map((x) => x.name); return { text: "ok" }; }]);
  await (await w.post({ threadId: r.threadId, text: "sales pipeline by month", route: { routeId: "/$slug/reports/$id", params: { id: r.id } } })).text();
  expect(system).toContain("over-deliver");
  expect(tools).toContain("report_set");
});
test("report_set stores the report and answers a summary without rows", async () => {
  /* mock agent fixtures for PIPELINE; fake: toolCalls report_set { definition: PIPELINE } then text "done";
     the stored tool result has widgets and no "rows" key; reports.get → definition.title === PIPELINE.title, lastResult set */
});
test("report_set on a general chat is refused", async () => { /* general thread → tool result contains "report's page" */ });
// assistant-tools.test.ts
test("a report over Confire configurations taints the run", async () => {
  expect(await readsClientContent(t, "report_set", { definition: { ...PIPELINE, datasets: { c: { from: [{ source: "confire", entity: "Configurations" }] } } } })).toBe(true);
  expect(await readsClientContent(t, "report_set", { definition: PIPELINE })).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail** — `bun test apps/server/test/assistant-route.test.ts apps/server/test/assistant-tools.test.ts` → FAIL.
- [ ] **Step 3: Implement the tool, the guide, the page and the route branch.**
- [ ] **Step 4: Run the whole server suite** — `bun test apps/server/test` → PASS (existing tests asserting the tool list or prefix still pass; `MCP_TOOL_NAMES` is unchanged — `report_set` is not an MCP tool). Type-check server.
- [ ] **Step 5: Commit** — `git add apps/server && git commit -m "assistant: report_set and the report guide"`

---

### Task 8: The report view (UI5 widgets)

**Files:**
- Create: `apps/app/src/reports/widgets.ts` (pure mapping)
- Create: `apps/app/src/reports/ReportView.tsx`
- Create: `apps/app/src/i18n/parts/report.en.properties`, `report.es.properties`, `report.eu.properties`
- Test: `apps/app/src/reports/widgets.test.ts`

**Interfaces:**
- Consumes: `ReportResult` via the router's output type (the app has no `@confire/db` dependency): `type Report = Awaited<ReturnType<typeof client.reports.get>>`, `type Result = NonNullable<Report["lastResult"]>`, `type ChartResult = Extract<Result["widgets"][number], { kind: "chart" }>`, `ChartKind = ChartResult["chart"]`, `Format = ChartResult["measures"][number]["format"]` (declare `lastResult` in the router's output as `ReportResult | null`).
- Produces:
  - `widgets.ts`: `chartComponent(kind: ChartKind): "ColumnChart" | "BarChart" | "LineChart" | "ComposedChart" | "ColumnChartWithTrend" | "DonutChart" | "PieChart" | "RadialChart" | "BulletChart" | "ScatterChart" | "RadarChart"`; `chartProps(r: ChartResult, fmt: (v: number, f: Format) => string): { dataset; dimensions: [{ accessor: r.dimension }]; measures: { accessor; label; formatter; type?; stackId? }[] }` (composed: `type` = `as ?? "bar"`; a series chart stacks every measure on one `stackId`); `filterRows(rows: Record<string, unknown>[], dimension: string, value: unknown): Record<string, unknown>[]`; `formatValue(v: number | null, f: Format, currency: string | null, locale: string): string` (null → "—"; money compact with the currency; percent ×100 with "%").
  - `ReportView({ report, result, busy, onChip, onRefresh, onSave }: { report: Report; result: Result | null; busy: boolean; onChip: (label: string) => void; onRefresh: () => void; onSave: (saved: boolean) => void })` — the spec §6.2 layout: header (title, subtitle, "live from SAP · read HH:MM (N rows…)", `PageMessages` with partial/fallback/warnings as Warning messages and a failed run as Negative, *Refresh*, *Save to home* / *Saved*), assumption `Token`s (click → `onChip(label)`), KPI row (`Card` + `AnalyticalCardHeader` with `NumericSideIndicator`s for compare/deviation/target), charts in a CSS grid (`gridTemplateColumns: repeat(auto-fill, minmax(22rem, 1fr))`, `size: "wide"` spans 2), each chart `noAnimation`, `chartConfig={{ resizeDebounce: 0 }}`, `onDataPointClick` → table filter (a `Tag` shows it, click clears), the table as `AnalyticalTable` (`groupBy` → its `groupBy` state, sums in grouped rows for money/number columns), a B1 document row opening `/b1/<entity>/<key>` through `useEntityNav`; loading = skeletons in the layout.
  - i18n keys (English base; es/eu translated): `REPORT_NEW`, `REPORT_ASK`, `REPORT_WELCOME`, `REPORT_PROMPT_PIPELINE`, `REPORT_PROMPT_STOCK`, `REPORT_PROMPT_OVERDUE`, `REPORT_PROMPT_TOP_ITEMS`, `REPORT_LIVE`, `REPORT_REFRESH`, `REPORT_SAVE`, `REPORT_SAVED`, `REPORT_RENAME`, `REPORT_DELETE`, `REPORT_DELETE_CONFIRM`, `REPORT_PARTIAL`, `REPORT_FELL_BACK`, `REPORT_FAILED`, `REPORT_FILTER`, `REPORT_OTHER`, `REPORT_EMPTY`, `REPORT_CHANGE_CHIP`, `HOME_REPORTS`, `HOME_NEW_REPORT`.

- [ ] **Step 1: Write the failing tests** (`widgets.test.ts`, run with `bun test apps/app/src/reports`)

```ts
test("composed: bars and a line, one dimension", () => {
  const p = chartProps({ kind: "chart", title: "t", size: "wide", chart: "composed", dimension: "month",
    rows: [{ month: "2026-11", m0: 5, m1: 2 }], measures: [{ key: "m0", label: "Value", format: "money" }, { key: "m1", label: "Count", format: "number", as: "line" }] }, (v) => String(v));
  expect(p.dimensions).toEqual([{ accessor: "month" }]);
  expect(p.measures.map((m) => [m.accessor, m.type])).toEqual([["m0", "bar"], ["m1", "line"]]);
});
test("a series chart stacks every measure", () => { /* measures s:Order, s:Quotation → same stackId */ });
test("filterRows keeps the clicked category", () => expect(filterRows([{ month: "2026-10" }, { month: "2026-11" }], "month", "2026-11")).toEqual([{ month: "2026-11" }]));
test("formatValue: null is a dash, money compact with its currency, percent", () => {
  expect(formatValue(null, "money", "EUR", "en")).toBe("—");
  expect(formatValue(2840000, "money", "EUR", "en")).toBe("€2.8M");
  expect(formatValue(0.31, "percent", null, "en")).toBe("31%");
});
```

- [ ] **Step 2: Run to verify they fail** — FAIL.
- [ ] **Step 3: Implement `widgets.ts`, `ReportView.tsx`, the bundles.** Check every chart prop name against the UI5 MCP (`get_component_api`) — the API is 2.27's, which pretrained knowledge may not match.
- [ ] **Step 4: Run tests and type-check** — `bun test apps/app/src/reports && bunx tsc -p apps/app/tsconfig.json --noEmit` → PASS.
- [ ] **Step 5: Commit** — `git add apps/app && git commit -m "reports: the report view in UI5"`

---

### Task 9: The report page, its chat, and the home tiles

**Files:**
- Create: `apps/app/src/reports/ReportPage.tsx`
- Create: `apps/app/src/routes/$slug/reports/new.tsx`, `apps/app/src/routes/$slug/reports/$id.tsx`
- Modify: `apps/app/src/assistant/ChatView.tsx` (`Kind` gains `"report"`; new optional props `onTool`, `prefill`)
- Modify: `apps/app/src/components/GlobalSearch.tsx` (`chatHit`: a row with `reportId` goes to `/reports/<reportId>`, its text the report's title)
- Modify: `apps/app/src/routes/$slug/index.tsx` (the Reports group)

**Interfaces:**
- Consumes: `reports.create/get/run/save/rename/delete/tiles` (Task 6), `ReportView` (Task 8), `ChatView`, `useRoute`.
- Produces:
  - `ChatView` props: `kind: Kind` (now incl. `"report"`), `onTool?: (name: string) => void` — called once per tool call id when its result first appears in `chat.messages`; `prefill?: { text: string; at: number }` — when `at` changes, the box takes `text` and focus. With `kind === "report"` the hero shows `REPORT_NEW` as overline, `REPORT_ASK` as header, `REPORT_WELCOME`, and the four `REPORT_PROMPT_*` as starters.
  - `ReportPage({ id }: { id: string })`: `reports.get`; three states — `docked = !!report.definition` decides the layout; the first time a `report_set` result arrives (`onTool("report_set")`) while not docked: `document.startViewTransition(() => flushSync(() => setDocked(true)))` (no transition with `prefers-reduced-motion` or without the API), then refetch `reports.get`. Layout: undocked = the chat alone, centred (`maxWidth` as the AI page's); docked = a row: `ReportView` (flex 1, scrolls) and the chat column (`width: 360px`, `viewTransitionName: "cf-report-chat"`, same element in both states). On open of a report with a definition: show `lastResult`, then `reports.run` once, live. *Save* → `reports.save`, invalidate `reports.tiles`. Bar menu: rename, delete (confirm, then `/$slug`).
  - `/reports/new`: `reports.create` → `navigate({ to: "/$slug/reports/$id", params: { id }, replace: true })` (as `AssistantPage` does for a new chat). `/reports/$id`: `<ReportPage id={id} />`.
  - Home: a "Reports" group (`HOME_REPORTS`) after the Configurator group: a `HOME_NEW_REPORT` tile (`icon: "add-document"`, `to: "/reports/new"`), then `reports.tiles` as `Tile`s (title, subtitle, `value` formatted with `formatValue` compact, `state` → the tile's `Critical`/`Negative` class only for `Negative`).

- [ ] **Step 1: Implement ChatView's three additions**, keeping every existing call site unchanged (new props optional; existing kinds untouched).
- [ ] **Step 2: Implement `ReportPage`, the two routes, GlobalSearch's hit, the home group.**
- [ ] **Step 3: Build and type-check** — `bun --cwd apps/app build && bunx tsc -p apps/app/tsconfig.json --noEmit` → no errors (the build regenerates `routeTree.gen.ts`).
- [ ] **Step 4: See it work in the real app.** `bun run dev` (Postgres up), sign in as a test-tenant user. With a paired agent and `ANTHROPIC_API_KEY`: Home → *New report* → "sales pipeline by month", and watch the chat dock right and the report fill in. Without them: the headless probe (`playwright-core` + cached Chromium, as in memory) with `page.route` answering `/rpc/reports/get` and `/rpc/reports/run` with the pipeline fixture's definition and a result built from Task 4's fake parts. Either way confirm: the docked layout at 360 px, five KPI cards, four charts, the grouped table, a bar click filtering the table, *Save to home* adding the home tile. Screenshot it and send it to the user.
- [ ] **Step 5: Commit** — `git add apps/app && git commit -m "reports: the report page, its docked chat, home tiles"`

---

### Task 10: Docs, and the live-B1 check

**Files:**
- Modify: `CLAUDE.md` (a "Reports" paragraph under *The assistant*: `report_set`, `ReportDef`, pushdown + fallback, tiles; `b1_read`'s `aggregate` in the SAP tools bullet)
- Modify: `docs/superpowers/specs/2026-11-03-assistant-reports-design.md` (record what the live check found, in §3.3)

- [ ] **Step 1: Write the CLAUDE.md paragraph** — five to eight lines in the file's voice, naming `apps/server/src/reports/` (`plan.ts`, `aggregate.ts`, `run.ts`, `validate.ts`), `report_set`, the pushdown and its fallback, `report.saved`/tiles, and that `report_set` is not an MCP tool.
- [ ] **Step 2: Ask the user to run the live check** on their paired B1 (`bun run dev:pair` box): open a report asking for "open quotations by customer" and one for "sales by item last year". Look at the page's messages: no "fell back" warning on the first proves `$apply` on an entity set; none on the second proves it over a crossjoin. Record the outcome — and any verified B1 error text, verbatim — in the spec and as the `unverified (reports spec §3.3)` comments' replacement.
- [ ] **Step 3: Full gates** — `bun test` (root) and every type-check listed in Global Constraints → PASS.
- [ ] **Step 4: Commit** — `git add CLAUDE.md docs && git commit -m "docs: reports"`
