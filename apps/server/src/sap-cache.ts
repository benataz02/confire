import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { db, sapCache, sapConnection, type CacheKind } from "@confire/db";
import type { RowQuery } from "./lookups.ts";

// Everything Confire keeps from SAP (spec 2026-11-09-sap-cache-design.md), and the only module that
// touches `sap_cache`. Seq 0 is an entry; a many-row entry's SAP rows are seq 1..n. Two rules hold
// for every kind:
//  - the company rule: an entry is written under the company the SAP call carried, and a read
//    treats one of another company than the tenant's as absent (`is not distinct from`: dev may
//    have none). A company switch also deletes the tenant's rows (adoptCompany), but a refill of the
//    old company can land after that delete — this read rule is what keeps it unseen.
//  - one clock: every timestamp here is the JS clock's, so freshness compares like with like.

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CacheEntry<T = unknown> = { data: T | null; company: string | null; fetchedAt: Date | null; error: string | null };
/** A many-row entry's seq-0 data. `changedAt` moves only when a refill's rows hash differently:
 *  `fetchedAt` drives the lifetime, `changedAt` decides whether a stored calculation is stale — so a
 *  daily refill that finds the same prices leaves every configuration, and its pick, alone. */
export type RowsHeader = { rows: number; hash: string; changedAt: string };

/** Bump this whenever metadata.ts changes what a parsed schema looks like. A schema parsed by the
 *  old code is stale however fresh it is, and this is the *only* thing that expires one — a stored
 *  schema is otherwise kept until someone presses Refresh, because B1 metadata changes when an admin
 *  adds a UDF, not on a clock. Without it every tenant would keep serving the old shape forever,
 *  which is how BoYesNoEnum kept rendering as a tYES/tNO dropdown after it became a boolean.
 *  Must be a past timestamp: `Math.min` with process start, so a future one can only ever be a
 *  no-op, never a re-read of $metadata on every single request. */
export const PARSER_EPOCH = Math.min(Date.parse("2026-10-24T14:00:00Z"), Date.now());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long each kind lasts. null: no clock — forever (a company's local currency is fixed when its
 *  database is created; a schema until Refresh or PARSER_EPOCH), until the next run (a report), or
 *  the entry's own (a masterdata's `syncMinutes`, passed by its caller). */
export const LIFETIME_MS: Record<CacheKind, number | null> = {
  schema: null, entity_list: 24 * HOUR, beas_schemas: 24 * HOUR, currency: null, open_counts: 10 * MINUTE,
  print_layout: 2 * HOUR, masterdata: null, price_list: 24 * HOUR, report: null,
};

/** Usable as it is: read once, of a schema parser still current, and within its lifetime. */
export function isFresh(kind: CacheKind, e: CacheEntry | null, lifetimeMs: number | null = LIFETIME_MS[kind]): boolean {
  if (!e?.fetchedAt) return false;
  if (kind === "schema" && e.fetchedAt.getTime() < PARSER_EPOCH) return false;
  return lifetimeMs === null || Date.now() - e.fetchedAt.getTime() < lifetimeMs;
}

/** The tenant's company now, in SQL: null with no `sap_connection` row or no company yet. */
const current = (tenantId: string) =>
  sql`(select ${sapConnection.companyDb} from ${sapConnection} where ${sapConnection.tenantId} = ${tenantId})`;

const at = (tenantId: string, kind: CacheKind, key: string) =>
  and(eq(sapCache.tenantId, tenantId), eq(sapCache.kind, kind), eq(sapCache.key, key));

/** One entry, or null when there is none of the tenant's company. */
export async function entry<T>(tenantId: string, kind: CacheKind, key: string): Promise<CacheEntry<T> | null> {
  const [r] = await db
    .select({ data: sapCache.data, company: sapCache.company, fetchedAt: sapCache.fetchedAt, error: sapCache.error })
    .from(sapCache)
    .where(and(at(tenantId, kind, key), eq(sapCache.seq, 0), sql`${sapCache.company} is not distinct from ${current(tenantId)}`))
    .limit(1);
  return (r as CacheEntry<T> | undefined) ?? null;
}

const ENTRY_PK = [sapCache.tenantId, sapCache.kind, sapCache.key, sapCache.seq];

/** Write one-value entries, read under `company`. Chunked so a statement stays a few hundred KB of
 *  jsonb: an old Service Layer answers every schema (~360) at once. */
