import { andFilter, encodeBool, escapeLiteral, isYesNo, type B1Field, type B1EntitySchema, type QueryOptions } from "@confire/b1";
import type { FilterCond, ListQuery } from "@confire/db";
import { searchTargets } from "./list-sql.ts";

// Compile a list query (ListQuery) into a B1 read. list-sql.ts compiles the same query to SQL for
// Confire's own tables — same query, same rules, one executed by B1 and one by Postgres.
//
// Pure: no db, no transport. The router hands it a cached schema and gets QueryOptions back.

/** Fields a list can project and filter on: scalars only. A collection in $select drags every
 *  document line into a list page. */
export const scalarFields = (schema: B1EntitySchema): B1Field[] =>
  schema.fields.filter((f) => f.kind !== "collection");

const literal = (f: B1Field, value: string | number | boolean): string => {
  switch (f.kind) {
    case "number":
      if (typeof value === "boolean" || !Number.isFinite(Number(value)))
        throw new Error(`'${f.name}' needs a number, got '${value}'`);
      return String(Number(value));
    case "boolean": {
      const on = value === true || value === "true" || value === "tYES";
      // A BoYesNoEnum column rejects `eq true` — it wants the quoted member, as dashboard-snapshot.ts
      // already does with `Cancelled eq 'tNO'`.
      return isYesNo(f) ? `'${encodeBool(f, on)}'` : String(on);
    }
    // OData v4 date/time literals are unquoted. (dashboard-snapshot.ts quotes its DocDate
    // literals — that form is what was verified against the live b1s/v2 there, so it stays;
    // ponytail: if one of the two 400s in the field, make both match whichever wins.)
    case "date":
    case "time":
      return String(value);
    default:
      return `'${escapeLiteral(String(value))}'`;
  }
};

const condition = (cond: FilterCond, f: B1Field): string => {
  if (cond.op === "contains" || cond.op === "startswith")
    return `${cond.op}(${f.name},'${escapeLiteral(String(cond.value))}')`;
  // B1's $filter has no reliable `in`; OR of eq is what search already emits, and andFilter
  // parenthesizes each clause so this cannot steal later ANDs.
  if (cond.op === "in") {
    const values = Array.isArray(cond.value) ? cond.value : [cond.value];
    if (!values.length) return "1 eq 0";
    return values.map((v) => `${f.name} eq ${literal(f, v)}`).join(" or ");
  }
  if (Array.isArray(cond.value)) throw new Error(`Filter '${cond.field}' ${cond.op} needs a single value`);
  return `${f.name} ${cond.op} ${literal(f, cond.value)}`;
};

/**
 * `query` -> `QueryOptions`. Rules:
 *  - $select is the key fields plus the visible columns, so a row can always be opened.
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

  const visible = query.select.length ? query.select : fields.map((f) => f.name);
  const select = [...new Set([...schema.keys, ...visible])].filter((n) => byName.has(n));

  let filter: string | undefined;
  for (const cond of query.filter) {
    const f = byName.get(cond.field);
    if (!f) throw new Error(`Filter field '${cond.field}' is not on ${schema.name}`);
    filter = andFilter(filter, condition(cond, f));
  }

  const q = query.search?.trim();
  if (q) {
    const fn = query.searchMode === "startswith" ? "startswith" : "contains";
    // Without searchFields: the visible string columns, so a search cannot match on a field the
    // user cannot see.
    const candidates = query.searchFields?.length
      ? fields
      : fields.filter((f) => !query.select.length || select.includes(f.name));
    const ors = searchTargets(candidates.map((f) => [f.name, f] as [string, B1Field]), (f) => f.kind === "string", query.searchFields)
      .map((f) => `${fn}(${f.name},'${escapeLiteral(q)}')`);
    if (ors.length) filter = andFilter(filter, ors.join(" or "));
  }

  const ord = query.orderby.filter((o) => byName.has(o.field));
  return {
    select,
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
