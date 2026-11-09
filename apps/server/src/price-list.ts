import { createHash } from "node:crypto";
import { B1Error, rowsOf, type B1Transport } from "@confire/b1";
import { tenantConnector } from "./b1.ts";
import type { ModelDef } from "@confire/config-engine";
import { entry, fail, fill, isFresh, type RowsHeader } from "./sap-cache.ts";

// The model's price list (spec 2026-11-09-sap-cache-design.md §The price list): what costs the BOM
// materials. One stored SQL query per list over ITM1, created on first use like the open counts'
// (open-counts.ts), its answer paged into a `price_list` entry of sap_cache — `ItemCode → Price` and
// nothing else, where an `Items` read would carry every field and every list of every item. Filled
// when a model is saved with a list it lacks, refreshed in the background after 24 h, forced by a
// configuration's Refresh (`configs.sync`). SAP must allow ITM1 in b1s_sqltable.conf and grant the
// user SQL queries; a refusal is the entry's `error`, which the configuration names (no fallback).

export const PRICE_PAGE = 500;

/** The list a model's prices come from — only a model with a BOM has prices to read. */
export const priceListOf = (def: ModelDef): number | undefined => (def.bom.length ? def.pricing.priceList : undefined);

/** The list number goes into SQL text, so it is checked here, where the text is built. */
export function priceListSql(list: number): string {
  if (!Number.isInteger(list) || list <= 0) throw new Error(`Not a price list number: ${list}`);
  return `SELECT ItemCode, Price FROM ITM1 WHERE PriceList = ${list} ORDER BY ItemCode`;
}

/** Derived from the text, so a changed query is a new entry and never an edit to one an older server
 *  still runs. ponytail: superseded entries stay in SAP, as the open counts' do. */
export const priceListCode = (list: number): string =>
  `CF_PL_${createHash("sha1").update(priceListSql(list)).digest("hex").slice(0, 8)}`;

/** A row of the answer, its columns matched case-insensitively (HANA may upper-case them) and the
 *  price read as a number (it may come back as a string). No code or no price is no row. */
export function priceRow(r: Record<string, unknown>): { ItemCode: string; Price: number } | null {
  const col = (name: string) => r[Object.keys(r).find((k) => k.toLowerCase() === name) ?? name];
  const code = col("itemcode");
  const raw = col("price");
  if (typeof code !== "string" || !code.trim() || raw === null || raw === undefined || raw === "") return null;
  const price = Number(raw);
  return Number.isFinite(price) ? { ItemCode: code.trim(), Price: price } : null;
}

/** The stored query's answer, page by page, creating the query when SAP has none by its code. */
async function* pricePages(b1: B1Transport, list: number): AsyncGenerator<Record<string, unknown>[]> {
  const code = priceListCode(list);
  let res;
  try {
    res = await b1.sqlQuery(code, { maxPageSize: PRICE_PAGE });
  } catch (e) {
    // ponytail: unverified (spec §16): that a missing entry answers 404, as open-counts.ts assumes.
    if (!(e instanceof B1Error && e.status === 404)) throw e;
    await b1.createEntity("SQLQueries", { SqlCode: code, SqlName: `Confire: price list ${list}`, SqlText: priceListSql(list) }, { prefer: "no-content" });
    res = await b1.sqlQuery(code, { maxPageSize: PRICE_PAGE });
  }
  for (;;) {
    yield rowsOf(res.data).map(priceRow).filter((r) => r !== null);
    const next = (res.data as Record<string, unknown> | null)?.["@odata.nextLink"];
    if (typeof next !== "string" || !next) return;
    res = await b1.readNext(next, PRICE_PAGE);
  }
}

/** Read the list now, reporting failure (which the fill also parks on the entry). */
export async function syncPriceList(tenantId: string, list: number): Promise<{ rows: number }> {
  const conn = await tenantConnector(tenantId);
  const { rows } = await fill(tenantId, "price_list", String(list), conn.companyDb, pricePages(conn.b1, list));
  return { rows };
}

const inFlight = new Map<string, Promise<unknown>>();

/** Fill the list in the background when it is missing or older than 24 h. Never throws and never
 *  blocks: a calculation goes ahead with what is there, and a failure is the entry's `error`. */
export function ensurePriceList(tenantId: string, list: number | undefined): void {
  if (!list) return;
  const id = `${tenantId}|${list}`;
  if (inFlight.has(id)) return;
  const run = (async () => {
    if (isFresh("price_list", await entry(tenantId, "price_list", String(list)))) return;
    await syncPriceList(tenantId, list);
  })()
    // Recorded here as well as by the fill: no agent, or one unreachable, fails before it starts.
    .catch((e) => fail(tenantId, "price_list", String(list), null, e))
    .finally(() => inFlight.delete(id));
  inFlight.set(id, run);
}

/** What a configuration needs to know of its model's list: whether it was read, whether that read
 *  failed, how many prices it holds, and when they last changed (what makes a calculation stale). */
export type PriceState = { fetchedAt: Date | null; changedAt: Date | null; error: string | null; rows: number };

export async function priceState(tenantId: string, list: number | undefined): Promise<PriceState | null> {
  if (!list) return null;
  const e = await entry<RowsHeader>(tenantId, "price_list", String(list));
  if (!e) return null;
  return {
    fetchedAt: e.fetchedAt, error: e.error, rows: e.data?.rows ?? 0,
    changedAt: e.data?.changedAt ? new Date(e.data.changedAt) : null,
  };
}
