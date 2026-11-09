import { runnerFor, tenantConnector } from "./b1.ts";
import { fail, fill, rows } from "./sap-cache.ts";
import {
  DEFAULT_PAGE, type MasterdataQueryRow, type MasterdataRow, type QueryRunner, type RowCache, type RowQuery,
} from "./lookups.ts";

// The one place a query masterdata's values move from SAP into sap_cache, and the one place a
// resolve reads them back out. Everything downstream of `rowCache` is SAP-free by construction.
//
// Replaces history-sync.ts, which did exactly this for a single table reachable only from the
// model builder. Generalising it is what let config_history, its sync, and its private cache go.

/** Pull every page of a query masterdata into its sap_cache entry, wholesale.
 *
 *  Deliberately NOT packages/b1's `readPages`: that accumulates every row before returning, and
 *  these tables have no declared limit. `fill` walks the single-page cursor and inserts as it goes,
 *  so memory stays flat whatever the row count, and a walk that dies partway leaves the last good
 *  sync in place (sap-cache.ts). The rows are written under `company`, the one the read carried.
 */
export async function syncMasterdata(
  tenantId: string, md: MasterdataQueryRow, run: QueryRunner, company: string | null,
): Promise<{ count: number }> {
  const { target, query, columns } = md.query;
  async function* pages() {
    for (let skip: number | undefined = 0; skip !== undefined; ) {
      const page = await run(target, query, columns, { skip });
      yield page.rows;
      skip = page.nextSkip;
    }
  }
  const { rows: count } = await fill(tenantId, "masterdata", md.id, company, pages());
  return { count };
}

/** True when this row has never synced, or its `syncMinutes` have elapsed. */
export const isStale = (r: MasterdataRow): boolean => {
  if (r.kind !== "query" || !r.query) return false;
  if (!r.syncedAt) return true;
  const mins = r.query.syncMinutes;
  return !!mins && Date.now() - r.syncedAt.getTime() > mins * 60_000;
};

// In-flight syncs, so N concurrent page loads start one walk instead of N. Same trick, and the
// same per-process ceiling, as config-project.ts' lookupCache.
const inFlight = new Map<string, Promise<unknown>>();

/** Refresh every stale row, off the request path. Never throws and never blocks: a cold cache
 *  serves empty and fills in behind, which is what keeps a slow first sync from hanging a page
 *  load. The failure lands on the entry's `error` (`syncError` to the UI). */
export function ensureFresh(tenantId: string, rows: MasterdataRow[]): void {
  const due = rows.filter((r): r is MasterdataQueryRow => isStale(r) && !!r.query);
  if (!due.length) return;
  for (const md of due) {
    const key = `${tenantId}:${md.id}`;
    if (inFlight.has(key)) continue;
    const since = new Date();
    const p = (async () => {
      const conn = await tenantConnector(tenantId);
      await syncMasterdata(tenantId, md, runnerFor(conn), conn.companyDb);
    })()
      // Recorded here as well as inside the fill, because the most common failure — no
      // sap_connection row, or an unreachable agent — happens before the walk even starts, and a
      // table stuck on "never synced" with no reason given is the worst version of this.
      .catch((e) => fail(tenantId, "masterdata", md.id, null, e, since))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
}

/** Sync now, reporting failure to the caller. The manual button's entry point. */
export async function syncNow(tenantId: string, md: MasterdataQueryRow): Promise<{ count: number }> {
  const conn = await tenantConnector(tenantId);
  return syncMasterdata(tenantId, md, runnerFor(conn), conn.companyDb);
}

/** The cached rows of a query masterdata or a price list. This is `RowCache` — the seam every
 *  resolve is written against, and the only thing standing between the configurator and Postgres. */
export function rowCache(tenantId: string): RowCache {
  return (kind, key, q) => rows(tenantId, kind, key, q ?? {});
}

/** One page of cached rows plus the value help's cursor. `nextSkip` is a plain row offset, as it
 *  was when the page came from B1 — the client cannot tell the difference. */
export async function pageRows(
  tenantId: string, masterdataId: string, q: RowQuery,
): Promise<{ rows: Record<string, unknown>[]; nextSkip?: number }> {
  const top = q.top ?? DEFAULT_PAGE;
  const page = await rows(tenantId, "masterdata", masterdataId, { ...q, top });
  return { rows: page, ...(page.length >= top ? { nextSkip: (q.skip ?? 0) + page.length } : {}) };
}
