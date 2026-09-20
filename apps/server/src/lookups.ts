import { bomItemCodes, refKeyCols, referencedTables } from "@confire/config-engine";
import type {
  Entries, LookupRef, ModelDef, ODataQuery, Option, QuerySource, ResolvedLookups, ResolvedTable,
  TableRows, Val,
} from "@confire/config-engine";
import { andFilter, escapeLiteral } from "@confire/b1";

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
// from (faked wholesale in tests), and `QueryRunner` is the read hop the *sync* uses. Only the
// sync and the masterdata editor's live preview still hold a QueryRunner.

/** Rows per B1 page: the `$top` Confire asks for, and (via packages/b1's pageHeader) the
 *  `Prefer: odata.maxpagesize` that goes with it. The Service Layer's own default is **20**, so
 *  without both a "give me 100" read quietly comes back with 20.
 *  `B1_PAGE_SIZE` tunes it per install — a slow WAN wants smaller pages, a fast LAN larger ones. */
export const DEFAULT_PAGE = Math.max(1, Number(process.env.B1_PAGE_SIZE) || 100);

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
  /** case-insensitive substring over `searchCols` — the value help's search box */
  search?: string;
  searchCols?: string[];
};

/** Cached rows of one query masterdata, raw as B1 returned them. */
export type RowCache = (masterdataId: string, q?: RowQuery) => Promise<Record<string, unknown>[]>;

/** A live read plus the two display-only fields the value-help dialog reads, and the sync
 *  frequency. Structurally the `query` column of config_masterdata; spelled out here so this
 *  module stays DB-free. */
export type MasterdataQuery = QuerySource & {
  labels?: Record<string, string>;
  hidden?: string[];
  syncMinutes?: number;
};

/** One config_masterdata row: values maintained here (`columns`/`rows`) or cached from a live read
 *  (`query` + the sync state beside it). */
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
};
export type MasterdataQueryRow = MasterdataRow & { query: MasterdataQuery };

/** Scalars only. A nested B1 collection (`ItemPrices`) is not a cell value — it is read straight
 *  off the raw row by the price path, and `String()`-ing it here would put "[object Object]" in a
 *  column. Absent and non-scalar both resolve to null. */
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
 *  filter every model would load every tenant query. `pricing.itemTable` is deliberately NOT here:
 *  its rows are read for prices, by code, not shipped to the browser as a table. */
export function queryRowsFor(model: ModelDef, rows: MasterdataRow[]): MasterdataQueryRow[] {
  const named = referencedTables(model);
  return rows.filter((r): r is MasterdataQueryRow => r.kind === "query" && !!r.query && named.has(r.name));
}

// Bumped whenever a tenant's masterdata changes — an edit, or a finished sync. configs.ts folds it
// into its lookup cache key so new rows show up at once instead of after the TTL.
// ponytail: per-process, like the cache it feeds — a second server process would need the row's
// updatedAt/syncedAt in the key instead.
const versions = new Map<string, number>();
export const masterdataVersion = (tenantId: string) => versions.get(tenantId) ?? 0;
export const bumpMasterdata = (tenantId: string) => { versions.set(tenantId, Date.now()); };

export const queryRowOf = (rows: MasterdataRow[], name: string): MasterdataQueryRow | undefined =>
  rows.find((r): r is MasterdataQueryRow => r.name === name && r.kind === "query" && !!r.query);

function project(t: ResolvedTable, name: string, valueCol: string, labelCol?: string): Option[] {
  const vi = t.columns.indexOf(valueCol);
  if (vi < 0) throw new Error(`Table '${name}' has no column '${valueCol}'`);
  const li = labelCol === undefined ? vi : t.columns.indexOf(labelCol);
  if (li < 0) throw new Error(`Table '${name}' has no column '${labelCol}'`);
  return t.rows.map((r) => ({ value: r[vi] ?? null, label: String(r[li] ?? r[vi] ?? "") }));
}

export function optionsFromRef(ref: LookupRef, tables: Record<string, ResolvedTable>): Option[] {
  if (ref.source === "manual") return ref.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
  const t = tables[ref.table];
  if (!t) throw new Error(`Unknown lookup table '${ref.table}'`);
  const { valueCol, labelCol } = refKeyCols(ref, t.columns);
  return project(t, ref.table, valueCol, labelCol);
}

// Response field names, in first-seen order — the query's columns by convention. Non-identifier
// keys (@odata.etag &c.) are dropped: columns become `<param>_<col>` values in the DSL. So are
// nested collections, which have no scalar to show (see asVal).
const fieldsOf = (rows: Record<string, unknown>[]): string[] =>
  [...new Set(rows.flatMap((r) => Object.keys(r)))]
    .filter((k) => IDENT.test(k) && !rows.some((r) => typeof r[k] === "object" && r[k] !== null));

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Raw cached rows -> the engine's table shape. Columns come from the masterdata's declared list
 *  when it has one, and otherwise from the rows themselves — which is the `Items` case, where no
 *  `$select` is sent precisely so the nested price collection survives. */
export function toResolvedTable(raw: Record<string, unknown>[], columns?: string[]): ResolvedTable {
  const cols = columns?.length ? columns : fieldsOf(raw);
  return { columns: cols, rows: raw.map((r) => cols.map((c) => asVal(r[c]))) };
}

