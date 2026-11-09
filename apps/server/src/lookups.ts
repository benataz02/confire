import { bomItemCodes, refKeyCols, refRows, referencedTables, routingOperationIds } from "@confire/config-engine";
import type {
  CatalogOperation, Entries, LookupRef, ModelDef, ODataQuery, Option, QuerySource, ResolvedLookups, ResolvedTable,
  TableRows, Val,
} from "@confire/config-engine";
import { andFilter, assertName, escapeLiteral } from "@confire/b1";
import { t as text } from "./i18n/index.ts";

// Resolve a model's external references (manual lists, and the tenant's masterdata) into the
// engine's ResolvedLookups.
//
// Every value comes from Postgres now: a "table" masterdata from its own jsonb, a "query"
// masterdata from the rows a sync cached (masterdata-sync.ts). **Nothing on this path talks to
// SAP.** That is the whole point of the rewrite — a configuration renders its options, its BOM
// and its prices with the agent switched off, and a stale cache is a note on the page instead of
// a failed request.
//
// Two seams, and the module knows nothing behind either: `RowCache` is where cached rows come
// from — a masterdata's, or the model's price list's (faked wholesale in tests) — and `QueryRunner` is the read hop the *sync* uses. Only the
// sync and the masterdata editor's live preview still hold a QueryRunner.

/** Rows per B1 page: the `$top` Confire asks for, and (via packages/b1's pageHeader) the
 *  `Prefer: odata.maxpagesize` that goes with it. The Service Layer's own default is **20**, so
 *  without both a "give me 100" read quietly comes back with 20. `B1_PAGE_SIZE` tunes it per install
 *  — a slow WAN to the agent wants smaller pages, a fast LAN larger ones; unset, 0 or junk is 100.
 *  It is every list and value-help page too, so it is also how many rows one page shows.
 *  ponytail: one size for every tenant; make it a sap_connection column if tenants need different ones. */
export const DEFAULT_PAGE = Math.max(1, Number(process.env.B1_PAGE_SIZE) || 100);

/** The most rows a query table may have and still be a parameter's whole domain — the candidate
 *  cap, since an open parameter wider than that could not be enumerated anyway. */
const ENUM_MAX = 200;

export type QueryPage = {
  rows: Record<string, unknown>[];
  /** $skip for the next page; absent = the last page. */
  nextSkip?: number;
};

/** The injected read hop, one page per call. Used by the sync and by the editor's live preview —
 *  never by a resolve. */
export type QueryRunner = (
  target: "b1" | "beas",
  query: ODataQuery,
  columns: string[],
  opts?: { skip?: number; top?: number },
) => Promise<QueryPage>;

/** What a caller wants out of the cache: a page of it, or the rows holding particular values in
 *  one column. One shape rather than three methods, so a test fakes one function. */
export type RowQuery = {
  skip?: number;
  top?: number;
  /** restrict to rows whose `col` holds one of `values` — the off-page binding and price reads */
  col?: string;
  values?: Val[];
  /** a ref's own row filter (LookupRef.where), ANDed with the rest — the value help of a filtered domain */
  where?: { col: string; values: Val[] };
  /** case-insensitive substring over `searchCols` — the value help's search box */
  search?: string;
  searchCols?: string[];
};

/** Cached rows, raw as SAP returned them: a query masterdata's (keyed by its id) or a price list's
 *  (keyed by its number, rows `{ ItemCode, Price }`). */
export type RowCache = (kind: "masterdata" | "price_list", key: string, q?: RowQuery) => Promise<Record<string, unknown>[]>;

/** A live read plus the two display-only fields the value-help dialog reads, and the sync
 *  frequency. Structurally the `query` column of config_masterdata; spelled out here so this
 *  module stays DB-free. */
export type MasterdataQuery = QuerySource & {
  labels?: Record<string, string>;
  hidden?: string[];
  syncMinutes?: number;
};

/** One config_masterdata row: values maintained here (`columns`/`rows`) or cached from a live read
 *  (`query`), with its sap_cache entry's state: `syncedAt` (fetched), `syncError`, `rowCount`. */
export type MasterdataRow = {
  id: string;
  name: string;
  kind: "table" | "query";
  columns: { key: string }[];
  rows: Val[][];
  query?: MasterdataQuery | null;
  syncedAt?: Date | null;
  syncError?: string | null;
  rowCount?: number;
  /** when the cached rows last changed (not merely refetched): with `updatedAt`, what tells a
   *  stored calculation it is stale */
  changedAt?: Date | null;
  /** the editor's last save */
  updatedAt?: Date;
};
export type MasterdataQueryRow = MasterdataRow & { query: MasterdataQuery };

