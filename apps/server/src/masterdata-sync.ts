import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, configMasterdata, configMasterdataRow } from "@confire/db";
import { runnerFor, tenantConnector } from "./b1.ts";
import {
  bumpMasterdata, DEFAULT_PAGE,
  type MasterdataQueryRow, type MasterdataRow, type QueryRunner, type RowCache, type RowQuery,
} from "./lookups.ts";

// The one place a query masterdata's values move from SAP into Postgres, and the one place a
// resolve reads them back out. Everything downstream of `rowCache` is SAP-free by construction.
//
// Replaces history-sync.ts, which did exactly this for a single table reachable only from the
// model builder. Generalising it is what let config_history, its sync, and its private cache go.

/** Rows held in memory while a sync walks. One page — the insert happens per page, so a table
 *  with no ceiling still costs O(page) memory. */
const CACHE_TTL_MS = 5 * 60_000;
const allRows = new Map<string, { at: number; rows: Record<string, unknown>[] }>();

/** Pull every page of a query masterdata into config_masterdata_row, wholesale.
 *
 *  Deliberately NOT packages/b1's `readPages`: that accumulates every row before returning, and
 *  these tables have no declared limit. Walking the single-page cursor and inserting as we go
 *  keeps memory flat whatever the row count.
 *
 *  ponytail: delete + refill inside one transaction, so readers never see a half-synced table.
 *            A 100k-row table holds that transaction open for minutes; the upgrade is a
 *            generation column (insert under a new syncId, drop the old one at the end).
 */
export async function syncMasterdata(
  tenantId: string, md: MasterdataQueryRow, run: QueryRunner,
): Promise<{ count: number }> {
  const { target, query, columns } = md.query;
  try {
    let count = 0;
    await db.transaction(async (tx) => {
      await tx
        .delete(configMasterdataRow)
        .where(and(eq(configMasterdataRow.tenantId, tenantId), eq(configMasterdataRow.masterdataId, md.id)));
      for (let skip: number | undefined = 0; skip !== undefined; ) {
        const page = await run(target, query, columns, { skip });
        if (page.rows.length)
          await tx.insert(configMasterdataRow).values(
            page.rows.map((row, i) => ({ tenantId, masterdataId: md.id, seq: count + i, row })),
          );
        count += page.rows.length;
        skip = page.nextSkip;
      }
    });
    await db
      .update(configMasterdata)
      .set({ syncedAt: new Date(), syncError: null, rowCount: count })
      .where(and(eq(configMasterdata.id, md.id), eq(configMasterdata.tenantId, tenantId)));
    allRows.delete(`${tenantId}:${md.id}`);
    bumpMasterdata(tenantId);
    return { count };
  } catch (e) {
    // The failure is recorded, not swallowed: `syncError` is what the editor and the process page
    // show. Manual syncs rethrow so the button can report it; ensureFresh below does not.
    await recordError(tenantId, md.id, e);
    throw e;
  }
}

/** Park a failure on the row. Never throws: it is called from a background path whose whole
 *  contract is that it cannot disturb the request that started it. */
async function recordError(tenantId: string, id: string, e: unknown): Promise<void> {
  const syncError = e instanceof Error ? e.message : String(e);
  await db
    .update(configMasterdata)
    .set({ syncError })
    .where(and(eq(configMasterdata.id, id), eq(configMasterdata.tenantId, tenantId)))
    .catch(() => {});
}

/** True when this row has never synced, or its `syncMinutes` have elapsed. */
export const isStale = (r: MasterdataRow): boolean => {
  if (r.kind !== "query" || !r.query) return false;
  if (!r.syncedAt) return true;
  const mins = r.query.syncMinutes;
  return !!mins && Date.now() - r.syncedAt.getTime() > mins * 60_000;
};

// In-flight syncs, so N concurrent page loads start one walk instead of N. Same trick, and the
// same per-process ceiling, as configs.ts' lookupCache.
const inFlight = new Map<string, Promise<unknown>>();

