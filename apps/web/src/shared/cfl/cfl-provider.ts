import { client } from "../../orpc.ts";
import type { CflSource, FilterCond, Row } from "../types.ts";

// The Beas CFL `endpoint`, as one function over Confire's two sources. Everything a value help
// reads — type-ahead, dialog pages, existence probe, label lookup — goes through fetchPage, so the
// browser never names a URL or an OData string: an entity source is a ListQuery compiled server-side,
// a masterdata source is a named query table of a model.

export type CflRequest = {
  search?: string;
  searchFields?: string[];
  /** the type-ahead's startswith; the masterdata source has none and always uses contains */
  mode?: "contains" | "startswith";
  filter?: FilterCond[];
  select?: string[];
  orderby?: { field: string; dir: "asc" | "desc" }[];
  /** opaque: a sealed B1 nextLink or a masterdata row offset */
  cursor?: string | number;
  count?: boolean;
};

export type CflPage = { rows: Row[]; total?: number; next?: string | number; columns?: string[] };

const toRows = (columns: string[], rows: unknown[][]): Row[] =>
  rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? null])));

/** The one read. A masterdata source understands search and an exact key (`eq` on one field) —
 *  any other filter is dropped there rather than sent, because it has nowhere to go. */
export async function fetchPage(source: CflSource, req: CflRequest): Promise<CflPage> {
  if (source.kind === "entity") {
    const page = await client.entities.rows({
      entity: source.entitySet,
      query: {
        select: req.select ?? [],
        filter: req.filter ?? [],
        orderby: req.orderby ?? [],
        ...(req.search?.trim() ? { search: req.search.trim(), searchFields: req.searchFields, searchMode: req.mode } : {}),
      },
      ...(typeof req.cursor === "string" ? { cursor: req.cursor } : {}),
      ...(req.count ? { count: true } : {}),
    });
    return { rows: page.rows, total: page.total, next: page.nextCursor };
  }
  const eq = req.filter?.find((f) => f.op === "eq" && !Array.isArray(f.value));
  const input = {
    modelId: source.modelId,
    table: source.table,
    ...(req.search?.trim() ? { search: req.search.trim(), searchCols: req.searchFields } : {}),
    ...(typeof req.cursor === "number" ? { cursor: req.cursor } : {}),
    ...(eq ? { match: { col: eq.field, value: eq.value as string | number } } : {}),
  };
  const page = await (source.scope === "portal" ? client.portal.queryPage(input) : client.configs.queryPage(input));
  return { rows: toRows(page.columns, page.rows), next: page.nextSkip, columns: page.columns };
}

/** A stable cache identity for a source — the user-state key of its dialog (`cfl:<source>`) and the
 *  head of every query key a value help mints. */
export const sourceKey = (s: CflSource): string =>
  s.kind === "entity" ? s.entitySet : `${s.scope}:${s.modelId}:${s.table}`;