/** Scalars only. A nested B1 collection (an `Items` row's `ItemPrices`) is not a cell value, and
 *  `String()`-ing it here would put "[object Object]" in a column. Absent and non-scalar both
 *  resolve to null. */
const asVal = (v: unknown): Val =>
  v === null || v === undefined ? null
  : typeof v === "number" || typeof v === "boolean" ? v
  : typeof v === "object" ? null
  : String(v);

export function tablesFromMasterdata(rows: MasterdataRow[]): Record<string, ResolvedTable> {
  const out: Record<string, ResolvedTable> = {};
  for (const t of rows) if (t.kind === "table") out[t.name] = { columns: t.columns.map((c) => c.key), rows: t.rows };
  return out;
}

/** The query rows a model actually reads as a lookup. Masterdata is tenant-wide, so without this
 *  filter every model would load every tenant query. */
export function queryRowsFor(model: ModelDef, rows: MasterdataRow[]): MasterdataQueryRow[] {
  const named = referencedTables(model);
  return rows.filter((r): r is MasterdataQueryRow => r.kind === "query" && !!r.query && named.has(r.name));
}

export const queryRowOf = (rows: MasterdataRow[], name: string): MasterdataQueryRow | undefined =>
  rows.find((r): r is MasterdataQueryRow => r.name === name && r.kind === "query" && !!r.query);

function project(ref: LookupRef, t: ResolvedTable, name: string, valueCol: string, labelCol?: string): Option[] {
  const vi = t.columns.indexOf(valueCol);
  if (vi < 0) throw new Error(text("TABLE_NO_COLUMN", name, valueCol));
  const li = labelCol === undefined ? vi : t.columns.indexOf(labelCol);
  if (li < 0) throw new Error(text("TABLE_NO_COLUMN", name, String(labelCol)));
  return refRows(ref, t).map((r) => ({ value: r[vi] ?? null, label: String(r[li] ?? r[vi] ?? "") }));
}

export function optionsFromRef(ref: LookupRef, tables: Record<string, ResolvedTable>): Option[] {
  if (ref.source === "manual") return ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  const t = tables[ref.table];
  if (!t) throw new Error(text("LOOKUP_TABLE_UNKNOWN", ref.table));
  const { valueCol, labelCol } = refKeyCols(ref, t.columns);
  return project(ref, t, ref.table, valueCol, labelCol);
}