export async function put(
  tenantId: string, kind: CacheKind, values: { key: string; data: unknown }[],
  o: { company: string | null; fetchedAt?: Date }, tx: Tx | typeof db = db,
): Promise<void> {
  const fetchedAt = o.fetchedAt ?? new Date();
  for (let i = 0; i < values.length; i += 50) {
    await tx.insert(sapCache)
      .values(values.slice(i, i + 50).map((v) => ({ tenantId, kind, key: v.key, seq: 0, company: o.company, data: v.data ?? null, error: null, fetchedAt })))
      .onConflictDoUpdate({
        target: ENTRY_PK,
        set: { data: sql`excluded.data`, company: sql`excluded.company`, error: null, fetchedAt: sql`excluded.fetched_at` },
      });
  }
}

/** Park a refresh's failure on its entry, keeping the last good data and `fetchedAt`. A first
 *  failure makes an entry of its own, under the call's company or else the tenant's, so it is seen.
 *  `since` is when the failed attempt started: a read that succeeded after it (another process's
 *  refill) is newer than this failure, which is then not stamped on it.
 *  Never throws: it runs on paths whose contract is not to disturb what started them. */
export async function fail(
  tenantId: string, kind: CacheKind, key: string, company: string | null, error: unknown, since?: Date,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.insert(sapCache)
    .values({ tenantId, kind, key, seq: 0, company: sql`coalesce(${company}::text, ${current(tenantId)})`, error: message })
    .onConflictDoUpdate({
      target: ENTRY_PK, set: { error: message },
      ...(since ? { setWhere: sql`${sapCache.fetchedAt} is null or ${sapCache.fetchedAt} <= ${since}` } : {}),
    })
    .catch(() => {});
}

// In-flight loads, so N concurrent misses make one SAP read. Per process: the staff and portal
// processes may each read once.
const inflight = new Map<string, Promise<unknown>>();

/** A one-value entry, read through: fresh, it is returned as it is; otherwise `load` reads SAP —
 *  once for every caller asking meanwhile — and its answer is stored under the company it carried.
 *  A failed load stores nothing and rejects. `refresh` skips the stored entry (a Refresh button). */
export async function cached<T>(
  tenantId: string, kind: CacheKind, key: string,
  load: () => Promise<{ company: string | null; data: T }>,
  o: { refresh?: boolean; lifetimeMs?: number | null } = {},
): Promise<T> {
  if (!o.refresh) {
    const e = await entry<T>(tenantId, kind, key);
    if (isFresh(kind, e, o.lifetimeMs)) return e!.data as T;
  }
  const id = `${tenantId}|${kind}|${key}`;
  let run = inflight.get(id) as Promise<T> | undefined;
  if (!run) {
    run = (async () => {
      const { company, data } = await load();
      await put(tenantId, kind, [{ key, data }], { company });
      return data;
    })().finally(() => inflight.delete(id));
    inflight.set(id, run);
  }
  return run;
}

/** Refill a many-row entry from a stream of pages, wholesale: delete and insert in one transaction,
 *  so a reader sees the old set or the new one, and memory stays one page whatever the row count.
 *  A failure rolls back to the last good set and lands on the entry's `error`, and rejects.
 *  The advisory lock is what keeps two processes refilling one entry off each other's keys.
 *  ponytail: a 100k-row read holds the transaction open for minutes; the upgrade is a generation
 *  column (insert under a new one, drop the old at the end). */
export async function fill(
  tenantId: string, kind: CacheKind, key: string, company: string | null,
  pages: AsyncIterable<Record<string, unknown>[]>,
): Promise<{ rows: number; changed: boolean }> {
  const started = new Date();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}|${kind}|${key}`}))`);
      const [old] = await tx.select({ data: sapCache.data }).from(sapCache).where(and(at(tenantId, kind, key), eq(sapCache.seq, 0)));
      await tx.delete(sapCache).where(at(tenantId, kind, key));
      const hash = createHash("sha1");
      let n = 0;
      for await (const page of pages) {
        if (!page.length) continue;
        await tx.insert(sapCache).values(page.map((data, i) => ({ tenantId, kind, key, seq: n + i + 1, data })));
        for (const r of page) hash.update(JSON.stringify(r));
        n += page.length;
      }
      const digest = hash.digest("hex");
      const prev = old?.data as Partial<RowsHeader> | null | undefined;
      const now = new Date();
      const changed = prev?.hash !== digest || !prev.changedAt;
      const head: RowsHeader = { rows: n, hash: digest, changedAt: changed ? now.toISOString() : prev!.changedAt! };
      // An upsert: a failed fill of this entry that held the lock before this one records its error
      // (`fail`, outside any lock) after its rollback, which can be after this one's delete.
      await tx.insert(sapCache).values({ tenantId, kind, key, seq: 0, company, data: head, error: null, fetchedAt: now })
        .onConflictDoUpdate({ target: ENTRY_PK, set: { company, data: head, error: null, fetchedAt: now } });
      return { rows: n, changed };
    });
  } catch (e) {
    await fail(tenantId, kind, key, company, e, started);
    throw e;
  }
}

