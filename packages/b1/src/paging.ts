import { nextLinkOf, rowsOf, type B1Response, type B1Transport, type QueryOptions } from "./types.ts";

/** Follow @odata.nextLink up to `maxPages`. There is no `readAll`: `maxPages` has no default,
 *  so every caller that exhausts an entity set states its own bound at the call site instead of
 *  hiding an unbounded fetch behind an innocent-looking line. */
export async function readPages(
  t: B1Transport,
  entitySet: string,
  q: QueryOptions | undefined,
  opts: { maxPages: number },
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  return followPages(t, await t.readEntitySet(entitySet, q), { pageSize: q?.maxPageSize ?? q?.top, maxPages: opts.maxPages });
}

/** Follow @odata.nextLink from a first page read elsewhere (an entity set, a crossjoin, a `$apply`),
 *  up to `maxPages` pages in all, page 1 included. `truncated`: B1 still had a next page. */
export async function followPages(
  t: B1Transport,
  first: B1Response,
  opts: { pageSize?: number; maxPages: number },
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const rows = rowsOf(first.data);
  let next = nextLinkOf(first.data);
  for (let page = 1; next && page < opts.maxPages; page++) {
    const res = await t.readNext(next, opts.pageSize);
    rows.push(...rowsOf(res.data));
    next = nextLinkOf(res.data);
  }
  return { rows, truncated: !!next };
}