// Response field names, in first-seen order — the query's columns by convention. Non-identifier
// keys (@odata.etag &c.) are dropped: columns become `<param>_<col>` values in the DSL. So are
// nested collections, which have no scalar to show (see asVal).
const fieldsOf = (rows: Record<string, unknown>[]): string[] =>
  [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((k) => IDENT.test(k) && !rows.some((r) => typeof r[k] === "object" && r[k] !== null));

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Raw cached rows -> the engine's table shape. Columns come from the masterdata's declared list
 *  when it has one, and otherwise from the rows themselves — a query that declares none sends no
 *  `$select`, and its fields are whatever B1 returned. */
export function toResolvedTable(raw: Record<string, unknown>[], columns?: string[]): ResolvedTable {
  const cols = columns?.length ? columns : fieldsOf(raw);
  return { columns: cols, rows: raw.map((r) => cols.map((c) => asVal(r[c]))) };
}

/** AND an exact key match onto a query's $filter: a value help's existence probe. `eq` is the one
 *  comparison B1 and Beas both take; the column must be a plain name, so a probe cannot smuggle
 *  OData past the query it narrows. */
export function withMatch(query: ODataQuery, match: { col: string; value: string | number }): ODataQuery {
  const v = typeof match.value === "number" ? String(match.value) : `'${escapeLiteral(match.value)}'`;
  return { ...query, filter: andFilter(query.filter, `${assertName(match.col, "column")} eq ${v}`) };
}

/** AND a search OR-group onto a query's $filter, in the target's dialect: B1's `contains(col,'q')`,
 *  Beas' `col like 'q'` — Beas refuses every function ("A logic command is always [item] [logical
 *  comand] [value]"), and its `like` already matches anywhere, ignoring case, with no `%` (verified
 *  on hera, 2026-11-08). Was regex surgery on a URL-encoded `$filter=` group; with a structured
 *  query it is string composition. */
export function withSearch(query: ODataQuery, cols: string[], q: string, target: "b1" | "beas"): ODataQuery {
  const term = escapeLiteral(q.trim());
  const ors = cols.filter((c) => IDENT.test(c)).map((c) => (target === "beas" ? `${c} like '${term}'` : `contains(${c},'${term}')`));
  if (!term || !ors.length) return query;
  return { ...query, filter: andFilter(query.filter, ors.join(" or ")) };
}

/** Resolve a value-help page request against the tenant's masterdata. The table always comes from
 *  masterdata, never from the client, and `cursor` is a plain row offset that can express nothing
 *  but paging. The read itself is now a SQL page of the cache — see masterdata-sync's rowCache. */
export function queryPageSource(
  rows: MasterdataRow[],
  input: {
    table: string; search?: string; searchCols?: string[]; cursor?: number;
    match?: { col: string; value: string | number };
    where?: { col: string; values: Val[] };
  },
): { row: MasterdataQueryRow; q: RowQuery } {
  const row = queryRowOf(rows, input.table);
  if (!row) throw new Error(text("QUERY_TABLE_UNKNOWN", input.table));
  const searchCols = input.searchCols ?? [];
  const declared = row.query.columns;
  // Only enforced when the masterdata declares its columns: one that declares none sends no
  // $select, and its fields are whatever B1 returned.
  const unknownCol = declared.length
    ? [...searchCols, ...(input.match ? [input.match.col] : []), ...(input.where ? [input.where.col] : [])].find((c) => !declared.includes(c))
    : undefined;
  if (unknownCol) throw new Error(text("SEARCH_COLUMN_UNDECLARED", unknownCol, row.name));
  if (input.cursor !== undefined && (!Number.isInteger(input.cursor) || input.cursor < 0))
    throw new Error(text("CURSOR_OFFSET"));
  return {
    row,
    q: {
      skip: input.cursor ?? 0, top: DEFAULT_PAGE, search: input.search, searchCols,
      // The value help's existence probe: an exact key, which a substring search cannot express.
      ...(input.match ? { col: input.match.col, values: [input.match.value] } : {}),
      ...(input.where ? { where: input.where } : {}),
    },
  };
}

/** One live read, shaped as a table. The sync and the masterdata editor's "Test fetch" are the
 *  only callers left — a resolve never gets here. */
export async function fetchQueryTable(
  run: QueryRunner,
  target: "b1" | "beas",
  query: ODataQuery,
  columns?: string[],
  opts?: { skip?: number; top?: number },
): Promise<ResolvedTable & { nextSkip?: number }> {
  const page = await run(target, query, columns ?? [], opts);
  return {
    ...toResolvedTable(page.rows, columns),
    ...(page.nextSkip === undefined ? {} : { nextSkip: page.nextSkip }),
  };
}

/** The BOM's unit prices, read out of the model's cached price list (price-list.ts), whose rows are
 *  `{ ItemCode, Price }`.
 *
 *  Scoped by `bomItemCodes` rather than built from the whole list: `prices` crosses the wire to the
 *  browser with the rest of ResolvedLookups, and a price list is tens of thousands of rows. An item
 *  the list has no row for is simply absent — computeOutputs then flags that BOM line `unpriced`
 *  rather than costing the material at zero.
 *  ponytail: no index on data->>'ItemCode'; the read scans one list's rows. A partial expression
 *  index (where kind = 'price_list') if it profiles slow. */
async function cachedPrices(
  model: ModelDef, domains: ResolvedLookups["domains"], cache: RowCache,
): Promise<Record<string, number>> {
  const { priceList } = model.pricing;
  const codes = bomItemCodes(model, domains);
  if (!priceList || !codes.length) return {};
  const raw = await cache("price_list", String(priceList), { col: "ItemCode", values: codes });
  const prices: Record<string, number> = {};
  for (const r of raw) if (typeof r.ItemCode === "string" && typeof r.Price === "number") prices[r.ItemCode] = r.Price;
  return prices;
}

/** Beas' own field names on `OperationsCatalog`, hardcoded: `pricing.operationTable` is an
 *  OperationsCatalog read by definition. */
const OP = { id: "OperationId", desc: "Description", resource: "ResourceId", setup: "SetupTime", run: "ProductionTime", per: "QuantityPer", rate: "CostRate" } as const;

/** A Beas figure as a number: a null or missing one is 0. Read by value — the EDMX declares
 *  ProductionTime Int32 and Beas answers 0.1. */
const figure = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** The routing's catalog figures, read out of the cached `OperationsCatalog` rows — `cachedPrices`'
 *  rule: only the operations the model can produce. Minutes and per hour, as Beas keeps them; the
 *  run time is per `QuantityPer` units there, so it is divided down to one (0 or none counts as 1).
 *  An operation the cache lacks is absent, and computeOutputs flags its line `uncatalogued`. */
async function cachedOperations(
  model: ModelDef, rows: MasterdataRow[], domains: ResolvedLookups["domains"], cache: RowCache,
): Promise<Record<string, CatalogOperation>> {
  const source = model.pricing.operationTable ? queryRowOf(rows, model.pricing.operationTable) : undefined;
  const ids = routingOperationIds(model, domains);
  if (!source || !ids.length) return {};
  // ponytail: matched on the trimmed code, which the cache holds once synced through runnerFor's
  // trim; a cache synced before that, with a padded *key*, is only found after its next sync.
  const raw = await cache("masterdata", source.id, { col: OP.id, values: ids });
  const out: Record<string, CatalogOperation> = {};
  for (const r of raw) {
    const id = str(r[OP.id]);
    if (!id) continue;
    out[id] = {
      desc: str(r[OP.desc]), resource: str(r[OP.resource]),
      setupMin: figure(r[OP.setup]), runMinPerUnit: figure(r[OP.run]) / (figure(r[OP.per]) || 1), ratePerHour: figure(r[OP.rate]),
    };
  }
  return out;
}

/** Every (table, column, values) triple a persisted selection needs bound, deduped so two
 *  parameters over the same table cost one cache read. */
function offPageNeeds(
  model: ModelDef, rows: MasterdataRow[], tables: Record<string, ResolvedTable>,
  entries: Entries, tableRows: TableRows,
): Map<string, { row: MasterdataQueryRow; col: string; values: Val[] }> {
  const needs = new Map<string, { row: MasterdataQueryRow; col: string; values: Val[] }>();
  const want = (ref: LookupRef, vals: unknown[]) => {
    if (ref.source !== "query") return;
    const source = queryRowOf(rows, ref.table);
    if (!source) return;
    const { valueCol } = refKeyCols(ref, tables[ref.table]?.columns ?? source.query.columns);
    if (!valueCol || !IDENT.test(valueCol)) return; // checkModel's business, not the read path's
    const current = tables[ref.table];
    const ci = current?.columns.indexOf(valueCol) ?? -1;
    const have = new Set(ci < 0 ? [] : current!.rows.map((r) => r[ci]));
    const missing = vals.filter(
      (v): v is Val =>
        v !== undefined && v !== null && v !== "" && !Array.isArray(v) && !have.has(v as Val)
        && (typeof v !== "number" || Number.isFinite(v)),
    );
    if (!missing.length) return;
    const key = `${source.id}:${valueCol}`;
    const at = needs.get(key) ?? { row: source, col: valueCol, values: [] };
    at.values = [...new Set([...at.values, ...missing])];
    needs.set(key, at);
  };

  for (const p of model.parameters)
    if (p.domain?.kind === "options" && p.key in entries) want(p.domain.ref, [entries[p.key]]);
  for (const def of model.tables ?? []) {
    const defRows = tableRows[def.key] ?? [];
    if (!defRows.length) continue;
    for (const c of def.columns)
      if (c.cell.kind === "options") want(c.cell.ref, defRows.map((r) => r[c.key]));
  }
  return needs;
}

/** Append fetched rows under the table's own column order, deduped. */
function appendRows(table: ResolvedTable, raw: Record<string, unknown>[]): ResolvedTable {
  if (!raw.length) return table;
  const added = raw.map((r) => table.columns.map((c) => asVal(r[c])));
  const seen = new Set(table.rows.map((r) => JSON.stringify(r)));
  const fresh = added.filter((r) => !seen.has(JSON.stringify(r)));
  return fresh.length ? { ...table, rows: [...table.rows, ...fresh] } : table;
}

/** A model's lookups as the *model* defines them, with no configuration in sight: the canonical
 *  page of every query table it names, the manual tables whole, and the BOM prices over those
 *  domains. Entries-free on purpose — this is what `cachedLookups` memoizes per (tenant, model,
 *  masterdata version), and folding a configuration's entries into it would make the key unbounded
 *  in user input. `bindEntryValues` is the per-configuration half. */
export async function resolveLookups(
  model: ModelDef,
  rows: MasterdataRow[],
  cache: RowCache,
): Promise<ResolvedLookups> {
  const tables = tablesFromMasterdata(rows);

  // Every query table the model names, whole — or, past ENUM_MAX rows, its start marked `partial`:
  // a domain is complete or it is not one, never whatever fits on a page. Concurrent SQL reads.
  const named = queryRowsFor(model, rows);
  const pages = await Promise.all(named.map((r) => cache("masterdata", r.id, { top: ENUM_MAX + 1 })));
  named.forEach((r, i) => {
    const raw = pages[i]!;
    const partial = raw.length > ENUM_MAX;
    tables[r.name] = {
      ...toResolvedTable(partial ? raw.slice(0, ENUM_MAX) : raw, r.query.columns),
      ...(partial ? { partial: true as const } : {}),
      ...(r.query.labels ? { labels: r.query.labels } : {}),
      ...(r.query.hidden ? { hidden: r.query.hidden } : {}),
    };
  });

  const domains = projectDomains(model, tables);
  // After the domains: a BOM line whose item code is a parameter is priced across everything that
  // parameter could hold, and those values are only known once its domain is resolved.
  return {
    domains, tables,
    prices: await cachedPrices(model, domains, cache),
    operations: await cachedOperations(model, rows, domains, cache),
  };
}

function projectDomains(
  model: ModelDef, tables: Record<string, ResolvedTable>, only?: Set<string>,
): ResolvedLookups["domains"] {
  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    if (p.domain?.kind !== "options") continue;
    const ref = p.domain.ref;
    if (only && (ref.source === "manual" || !only.has(ref.table))) continue;
    // ponytail: a `where` filters the table's resolved rows. Over a partial query table (> ENUM_MAX)
    // that is its first rows plus the bound picks, so the field stays picked through the value help
    // (which filters in SQL), never enumerated, however few rows the filter keeps. Upgrade: read
    // `cache("masterdata", id, { where, top: ENUM_MAX + 1 })` per filtered ref and mark partial per domain.
    domains[p.key] = optionsFromRef(ref, tables);
  }
  return domains;
}

