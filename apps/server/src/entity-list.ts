import {
  andFilter, assertName, encodeBool, escapeLiteral, isYesNo,
  type B1Field, type B1EntitySchema, type CrossJoinSpec, type QueryOptions,
} from "@confire/b1";
import type { AggSpec, FilterCond, ListQuery } from "@confire/db";
import { searchTargets } from "./list-sql.ts";
import { t } from "./i18n/index.ts";

// Compile a list query (ListQuery) into a B1 read. list-sql.ts compiles the same query to SQL for
// Confire's own tables — same query, same rules, one executed by B1 and one by Postgres.
//
// Pure: no db, no transport. The router hands it a cached schema and gets QueryOptions back.

/** Fields a list can project and filter on: scalars only. A collection in $select drags every
 *  document line into a list page. */
export const scalarFields = (schema: B1EntitySchema): B1Field[] =>
  schema.fields.filter((f) => f.kind !== "collection");

const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

const literal = (f: B1Field, value: string | number | boolean): string => {
  switch (f.kind) {
    case "number":
      if (typeof value === "boolean" || !Number.isFinite(Number(value)))
        throw new Error(t("FILTER_NEEDS_NUMBER", f.name, String(value)));
      return String(Number(value));
    case "boolean": {
      const on = value === true || value === "true" || value === "tYES";
      // A BoYesNoEnum column rejects `eq true` — it wants the quoted member (`Cancelled eq 'tNO'`).
      return isYesNo(f) ? `'${encodeBool(f, on)}'` : String(on);
    }
    // Quoted, though OData v4 dates are bare: B1's `$filter` takes both, but `$apply`'s filter()
    // refuses the bare one — `Orders?$apply=filter(DocDueDate lt 2026-11-03)/aggregate($count as n)`
    // → 400 code 201 "Not supported query option", the quoted form the same count as `$filter`
    // (verified on a live b1s/v2, 2026-11-03). Still held to the literal's own shape: anything else
    // would be more OData — `2000-01-01) or (DocEntry gt 0` would have outlived a fence after it.
    case "date":
      if (!DATE.test(String(value))) throw new Error(t("FILTER_NEEDS_DATE", f.name, String(value)));
      return `'${value}'`;
    case "time":
      if (!TIME.test(String(value))) throw new Error(t("FILTER_NEEDS_DATE", f.name, String(value)));
      return String(value);
    default:
      return `'${escapeLiteral(String(value))}'`;
  }
};

const condition = (cond: FilterCond, f: B1Field, path = f.name): string => {
  if (cond.op === "contains" || cond.op === "startswith")
    return `${cond.op}(${path},'${escapeLiteral(String(cond.value))}')`;
  // B1's $filter has no reliable `in`; OR of eq is what search already emits, and andFilter
  // parenthesizes each clause so this cannot steal later ANDs.
  if (cond.op === "in") {
    const values = Array.isArray(cond.value) ? cond.value : [cond.value];
    if (!values.length) return "1 eq 0";
    return values.map((v) => `${path} eq ${literal(f, v)}`).join(" or ");
  }
  if (Array.isArray(cond.value)) throw new Error(t("FILTER_SINGLE_VALUE", cond.field, cond.op));
  return `${path} ${cond.op} ${literal(f, cond.value)}`;
};

/** The `$filter` text of a list's conditions, ANDed. `fields` is by the name a condition uses,
 *  `path` what the Service Layer calls it (a crossjoin prefixes the set). A condition on a field
 *  that is not there is an error: dropping it would answer more than was asked. */
export function compileFilter(
  fields: Map<string, B1Field>, filter: FilterCond[], entity: string, path: (field: string) => string = (x) => x,
): string | undefined {
  let out: string | undefined;
  for (const cond of filter) {
    const f = fields.get(cond.field);
    if (!f) throw new Error(t("FILTER_FIELD_NOT_ON", cond.field, entity));
    out = andFilter(out, condition(cond, f, path(cond.field)));
  }
  return out;
}