const textAt = (col: string) => sql<string>`${sapCache.data} ->> ${col}`;

/** A many-row entry's rows, raw as SAP returned them, in the read's order (`seq`): by column values
 *  (an off-page pick, a price), a row filter, a case-insensitive search, a page. Nothing when the
 *  entry is not of the tenant's company. `row->>col` is text, so values compare as text — which is
 *  how they were stored: a Val here came out of the same jsonb on an earlier read. */
export async function rows(tenantId: string, kind: CacheKind, key: string, q: RowQuery = {}): Promise<Record<string, unknown>[]> {
  if (!(await entry(tenantId, kind, key))) return [];
  const where = [at(tenantId, kind, key), gte(sapCache.seq, 1)];
  if (q.col && q.values?.length) where.push(inArray(textAt(q.col), q.values.map((v) => String(v))));
  if (q.where?.values.length) where.push(inArray(textAt(q.where.col), q.where.values.map((v) => String(v))));
  const term = q.search?.trim();
  const cols = (q.searchCols ?? []).filter(Boolean);
  if (term && cols.length) {
    const like = `%${term}%`;
    where.push(sql`(${sql.join(cols.map((c) => sql`${textAt(c)} ILIKE ${like}`), sql` or `)})`);
  }
  let sel = db.select({ data: sapCache.data }).from(sapCache).where(and(...where)).orderBy(asc(sapCache.seq)).$dynamic();
  if (q.top !== undefined) sel = sel.limit(q.top);
  if (q.skip) sel = sel.offset(q.skip);
  return (await sel).map((r) => r.data as Record<string, unknown>);
}

/** An entry's seq-0 fields as correlated subqueries, for a list query that sorts or filters on them
 *  (the masterdata list) or joins them in (a report's last result). `key` is SQL over the outer
 *  query's row, e.g. `sql\`${configMasterdata.id}::text\``. The company rule applies. */
export function header(tenantId: string, kind: CacheKind, key: SQL) {
  const sub = (col: SQL) => sql`(select ${col} from sap_cache h where h.tenant_id = ${tenantId} and h.kind = ${kind}
    and h.key = ${key} and h.seq = 0 and h.company is not distinct from ${current(tenantId)})`;
  return {
    data: sql<unknown>`${sub(sql`h.data`)}`,
    fetchedAt: sql<Date | null>`${sub(sql`h.fetched_at`)}`.mapWith(sapCache.fetchedAt),
    error: sql<string | null>`${sub(sql`h.error`)}`,
    rows: sql<number | null>`${sub(sql`(h.data->>'rows')::int`)}`.mapWith(Number),
    changedAt: sql<Date | null>`${sub(sql`(h.data->>'changedAt')::timestamptz`)}`.mapWith(sapCache.fetchedAt),
  };
}

/** Drop entries: the tenant's all (a company switch), one kind's (a new UDF makes every schema old),
 *  or some keys of a kind (a masterdata saved or deleted, a report deleted). */
export async function forget(tenantId: string, o: { kind?: CacheKind; keys?: string[] } = {}, tx: Tx | typeof db = db): Promise<void> {
  if (o.keys && !o.keys.length) return;
  if (!o.kind && !o.keys) {
    // The tenant's all — a company switch — skips rows a refill holds: that refill is mid-walk, and
    // the switch may be adopted from inside it (its page answered 409 COMPANY_CHANGED and awaits
    // adoptCompany), so waiting on its locks would wait on itself, holding the sap_connection row
    // and a pooled connection forever. What it skips is the old company's, which no read serves.
    await tx.execute(sql`delete from ${sapCache} where ctid = any(array(
      select ctid from ${sapCache} where ${sapCache.tenantId} = ${tenantId} for update skip locked))`);
    return;
  }
  await tx.delete(sapCache).where(and(
    eq(sapCache.tenantId, tenantId),
    o.kind ? eq(sapCache.kind, o.kind) : undefined,
    o.keys ? inArray(sapCache.key, o.keys) : undefined,
  ));
}