/** Add the rows a *stored* configuration depends on: a value picked months ago may sit past the
 *  canonical page, and without it the parameter shows as unset and its derived columns bind to
 *  null. This was `enrichLookups` and one live SAP round trip per parameter; it is one indexed
 *  SQL read per (table, column) now.
 *
 *  Uncached, and cheap enough to stay that way — which is what keeps `cachedLookups`' key free of
 *  entries. The affected domains are re-projected so the bound value shows up in the dropdown too,
 *  which the live version could not afford to do.
 *
 *  Returns `canonical` itself when nothing was missing, so a caller can compare by identity. */
export async function bindEntryValues(
  model: ModelDef,
  rows: MasterdataRow[],
  canonical: ResolvedLookups,
  cache: RowCache,
  entries: Entries = {},
  tableRows: TableRows = {},
): Promise<ResolvedLookups> {
  const needs = [...offPageNeeds(model, rows, canonical.tables, entries, tableRows).values()];
  if (!needs.length) return canonical;
  const bound = await Promise.all(needs.map((n) => cache("masterdata", n.row.id, { col: n.col, values: n.values })));

  const tables = { ...canonical.tables };
  const touched = new Set<string>();
  needs.forEach((n, i) => {
    const t = tables[n.row.name];
    if (!t) return;
    const next = appendRows(t, bound[i]!);
    if (next === t) return;
    tables[n.row.name] = next;
    touched.add(n.row.name);
  });
  if (!touched.size) return canonical;

  const domains = { ...canonical.domains, ...projectDomains(model, tables, touched) };
  // A bare-identifier BOM item code is priced across its parameter's domain, so a newly bound
  // value needs its price fetched too — the codes that were already priced are not re-read.
  const prices = { ...canonical.prices, ...(await cachedPrices(model, domains, cache)) };
  // The same for an operation chosen by a parameter (a bare identifier in `operationId`).
  const operations = { ...canonical.operations, ...(await cachedOperations(model, rows, domains, cache)) };
  return { domains, tables, prices, operations };
}