/**
 * `query` -> `QueryOptions`. Rules:
 *  - $select is the key fields plus the named columns, so a row can always be opened.
 *    An empty select sends none: naming every scalar field (the old way to keep a
 *    collection off the page) exceeds the Service Layer's query-string limit. readRows
 *    drops collections from that answer instead.
 *  - paging is server-driven (Prefer: odata.maxpagesize) and continued via @odata.nextLink.
 *  - a filter naming a field the entity does not have is an error: silently dropping it would
 *    show MORE rows than were asked for.
 *  - a *select* naming a missing field is not: a saved view outliving a UDF should still open.
 *  - free-text search becomes contains() — or startswith(), for the value help's type-ahead — over
 *    string fields only, which is all B1 accepts. `searchFields` narrows it; naming a non-string
 *    field there is an error, like a filter.
 */
export function compileList(
  schema: B1EntitySchema,
  query: ListQuery,
  opts: { pageSize: number; count?: boolean },
): QueryOptions {
  const fields = scalarFields(schema);
  const byName = new Map(fields.map((f) => [f.name, f]));

  // Empty stays empty. `fields.map(f => f.name)` here is what put every scalar on `$select`.
  // ponytail: B1 then returns the whole row (lines included, dropped in readRows). A short
  // default column list per entity if that response gets heavy.
  const select = query.select.length
    ? [...new Set([...schema.keys, ...query.select])].filter((n) => byName.has(n))
    : undefined;

  let filter = compileFilter(byName, query.filter, schema.name);

  const q = query.search?.trim();
  if (q) {
    const fn = query.searchMode === "startswith" ? "startswith" : "contains";
    // Without searchFields: the visible string columns, so a search cannot match on a field the
    // user cannot see.
    const candidates = query.searchFields?.length ? fields
      : select ? fields.filter((f) => select.includes(f.name)) : fields;
    const ors = searchTargets(candidates.map((f) => [f.name, f] as [string, B1Field]), (f) => f.kind === "string", query.searchFields)
      .map((f) => `${fn}(${f.name},'${escapeLiteral(q)}')`);
    if (ors.length) filter = andFilter(filter, ors.join(" or "));
  }

  const ord = query.orderby.filter((o) => byName.has(o.field));
  return {
    ...(select?.length ? { select } : {}),
    ...(filter ? { filter } : {}),
    ...(ord.length ? { orderby: ord.map((o) => `${o.field}${o.dir === "desc" ? " desc" : ""}`).join(",") } : {}),
    // The page size is `Prefer: odata.maxpagesize`, never `$top`. `$top` bounds the whole result
    // set, so once it is exhausted B1 stops emitting `@odata.nextLink` — a list paged with `$top`
    // reads its first page and then cannot tell "there is more" from "that was everything".
    // Server-driven paging + the nextLink it returns is the only combination that can.
    maxPageSize: opts.pageSize,
    ...(opts.count ? { count: true } : {}),
  };
}

// --- SAP-side totals (reports spec §3.4) -----------------------------------------------------------
// `$apply=filter(…)/groupby((…),aggregate(…))`: the filter is a transformation inside `$apply`, not a
// `$filter` beside it — OData evaluates `$filter` after `$apply`, on the grouped rows, where the
// document's own fields are gone.

const AGG_WORD = { sum: "sum", avg: "average", min: "min", max: "max", countDistinct: "countdistinct" } as const;

const applyText = (filter: string | undefined, groupBy: string[], measures: string[]): string => {
  const agg = `aggregate(${measures.join(",")})`;
  const body = groupBy.length ? `groupby((${groupBy.join(",")}),${agg})` : agg;
  return filter ? `filter(${filter})/${body}` : body;
};

/** One measure: `$count as n` for a count, else `<field> with <agg> as <as>`. */
function measureText(m: AggSpec["measures"][number], field: (name: string) => string): string {
  const as = assertName(m.as, "alias");
  if (m.agg === "count") return `$count as ${as}`;
  if (!m.field) throw new Error(`${m.agg} needs a field`);
  return `${field(m.field)} with ${AGG_WORD[m.agg]} as ${as}`;
}

/** b1.read's `aggregate` and a report's pushed-down totals over one entity set. `extraFilter` is a
 *  fence ANDed after compilation, as in readRows. */