/** AND a `contains(col,'q')` OR-group onto a query's $filter. Was regex surgery on a
 *  URL-encoded `$filter=` group; with a structured query it is string composition. */
export function withSearch(query: ODataQuery, cols: string[], q: string): ODataQuery {
  const term = q.trim();
  const ors = cols.filter((c) => IDENT.test(c)).map((c) => `contains(${c},'${escapeLiteral(term)}')`);
  if (!term || !ors.length) return query;
  return { ...query, filter: andFilter(query.filter, ors.join(" or ")) };
}

/** Resolve a value-help page request against the tenant's masterdata. The table always comes from
 *  masterdata, never from the client, and `cursor` is a plain row offset that can express nothing
 *  but paging. The read itself is now a SQL page of the cache — see masterdata-sync's rowCache. */
export function queryPageSource(
  rows: MasterdataRow[],
  input: { table: string; search?: string; searchCols?: string[]; cursor?: number },
): { row: MasterdataQueryRow; q: RowQuery } {
  const row = queryRowOf(rows, input.table);
  if (!row) throw new Error(`Unknown query table '${input.table}'`);
  const searchCols = input.searchCols ?? [];
  const declared = row.query.columns;
  // Only enforced when the masterdata declares its columns: an `Items` query declares none on
  // purpose (no $select, so the nested price collection survives), and its fields are whatever
  // B1 returned.
  const unknownCol = declared.length ? searchCols.find((c) => !declared.includes(c)) : undefined;
  if (unknownCol) throw new Error(`Search column '${unknownCol}' is not declared by query table '${row.name}'`);
  if (input.cursor !== undefined && (!Number.isInteger(input.cursor) || input.cursor < 0))
    throw new Error("Cursor must be a non-negative row offset");
  return {
    row,
    q: { skip: input.cursor ?? 0, top: DEFAULT_PAGE, search: input.search, searchCols },
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

/** B1's own field names on the `Items` entity. Hardcoded for the same reason `readItemPrices`
 *  hardcoded them: `pricing.itemTable` is an `Items` read by definition, and the price lives in a
 *  nested collection no masterdata column list could name. */
const ITEM_CODE = "ItemCode";
const ITEM_PRICES = "ItemPrices";

/** The BOM's unit prices, read out of the cached `Items` rows.
 *
 *  Scoped by `bomItemCodes` rather than built from the whole table: `prices` crosses the wire to
 *  the browser with the rest of ResolvedLookups, and a tenant's item masterdata is tens of
 *  thousands of rows. An item the cache has no line for is simply absent — computeOutputs then
 *  refuses that BOM line by name rather than costing the material at zero. */
async function cachedPrices(
  model: ModelDef, rows: MasterdataRow[], domains: ResolvedLookups["domains"], cache: RowCache,
): Promise<Record<string, number>> {
  const { priceList, itemTable } = model.pricing;
  if (!priceList || !itemTable) return {};
  const source = queryRowOf(rows, itemTable);
  const codes = bomItemCodes(model, domains);
  if (!source || !codes.length) return {};
  const raw = await cache(source.id, { col: ITEM_CODE, values: codes });
  const prices: Record<string, number> = {};
  for (const r of raw) {
    const code = r[ITEM_CODE];
    const line = (r[ITEM_PRICES] as { PriceList?: number; Price?: number }[] | undefined)
      ?.find((pr) => pr.PriceList === priceList);
    if (typeof code === "string" && typeof line?.Price === "number") prices[code] = line.Price;
  }
  return prices;
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

  // The canonical page of every query table the model names. Concurrent: each is its own SQL read.
  const named = queryRowsFor(model, rows);
  const pages = await Promise.all(named.map((r) => cache(r.id, { top: DEFAULT_PAGE })));
  named.forEach((r, i) => {
    const raw = pages[i]!;
    tables[r.name] = {
      ...toResolvedTable(raw, r.query.columns),
      ...(raw.length >= DEFAULT_PAGE ? { nextSkip: DEFAULT_PAGE } : {}),
      ...(r.query.labels ? { labels: r.query.labels } : {}),
      ...(r.query.hidden ? { hidden: r.query.hidden } : {}),
    };
  });

  const domains = projectDomains(model, tables);
  // After the domains: a BOM line whose item code is a parameter is priced across everything that
  // parameter could hold, and those values are only known once its domain is resolved.
  return { domains, tables, prices: await cachedPrices(model, rows, domains, cache) };
}

function projectDomains(
  model: ModelDef, tables: Record<string, ResolvedTable>, only?: Set<string>,
): ResolvedLookups["domains"] {
  const domains: ResolvedLookups["domains"] = {};
  for (const p of model.parameters) {
    if (p.domain?.kind !== "options") continue;
    const ref = p.domain.ref;
    if (only && (ref.source === "manual" || !only.has(ref.table))) continue;
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
  const bound = await Promise.all(needs.map((n) => cache(n.row.id, { col: n.col, values: n.values })));

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
  const prices = { ...canonical.prices, ...(await cachedPrices(model, rows, domains, cache)) };
  return { domains, tables, prices };
}
