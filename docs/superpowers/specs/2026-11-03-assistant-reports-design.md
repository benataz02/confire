# Reports the assistant builds — design

Date: 2026-11-03 · Branch: `saved-reports` · Mockups: `.superpowers/brainstorm/*/content/report-first-draft.html`,
`report-flow.html` (local, gitignored; the user approved both).

## 1. Intent

A salesperson or manager types a generic request — "sales pipeline by month" — on a **New report**
page. The assistant interprets it and builds a first report that over-delivers: a row of KPIs, a main
chart, two or three breakdowns and the documents behind the figures, with its reading of the request
shown as chips. The user then refines it in the same chat ("only Spanish customers", "split by item
group"), and once it is right saves it: it becomes a tile on the home page, showing its headline
figure, and opening it shows the report live.

Data: SAP Business One (items, sales documents, business partners and whatever they relate to — any
entity set the user may read) and Confire's own configurations.

The user's words that set the bar: *"complete, creative and overdeliver in a first instance"*; *"if
you achieve what I can see in the mockup that would be amazing"*.

## 2. Goals, non-goals, anti-goals

**Goals**
- One line in, an impressive report out, built from the tools the assistant already has to explore
  SAP (`b1_find`, `b1_schema`, `b1_read` — which gains SAP-side totals, §3.4) and Confire (`configs_rows`, `requests_rows`).
- Every row the report needs is read: the server follows the Service Layer's `nextLink` page after
  page (600 open quotations = the first 500, then the next 100 from the link B1 returns).
- Refinement by chat, the report changing in place beside it.
- Save → a tile in a new **Reports** group on the home page; open → the report, live, with its chat.

**Non-goals (v1)**
- A manual report editor (drag fields, pick chart types by hand). The chat is the editor; the chips
  only pre-fill the chat box.
- Sharing a report with the workspace, exporting (Excel/PDF), scheduled mail, dashboards of reports.
- Starting a report from the floating panel or any page other than New report (the user chose the
  new page only).
- Reports in the portal, report tools over MCP.

**Anti-goals — a failure even if it works**
- **A figure the model computed.** The model writes what to compute; the server computes every number
  (the codebase's rule: a card renders the tool's output, so its figures are the server's).
- **A report that silently shows part of the data.** A read that stops at a cap says so on the page.
- **A home page that waits on SAP.** The home never calls the agent today ("a count would be a call to
  the agent, which the home never makes"); tiles show the last run's figure.
- **A report that reads what the user could not read on the B1 pages** (`ADMIN_ONLY_READS`,
  `assertReadable`).

## 3. The shape: a report is a definition, run by the server

The assistant never sends figures. It writes a **report definition** — data, filters, grouping,
measures, widgets — as one JSON document (`ReportDef`, zod, `packages/db` beside `ListQueryZ`), and
the server runs it: reads every page, joins the lookups, aggregates, and answers a **result** the page
draws. Saved, the definition is stored whole (like `config_model.definition`); every open runs it
again ("nothing is snapshotted"), so "last 12 months" is always the last 12 months.

This is "live queries are data, not paths" again: the definition names entity sets, fields and
`FilterCond`s; `query.ts` and `compileList` still build every URL, and `list-sql.ts` every SQL.

### 3.1 `ReportDef`

The builder settles the exact zod; this is its content.

```ts
ReportDef = {
  title: string; subtitle?: string;
  /** the chips: how the assistant read the request, in the user's language */
  assumptions: { label: string; value: string }[];          // "Data" → "open Quotations + open Orders"
  datasets: Record<DatasetId, Dataset>;
  widgets: Widget[];                                         // in page order
}

Dataset = {
  /** a union of sources with the same fields (documents share their schema); each row gets
   *  `_source` = the source's label, so a chart can stack quotations against orders */
  from: { source: "b1" | "confire"; entity: string; label?: string; filter?: FilterCond[] }[];
  /** document lines: the document $crossjoin'ed with its DocumentLines (doc-chain.ts' pattern);
   *  line fields are `Lines.ItemCode`, `Lines.LineTotal`… */
  lines?: boolean;
  filter?: FilterCond[];                                     // ANDed onto every source
  /** related entities, one named value each: `{ name: "country", field: "CardCode",
   *  entity: "BusinessPartners", key: "CardCode", value: "Country" }`; `field` may name an earlier
   *  lookup (`itemGroup` → ItemGroups' GroupName) */
  lookups?: { name: string; field: string; entity: string; key: string; value: string }[];
  /** derived fields: date buckets and value buckets, named so widgets can group by them */
  derive?: { name: string; field: string; bucket: "day" | "week" | "month" | "quarter" | "year"
             | { ranges: number[] } | { ageDays: number[] } }[];
}

Measure = { dataset: DatasetId; agg: "sum" | "count" | "countDistinct" | "avg" | "min" | "max";
            field?: string; minus?: string /* sum/avg only: net = DocTotal minus VatSum */;
            filter?: FilterCond[]; label: string; format?: "money" | "number" | "percent" }

Widget =
  | { kind: "kpi"; title: string; value: Measure; per?: Measure /* ratio: value ÷ per */;
      compare?: Measure /* trend arrow and deviation */; target?: number }
  | { kind: "chart"; title: string; note?: string; size?: "wide" | "normal";
      chart: "column" | "bar" | "line" | "composed" | "columnTrend" | "donut" | "pie" | "radial"
           | "bullet" | "scatter" | "radar";
      dimension: string;                 // a field or derived field every measure's dataset has;
                                         // measures from different datasets meet on its value
      measures: (Measure & { as?: "bar" | "line" | "area"; stackId?: string })[];
      series?: string;                   // pivot: one measure per value of this field (stacked)
      sort?: "dimension" | "value"; top?: number /* the rest → "Other" */ }
  | { kind: "table"; title: string; dataset: DatasetId; columns: string[];
      groupBy?: string[]; sortBy?: { field: string; dir: "asc" | "desc" }[] }
```

Relative dates ride in `FilterCond.value` as a token the server resolves at run time
(`"@today"`, `"@today-12M"`, `"@startOfMonth"`, `"@startOfYear-1Y"`…): `FilterScalarZ` is a string
already, so the wire query does not change. The builder picks the token grammar; it must be
documented in the tool's description and tested.

### 3.2 Validation — one refusal naming every problem

Before anything is read, the server checks the whole definition and refuses with one message listing
every problem (as `config-patch.ts` does), so the model corrects itself in one turn:
- each B1 entity is readable by the caller (`assertReadable`), each field and filter field is in its
  schema — the strict-name check `b1.read` already has (`checkQueryNames`), which answers the closest
  real names; Confire fields are the Confire source's (§3.5);
- a widget's dimension and series hold at most one date bucket between them;
- every widget names a dataset that exists and fields the dataset has (its sources', `Lines.*`, looked
  up, derived, or `_source`);
- a chart's measures from different datasets each have its dimension;
- chart kinds get what they need (a donut one measure, a bullet a target or a compare, a scatter two
  numeric measures).

### 3.3 Running it (`apps/server/src/reports/`)

Volumes (the user's): up to ~10k documents a year per type, easily more — 50k+ lines a year. Reading
every row of a two-year line report is 200+ agent round trips, so **SAP does the totals** and rows
are read only where rows are shown.

- **Totals in SAP (`$apply`).** Every KPI and chart measure is asked of the Service Layer as
  `$apply=groupby((…),aggregate(… with sum as …))` (§3.4): a KPI is one call, a breakdown by customer
  one small grouped answer. The Service Layer has no `month()` in `$apply`, so a **time dimension is
  grouped by its date field itself** — one row per day and group, a few hundred a year — and bucketed
  into weeks, months or ages on Confire's side (by the date's text, never through a timezone). One
  call per (dataset, filter), however many buckets. Measures recombine (sum, count, min, max; avg =
  pushed sum ÷ pushed count); a `countDistinct` field joins the grouping and is counted distinct
  after.
- **Every page, still.** Grouped answers page like rows: the runner follows B1's sealed
  `@odata.nextLink` (`readRows`' cursor, `readNext`) until there is none, page size 500.
- **Live check (2026-11-03, done on a paired b1s/v2):** `$apply` on an entity set works, encoded
  like `$filter` — filter, groupby, sum, `$count`. Two refusals, both 400 code 201 "Not supported
  query option": a bare date inside `filter()` (`DocDueDate lt 2026-11-03`; `$filter` takes it, so
  dates are now quoted everywhere, same counts), and any line field in `$apply` over the lines
  crossjoin (below). `$apply` over a crossjoin of two top-level sets works.
- **Rows only for the table**, at most the 2,000 it shows, in the table's sort; `partial: { read,
  total }` (`$count`) when there are more. A table is the one place the first page's count matters.
- **Lines.** A lines dataset is `$crossjoin(<Set>,<Set>/DocumentLines)` with the DocEntry equality
  as the join (doc-chain.ts' spec shape), and it is **always read as rows**: B1's `$apply` over that
  crossjoin names no line field — `aggregate(<Set>/DocumentLines(LineTotal with sum as s))`, the
  `<Set>/DocumentLines/LineTotal` path form, `groupby((<Set>/DocumentLines/ItemCode))` ("invalid
  property '<Set>' of entity type 'Document'") and `$count` all 201; only its `filter()` reaches the
  lines. Rows are read and totalled here, as when B1 refuses `$apply` on a set: capped at **20,000
  rows** per dataset with `partial` on the page, and the result says which datasets did.
  `// ponytail:` the slow path; SQLQueries or a Semantic Layer view would let SAP total lines.
- **Lookups.** A measure grouped by a related entity's field (item group, customer country) is
  pushed down grouped by the key (`ItemCode`, `CardCode`); the runner then reads the distinct keys'
  attributes and re-aggregates by them. The distinct values of the joined field are read from the related entity in batches of
  `in` filters (`compileList` turns `in` into an OR group; batch small enough for the URL, ~50
  keys), selecting the key and the asked fields. A small set (a lookup that would need more batches
  than the set has pages) may be read whole instead. Builder's call.
- **Confire.** `source: "confire"` reads Postgres through `list-sql.ts`, tenant-filtered and
  `internalVisible` (an internal read never sees a client's draft), up to the same cap.
- **Aggregation is pure** (`reports/aggregate.ts`, tested): derive buckets, group by the dimension
  (and `series`), apply each measure's own filter, aggregate, sort, top-N with "Other", ratios for
  `per`, deviation for `compare`. B1 money fields are local currency (`DocTotal`); the result carries
  the company's local currency (`adoptCompany`'s) for the formatter.
- **Result** (plain JSON, `ReportResult`): per widget its computed data (a KPI's value, compare,
  deviation; a chart's dataset rows ready for `dataset`/`dimensions`/`measures`), the table rows (at
  most **2,000** to the browser, with the derived fields attached so a chart click can filter them;
  `// ponytail:` page them if anyone needs more), `readAt`, the B1 company read, per-dataset row
  counts and `partial`, and warnings.
- **Company.** A result remembers the SAP company it read (`Connector.companyDb`); a cached result
  from another company is not shown on a tile (the agent switched companies since).

### 3.4 `b1_read` gets totals too

The pushdown is one compiler, `compileAggregate` (`entity-list.ts`, next to `compileList`; the
`$apply` text built in `query.ts`, which stays the only module that builds a Service Layer URL), and
`b1.read` takes it as an optional `aggregate: { groupBy: string[]; measures: { field?: string; agg:
"sum" | "count" | "countDistinct" | "avg" | "min" | "max"; as: string }[] }` beside `query` (whose
filter applies first). Not new fields on `ListQueryZ`: that is also the lists' and saved views' wire
query. Strict names as for `query` (`checkQueryNames`), before anything is compiled. The answer is
the grouped rows, paged like any read.

Why on `b1_read` and not only in the runner: the chat asked "how much did we invoice ACME this year"
today reads up to 500 rows and adds them up itself — a figure the model computed. With `aggregate`
SAP answers it, in the chat and over MCP (`b1.read` is the procedure). And the model can try a
grouping with `b1_read` before it writes the same one into a definition, so its exploration and the
report agree. No agent change: the allowlist forwards any GET (`allow.go`).

### 3.5 The Confire source

One entity, `Configurations` (`config_project` ⋈ model, customer), with reporting fields: name,
model, customer code/name, status, channel (`portal` when `portalCardCode` is set, else `internal`;
nothing records whether the assistant started one), created/updated/quoted dates, `quotedValue`, `quotedCost`, margin, creator, assignee.
A `SqlFields` map like `configs.ts`' `configFields`, but its own (the list's map is the list's).
Client requests are configurations with channel `portal`.

## 4. Storage

- `report` table (new schema file, re-exported from `schema/index.ts`, migration generated):
  `id`, `tenant_id`, `user_id` (owner), `title`, `definition` jsonb (`ReportDef`), `saved` boolean
  (false = a draft, not on the home page), `last_result` jsonb, `last_run_at`, `created_at`,
  `updated_at`. Personal: every read and write filters on (tenant, user).
- `assistant_thread.report_id` (nullable FK, cascade), one thread per report, a partial unique index
  like `assistant_thread_project_uq`. The thread list (`listThreads`) shows report chats too, named by
  the report.
- Deleting a report deletes its chat (cascade). Unsaved drafts the user walked away from:
  `// ponytail:` left in place; a cleanup of drafts older than N days if they ever pile up.

## 5. The assistant

### 5.1 One new tool: `report_set`

`report_set({ definition })` — validate (§3.2), run (§3.3), store the definition and its result on
the thread's report (`thread.reportId`; `reports.create` made both before the first send, so a thread
without a report refuses the tool: "only on a report's page"), and answer the model a **compact summary**, not the rows: per widget a few figures (a KPI's value, a
chart's category count and top categories, a table's row count), each dataset's `partial` and `fellBack`, warnings — not the rows SAP returned, which add up every grouped read and read as a document count. That is enough for the model to
describe the draft and sanity-check it ("0 rows — the status filter is wrong") without its context
filling with data. Whole definition per call (`// ponytail:` a patch once definitions grow large).

It joins `CHAT_TOOLS` (one sorted set on every page, so the prompt prefix stays stable; existing
threads' replayed thinking is handled by the prefix hash already). The tool's name picks the page's
behaviour: the report page refetches the report when a `report_set` call finishes.

The model explores before it writes: `b1_find` for a set's name, `b1_schema` for fields and enum
member names (`bost_Open`), a 5-row `b1_read` sample to check real values. Nothing new there.

### 5.2 The report guide — the thread's second system block

A report's thread gets `REPORT_GUIDE` as its second system prompt, in the place a configuration's
thread gets its model block (`route.ts`, the two cache markers), and a report page note
(`pages.ts`, `/$slug/reports/$id`). The guide is stable text, so it caches. It says:
- **Interpret, then over-deliver.** Read a generic request the way an SME manufacturer's sales or
  operations manager means it. Build, in one go: 4–5 KPIs (one of them a comparison or rate), a main
  chart over time, 2–3 breakdowns (by customer, item / item group, sales employee, country), and the
  table of documents behind the figures. State every reading as an assumption chip.
- **Pick the chart by the data's shape**: time → column / line / composed (value as bars, count as
  line); share of a whole with ≤ 6 parts → donut; ranking → bar, top 10 + Other; actual vs target or
  last year → bullet or a KPI's compare; ages or ranges → column over buckets; two measures per
  item → scatter.
- **Header or lines**: a header dataset measures documents (`DocTotal`, counts); a lines dataset
  measures lines (`Lines.LineTotal`, quantities) — never a header total summed over lines, which
  counts it once per line.
- **B1 conventions**: net value = `DocTotal` minus `VatSum` (a `minus` derive), lines' `LineTotal` is
  net already; open = `DocumentStatus eq bost_Open`; quotation validity = `DocDueDate`;
  pipeline = open quotations + open orders; conversion = quotations with an order copied from them
  (order lines' `BaseType 23`); overdue = open invoices past `DocDueDate`; names over codes through
  lookups (`SalesPersons`, `ItemGroups`, `BusinessPartnerGroups`).
- **Ask only what changes the report** — when a request has two genuinely different readings, one
  `ask_user` before building; otherwise build and let the chips carry the assumptions.
- **Refining** changes the definition and calls `report_set` again; the answer says in one line what
  changed. Never quote figures the summary does not have.

### 5.3 What a report chat may not do

Report threads keep the whole tool set (one set on every page), but the page note says the chat is
for this report: no SAP writes and no configurations from here. The builders and auto mode's rules
still hold whatever a model does; this is a hint, as every page note is.

## 6. The pages (staff app)

### 6.1 Routes and home

- `/$slug/reports/new` and `/$slug/reports/$id` (staff, `userProcedure`); under the slug, so
  nothing joins `tenant.ts`' reserved names. A report's chat found in the shell's chat search opens
  its report page, not `/assistant/$id`.
- **Home**: a new group **Reports** after the Configurator group: a *New report* tile (icon
  `add-document` or similar), then every saved report as a tile — title, subtitle, the first KPI's
  value as the tile's number (state from its compare when it has one). From `last_result`; nothing on
  the home calls SAP.
- **Refreshing a tile**: the home's read fires a background re-run of each saved report whose result
  is older than **60 minutes**, off the request path and never throwing — `ensureFresh`'s pattern
  (`masterdata-sync.ts`) — so the next visit shows fresh figures. It runs as the report's owner, with
  the owner's current role (a user no longer on staff refreshes nothing). Opening a report always runs
  it live.

### 6.2 The report page — three states (the approved storyboard)

Superseded by `2026-11-06-joule-assistant-design.md`.

1. **Ask** (`/reports/new`): `ChatView` in page mode with its HeroBanner — "New report", "What do you
   want to see?", the chat box, and 3–4 starter suggestions (pipeline by month, stock below minimum,
   overdue invoices, top items this year) that fill the box.
2. **Build**: after the first send the chat is centred while the assistant works; its steps fold
   shows what it reads. The URL becomes `/reports/$id` once the report exists (replace, no reload).
3. **Refine**: when the first `report_set` result arrives, the chat column **slides to the right and
   narrows** (~360 px) and the report grows in on the left — one `document.startViewTransition`
   with a `viewTransitionName` on the chat column, as `ChatView` already does for its box
   (reduced motion: no animation). The chat column is one element through all three states, so a
   stream in progress is never interrupted. A report that already has a definition opens to be **read**,
   its chat closed: *Edit* docks the chat (Fiori's display → edit, the same slide) and *Done* hides it
   again, kept mounted so a running answer goes on. A chat search hit (`/reports/$id#chat`) and a click
   on an assumption chip open it docked.

The report side (`ReportView`, `apps/app/src/reports/`), all UI5, every colour a theme variable:
- **Header**: title, subtitle, "live from SAP · read 11:42 (612 quotations, 148 orders)", the
  `PageMessages` button (partial reads, warnings, a failed run), *Refresh*, *Save to home* (then
  *Saved*, a toggle), *Edit*/*Done*, rename and delete in the toolbar's overflow.
- **Assumption chips** (`Token`s or `Tag`s): clicking one puts "Change <label>: " in the chat box.
- **KPI row**: `Card` + `AnalyticalCardHeader` with `NumericSideIndicator`s (compare, deviation,
  target), as the assistant's cards already do.
- **Charts**: `Card`s in a responsive CSS grid, `size: "wide"` spanning two columns; each widget kind
  maps to its `@ui5/webcomponents-react-charts` component with `dataset`/`dimensions`/`measures`,
  default `sapChart` ordinal colours, numbers through the app's locale formatter (money with the
  result's currency, compact on axes). Known quirks from `PriceAnalysis.tsx`: `noAnimation` +
  `resizeDebounce: 0`, min-height 0 while loading.
- **Click to filter**: `onDataPointClick` on a chart filters the table by that dimension value (a
  `Tag` shows the filter and clears it). In the browser, over rows the result already has.
- **Detail table**: `AnalyticalTable`, grouped by the widget's `groupBy` with sums, sortable; a row of
  a B1 document opens its object page (`/b1/<entity>/<key>` through `useEntityNav`).
- **States**: loading = skeletons in the draft's layout; a run that fails = the last result with a
  Negative message, or the message alone.

UI texts through `useI18n()` keys in the app's message bundles (English base; the languages the app
already ships).

## 7. API (`orpc/routers/reports.ts`, `userProcedure`)

`reports.create` (on the first send: the report row, unsaved, and its thread), `get` (definition, last
result, saved, thread id), `run` (run live, store `last_result`), `save` / `rename` / `delete`,
`tiles` (the home's: saved reports with their headline, fires the stale refresh). `report_set` is the
assistant's tool, not a page procedure: only the chat writes a definition.

## 8. Tests (the gates)

- `aggregate.ts`: buckets (month across a year boundary, week, ageDays), series pivot, top-N +
  Other, a measure's own filter, `per` and `compare`, empty input.
- Relative date tokens: resolution against a fixed "today".
- Validation: unknown entity / field with closest names, admin-only entity for a non-admin, widget
  naming a missing dataset/field — all in one refusal.
- The runner over a fake transport: 600 rows on two pages are all counted; the cap marks `partial`;
  lookups batch.
- `compileAggregate`: groupby + each agg, a filter before `$apply`, a crossjoin's prefixed names,
  unknown names refused with the closest ones, an injected quote escaped.
- The runner's time split: 12 monthly calls with the right ranges, avg from sum ÷ count, the
  fallback on a refused `$apply`.
- `report_set` through the chat's test adapter (`useTestAdapter`): stores the report, links the
  thread, answers a summary with no rows.
- Type-check per project (`apps/server`, `apps/app`, `packages/db`), `bun --cwd apps/app build`.

## 9. Left to the builder

The exact zod of `ReportDef` and `ReportResult`; the date-token grammar; the lookup batch size; the
grid's breakpoints; the tile's icon; how the summary is trimmed; file split inside `reports/`. The
guide's wording — then run a handful of generic requests through it on a real tenant (pipeline by
month, overdue invoices, stock below minimum, top items, sales by country) and tune it until the
first drafts look like the mockup.

## 10. Calls made in the design (not the user's)

- The server computes every figure from a definition the model writes (the codebase's rule).
- SAP does the totals (`$apply`), a time dimension grouped by day and bucketed on our side; rows
  only for the table (2,000); reading rows with a 20,000 cap is the fallback where `$apply` is refused.
- `b1_read` gets the same `aggregate` (the user asked whether to extend it; recommended and taken).
- Home tiles show the last run, refreshed in the background after 60 minutes; opening is live.
- Reports are personal; sharing is a later step.
- The chat is the only editor; chips pre-fill it.
- One thread per report; a report deleted deletes its chat.
- Whole definition per `report_set`, no patches.

## 11. One assistant, no report page of its own (2026-11-04)

Superseding §4, §5.2 and §6.1–6.2 where they differ:

- **No *New report* page.** A report is made by its chat: a general chat's first successful
  `report_set` creates the `assistant_report` and links the thread (`adoptReport`, under the run's
  lease, `report_id is null` guarded). A refused definition leaves the chat general. `reports.create`,
  `blankReport` and `/reports/new` are gone; the home's *New report* tile opens the AI page.
- **The guide is a skill.** `REPORT_GUIDE` is the `report` skill (`assistant/skills.ts`), loaded with
  `load_skill` by intent, not a second system block; the report chat's page note says to load it if it
  is not in the chat yet.
- **One page.** The AI page (`AssistantPage.tsx`) docks the report beside the chat once the chat has
  one (the §6.2 storyboard, unchanged). `/reports/$id` is the same component opened to be read.
- **Rebuilding a report from a file.** A report's chat takes files: spreadsheets are read as text
  (`assistant/sheet.ts`: the first 200 rows a sheet as CSV, the formulas, an xlsx's pivot tables by
  their definition), PDFs and images as before. The skill maps the file's figures to SAP fields,
  never copies its numbers, puts every guessed mapping in `assumptions` and checks one or two totals
  against SAP.

## 12. The filter bar and the brief (2026-11-04)

- **`ReportDef.filters`** (max 8): `{ field, label, default? }`, the report's filter bar: the list's
  `FilterHeader` in a card between the chips and the KPIs (`ReportFilters`, `ReportView.tsx`). The
  definition's filters are shown; every other header field of the report's data (each dataset's,
  those all its sources share) waits in Adapt Filters, and narrows the datasets that have it — under a
  dataset's own condition on it too, since only the definition's filters replace. Go runs on the
  values, Clear on the definition's defaults; which fields are shown is the page's, not stored. A filter's field is a header field of the datasets (not a lookup,
  derive or `Lines.*`); it applies to every dataset whose every source has it. `checkReport` refuses an
  unknown field, a duplicate, and a dataset or source condition on a bar field — one place says a
  field's condition, so a value cleared in the bar filters nothing. A measure's own condition on a bar
  field stands, the bar's not added over it: a KPI's compare keeps its fixed period.
- **The server converts.** `reports.run` takes `filters` (by field, any header field of the data; none = each filter's default).
  `barConds` (`plan.ts`, pure) applies a list's rules (`views.ts`' `toQuery`): a range `ge`/`lt` the next
  day, date tokens resolved; a list `in`; text `contains` unless the field is coded (enum, value help);
  else `eq`. `ReportResult.filters` says, per filter, its control (type, enum options, the value help's
  entity set from B1's metadata) and the value the run applied, dates resolved — the bar draws what the
  figures were filtered by. Only a run on the defaults is stored: a tile shows the report as defined.
- **The brief.** Before a first draft the `report` skill asks one `ask_user` of up to four questions —
  the bar's filters, how to see the figures, and at most two that change the report most (period or
  comparison, net or gross, which documents) — then builds the whole over-delivered draft from the
  answers. Not when rebuilding from a file, refining, or when the user already said. `ask_user` takes
  `more` (≤ 3 further questions) and `multiple`; `ChoiceCard` draws them as one card with one Send, the
  answer a line per question.