/** Refresh every stale row, off the request path. Never throws and never blocks: a cold cache
 *  serves empty and fills in behind, which is what keeps a slow first sync from hanging a page
 *  load. The failure lands in `syncError` for the UI to show. */
export function ensureFresh(tenantId: string, rows: MasterdataRow[]): void {
  const due = rows.filter((r): r is MasterdataQueryRow => isStale(r) && !!r.query);
  if (!due.length) return;
  for (const md of due) {
    const key = `${tenantId}:${md.id}`;
    if (inFlight.has(key)) continue;
    const p = (async () => {
      const run = runnerFor(await tenantConnector(tenantId));
      await syncMasterdata(tenantId, md, run);
    })()
      // Recorded here as well as inside syncMasterdata, because the most common failure — no
      // sap_connection row, or an unreachable agent — happens before the walk even starts, and a
      // table stuck on "never synced" with no reason given is the worst version of this.
      .catch((e) => recordError(tenantId, md.id, e))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
  }
}

/** Sync now, reporting failure to the caller. The manual button's entry point. */
export async function syncNow(tenantId: string, md: MasterdataQueryRow): Promise<{ count: number }> {
  return syncMasterdata(tenantId, md, runnerFor(await tenantConnector(tenantId)));
}

const textAt = (col: string) => sql<string>`${configMasterdataRow.row} ->> ${col}`;

/** The cached rows of one query masterdata. This is `RowCache` — the seam every resolve is
 *  written against, and the only thing standing between the configurator and Postgres. */
export function rowCache(tenantId: string): RowCache {
  return async (masterdataId, q) => {
    // No filter and no window: the whole table, which is what similarity scoring wants. Cached in
    // process because it re-runs on every keystroke and the table can be tens of thousands of rows.
    if (!q || (q.top === undefined && q.col === undefined && !q.search)) {
      const key = `${tenantId}:${masterdataId}`;
      const hit = allRows.get(key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
      const rows = await selectRows(tenantId, masterdataId, {});
      allRows.set(key, { at: Date.now(), rows });
      return rows;
    }
    return selectRows(tenantId, masterdataId, q);
  };
}

async function selectRows(
  tenantId: string, masterdataId: string, q: RowQuery,
): Promise<Record<string, unknown>[]> {
  const where = [eq(configMasterdataRow.tenantId, tenantId), eq(configMasterdataRow.masterdataId, masterdataId)];

  // `row->>col` is text, so the values are compared as text. That is exactly how they were stored:
  // a Val here came out of the same jsonb on a previous read.
  if (q.col && q.values?.length) {
    where.push(inArray(textAt(q.col), q.values.map((v) => String(v))));
  }

  const term = q.search?.trim();
  const cols = (q.searchCols ?? []).filter(Boolean);
  if (term && cols.length) {
    const like = `%${term}%`;
    where.push(sql`(${sql.join(cols.map((c) => sql`${textAt(c)} ILIKE ${like}`), sql` or `)})`);
  }

  let sel = db
    .select({ row: configMasterdataRow.row })
    .from(configMasterdataRow)
    .where(and(...where))
    // `seq` replays the masterdata query's own orderby — see the schema note.
    .orderBy(asc(configMasterdataRow.seq))
    .$dynamic();
  if (q.top !== undefined) sel = sel.limit(q.top);
  if (q.skip) sel = sel.offset(q.skip);
  return (await sel).map((r) => r.row);
}

/** One page of cached rows plus the value help's cursor. `nextSkip` is a plain row offset, as it
 *  was when the page came from B1 — the client cannot tell the difference. */
export async function pageRows(
  tenantId: string, masterdataId: string, q: RowQuery,
): Promise<{ rows: Record<string, unknown>[]; nextSkip?: number }> {
  const top = q.top ?? DEFAULT_PAGE;
  const rows = await selectRows(tenantId, masterdataId, { ...q, top });
  return { rows, ...(rows.length >= top ? { nextSkip: (q.skip ?? 0) + rows.length } : {}) };
}
