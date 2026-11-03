import { ORPCError } from "@orpc/server";
import {
  andFilter, coerceKey, countOf, nextLinkOf, rowsOf,
  type B1EntitySchema, type B1Transport, type Key,
} from "@confire/b1";
import type { AggSpec, ListQuery } from "@confire/db";
import { compileAggregate, compileList } from "./entity-list.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { viaB1 } from "./b1.ts";
import { t } from "./i18n/index.ts";

// The B1 read bodies, once. entities.* calls these; it does not own the implementation.
//
// The `schema` is a parameter rather than something these functions fetch, so a caller can hand
// compileList a schema it already filtered and the existing rules do the fencing.

/** Joule's list card maximum: a card shows these rows and the model reads no more than that — the
 *  assistant's list tools and b1.read alike. */
export const LIST_CAP = 20;

/** A modelling error from compileList/coerceKey is the caller's mistake, not a server fault. */
export const bad = (e: unknown): never => {
  throw e instanceof ORPCError
    ? e
    : new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
};

/** What a cursor may be replayed as. A sealed nextLink is bound to its tenant, entity set and
 *  list key, so one list's cursor cannot be handed to another. */
export type CursorFence = { tenantId: string; key: string };

/** B1's `@odata.nextLink`, encrypted. The client gets an opaque blob and hands it straight back:
 *  it can neither read the URL nor forge one, so `readNext`'s origin check is no longer the only
 *  thing standing between a browser and an arbitrary Service Layer query. Sealing reuses
 *  crypto.ts's AES-256-GCM — the auth tag is what makes a tampered cursor fail closed. */
const sealCursor = (entity: string, f: CursorFence, nextLink: string): string =>
  encryptSecret(JSON.stringify([f.tenantId, entity, f.key, nextLink]));

const openCursor = (entity: string, f: CursorFence, cursor: string): string => {
  let parts: unknown;
  try {
    parts = JSON.parse(decryptSecret(cursor));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: t("CURSOR_INVALID") });
  }
  const [tenantId, ent, key, link] = parts as [string, string, string, string];
  if (tenantId !== f.tenantId || ent !== entity || key !== f.key || typeof link !== "string")
    throw new ORPCError("BAD_REQUEST", { message: t("CURSOR_OTHER_LIST") });
  return link;
};

export type RowsArgs = {
  query: ListQuery;
  /** rows per page — `Prefer: odata.maxpagesize`, DEFAULT_PAGE (B1_PAGE_SIZE) */
  pageSize: number;
  /** sealed `@odata.nextLink` from the previous page; absent = first page */
  cursor?: string;
  count?: boolean;
  /** no `$select`: whole rows, collections included. B1 refuses some collections in `$select`
   *  (`ItemPrices`), so a read that wants one asks for the row and projects it afterwards. */
  wholeRows?: boolean;
  /** totals instead of rows: `$apply` over the query's filter (reports spec §3.4); no `$count` */
  aggregate?: AggSpec;
};

/**
 * One page of rows for a list query. The query is compiled to OData here — the browser never
 * sends a filter string.
 *
 * `extraFilter` is ANDed onto the *compiled* filter, not onto the query. That is deliberate: a
 * scope clause added after compilation names a field the caller's schema may not even contain,
 * so the caller cannot express, override or observe it through their own query.
 */
export async function readRows(
  b1: B1Transport,
  schema: B1EntitySchema,
  entity: string,
  a: RowsArgs,
  fence: CursorFence,
  extraFilter?: string,
) {
  let res;
  if (a.cursor) {
    // Continuing a list: the next page is wherever B1 said it is. Nothing is recomputed here, so
    // the filter/orderby/fence of page 1 cannot drift from page 2 — the link carries them.
    const link = openCursor(entity, fence, a.cursor);
    res = await viaB1(() => b1.readNext(link, a.pageSize));
  } else {
    let q;
    try {
      q = a.aggregate
        ? compileAggregate(schema, a.query.filter, a.aggregate, { pageSize: a.pageSize, extraFilter })
        : compileList(schema, a.query, { pageSize: a.pageSize, count: a.count });
    } catch (e) {
      return bad(e);
    }
    if (extraFilter && !a.aggregate) q.filter = andFilter(q.filter, extraFilter);
    if (a.wholeRows) delete q.select;
    res = await viaB1(() => b1.readEntitySet(entity, q));
  }

  // No $select means B1 sends collections too. Drop them so an empty select still answers
  // with scalar fields, which is what a list and b1_read mean by it.
  const drop = !a.wholeRows && !a.query.select.length
    ? new Set(schema.fields.filter((f) => f.kind === "collection").map((f) => f.name))
    : undefined;
  const rows = drop?.size
    ? rowsOf(res.data).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k))))
    : rowsOf(res.data);
  const next = nextLinkOf(res.data);
  return {
    rows,
    keys: schema.keys,
    // Only page 1 asks for $count; @odata.count does not ride along on a nextLink page.
    total: countOf(res.data),
    // B1's own answer to "is there more", sealed. Never a row count we guessed at, and never a
    // URL the browser can read or edit.
    nextCursor: next ? sealCursor(entity, fence, next) : undefined,
  };
}

/** One row, with its ETag — which is what makes a curated edit safe. The schema decides string
 *  vs integer quoting: a digit-looking ItemCode is not an Int32 key. */
export async function readOne(b1: B1Transport, schema: B1EntitySchema, entity: string, raw: Key) {
  let key: Key;
  try {
    key = coerceKey(schema, raw);
  } catch (e) {
    return bad(e);
  }
  const res = await viaB1(() => b1.readEntity(entity, key));
  return { row: res.data as Record<string, unknown>, etag: res.etag ?? null };
}