export function compileAggregate(
  schema: B1EntitySchema, filter: FilterCond[], agg: AggSpec, opts: { pageSize: number; extraFilter?: string },
): QueryOptions {
  const byName = new Map(scalarFields(schema).map((f) => [f.name, f]));
  const known = (name: string) => {
    if (!byName.has(name)) throw new Error(t("FILTER_FIELD_NOT_ON", name, schema.name));
    return name;
  };
  let f = compileFilter(byName, filter, schema.name);
  if (opts.extraFilter) f = andFilter(f, opts.extraFilter);
  const apply = applyText(f, agg.groupBy.map(known), agg.measures.map((m) => measureText(m, known)));
  return { apply, maxPageSize: opts.pageSize };
}

const LINES = "DocumentLines";

/** A document set and its lines as one dataset: names `X` (the header's) and `Lines.X`, their
 *  crossjoin paths, and the filter with the DocEntry equality that is the join (doc-chain.ts).
 *  Rows only, never totals: B1's `$apply` over this crossjoin names no line field (reports/run.ts). */
function linesOf(header: B1EntitySchema, set: string, filter: FilterCond[]) {
  const lines = header.fields.find((f) => f.name === LINES && f.kind === "collection")?.fields ?? [];
  const byName = new Map<string, B1Field>([
    ...scalarFields(header).map((f) => [f.name, f] as const),
    ...lines.filter((f) => f.kind !== "collection").map((f) => [`Lines.${f.name}`, f] as const),
  ]);
  const at = (name: string) => {
    const f = byName.get(name);
    if (!f) throw new Error(t("FILTER_FIELD_NOT_ON", name, set));
    return name.startsWith("Lines.")
      ? { name: f.name, path: `${set}/${LINES}/${f.name}`, line: true }
      : { name: f.name, path: `${set}/${f.name}`, line: false };
  };
  const join = `${set}/DocEntry eq ${set}/${LINES}/DocEntry`;
  const own = compileFilter(byName, filter, set, (n) => at(n).path);
  return { at, filter: own ? `${join} and (${own})` : join, entities: [set, `${set}/${LINES}`] };
}

/** The rows of a document set with its lines (the report runner's fallback and tables): the named
 *  fields, each from its side of the join, as flattenJoined reads them back. */
export function compileLinesRows(
  header: B1EntitySchema, set: string, filter: FilterCond[], fields: string[],
  opts: { pageSize: number; orderby?: { field: string; dir: "asc" | "desc" }[] },
): CrossJoinSpec {
  const l = linesOf(header, set, filter);
  const orderby = (opts.orderby ?? []).map((o) => `${l.at(o.field).path}${o.dir === "desc" ? " desc" : ""}`).join(",");
  const picked = fields.map(l.at);
  const head = [...new Set([...header.keys, ...picked.filter((p) => !p.line).map((p) => p.name)])];
  const line = [...new Set(["LineNum", ...picked.filter((p) => p.line).map((p) => p.name)])];
  return {
    entities: l.entities,
    expand: [{ entity: set, select: head }, { entity: `${set}/${LINES}`, select: line }],
    filter: l.filter,
    ...(orderby ? { orderby } : {}),
    maxPageSize: opts.pageSize,
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A crossjoin's row back to a dataset's names, whichever shape B1 answers in: nested per entity
 *  (`{ Orders: {…}, "Orders/DocumentLines": {…} }`) or flat paths (`"Orders/DocumentLines/ItemCode"`).
 *  The totals' aliases stay as they are. */
export function flattenJoined(row: Record<string, unknown>, set: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = `${set}/${LINES}`;
  for (const [k, v] of Object.entries(row)) {
    if (k === set && isObject(v)) Object.assign(out, v);
    else if (k === lines && isObject(v)) for (const [lk, lv] of Object.entries(v)) out[`Lines.${lk}`] = lv;
    else if (k.startsWith(`${lines}/`)) out[`Lines.${k.slice(lines.length + 1)}`] = v;
    else if (k.startsWith(`${set}/`)) out[k.slice(set.length + 1)] = v;
    else out[k] = v;
  }
  return out;
}
