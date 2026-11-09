import { createHash } from "node:crypto";
import { B1Error, COMPANY_CHANGED, rowsOf, type B1Transport } from "@confire/b1";
import { tenantConnector } from "./b1.ts";
import { cached, entry } from "./sap-cache.ts";

// The home's open-document counts, one per SAP document tile. A `$count` over a document set takes
// SAP seconds, and the agent's one session answers one call at a time, so the four of them held every
// other SAP call behind them for half a minute. Instead one stored SQL query counts all four in one
// call, and its answer is kept in sap_cache for the whole workspace for ten minutes.

/** Entity set → its header table and the ObjType B1 writes on every row of that table. Open is
 *  DocStatus 'O', which is what the tile's list filters on (`DocumentStatus eq 'bost_Open'`). */
const DOCS: Record<string, { table: string; objType: string }> = {
  Quotations: { table: "OQUT", objType: "23" },
  Orders: { table: "ORDR", objType: "17" },
  DeliveryNotes: { table: "ODLN", objType: "15" },
  Invoices: { table: "OINV", objType: "13" },
};

/** No literal in the select list: each table's ObjType says which count is which. A table with no
 *  open document returns no row, and that set's count is 0. */
export const OPEN_COUNTS_SQL = Object.values(DOCS)
  .map((d) => `SELECT ObjType, COUNT(DocEntry) AS Cnt FROM ${d.table} WHERE DocStatus = 'O' GROUP BY ObjType`)
  .join(" UNION ");

/** The code is derived from the text, so a changed query is a new entry and never an edit to one that
 *  an older server is still running. ponytail: superseded entries stay in SAP. Delete them by hand if
 *  they ever pile up. */
export const OPEN_COUNTS_CODE = `CF_OC_${createHash("sha1").update(OPEN_COUNTS_SQL).digest("hex").slice(0, 8)}`;

/** By entity set. Column names are matched case-insensitively, because HANA may upper-case them. */
export function countsOf(rows: Record<string, unknown>[]): Record<string, number> {
  const col = (r: Record<string, unknown>, name: string) => r[Object.keys(r).find((k) => k.toLowerCase() === name) ?? name];
  const byType = new Map(rows.map((r) => [String(col(r, "objtype")), Number(col(r, "cnt"))]));
  return Object.fromEntries(Object.entries(DOCS).map(([set, d]) => [set, byType.get(d.objType) ?? 0]));
}

/** The stored query, created the first time a company is asked. It needs no agent update: the
 *  allowlist passes any GET and a POST to one segment. */
async function bySql(b1: B1Transport): Promise<Record<string, number>> {
  try {
    return countsOf(rowsOf((await b1.sqlQuery(OPEN_COUNTS_CODE)).data));
  } catch (e) {
    // ponytail: unverified (spec §16): that a missing entry answers 404.
    if (!(e instanceof B1Error && e.status === 404)) throw e;
  }
  await b1.createEntity("SQLQueries", { SqlCode: OPEN_COUNTS_CODE, SqlName: "Confire: open documents", SqlText: OPEN_COUNTS_SQL }, { prefer: "no-content" });
  return countsOf(rowsOf((await b1.sqlQuery(OPEN_COUNTS_CODE)).data));
}

/** The old way, one `$count` per set, for a SAP that refuses the SQL query: a user without the SQL
 *  query authorization, a table missing from b1s_sqltable.conf, or a B1 older than 10.0 FP 2011. */
async function byCount(b1: B1Transport): Promise<Record<string, number>> {
  return Object.fromEntries(await Promise.all(Object.keys(DOCS).map(async (set) => {
    const { data } = await b1.readEntitySet(set, { filter: "DocumentStatus eq 'bost_Open'", select: ["DocEntry"], count: true, maxPageSize: 1 });
    return [set, Number((data as Record<string, unknown> | null)?.["@odata.count"] ?? 0)] as const;
  })));
}

/** SAP turned the query down (4xx). Not a company switch, and not an agent that is down: in those
 *  cases the `$count` reads would fail the same way. */
const refused = (e: unknown) => e instanceof B1Error && e.status >= 400 && e.status < 500 && e.code !== COMPANY_CHANGED;

async function read(tenantId: string): Promise<{ company: string | null; data: Record<string, number> }> {
  const conn = await tenantConnector(tenantId);
  const counts = await bySql(conn.b1).catch((e: unknown) => {
    if (!refused(e)) throw e;
    console.warn(`[open-counts] ${tenantId}: SQL query refused, counting per set:`, e instanceof Error ? e.message : e);
    return byCount(conn.b1);
  });
  // Under the company the call carried (`Connector.companyDb`), not a second read of it.
  return { company: conn.companyDb, data: counts };
}

/** The counts while they are fresh (10 min, sap-cache.ts LIFETIME_MS) and of the agent's current
 *  company. Otherwise SAP is read once, and every caller asking meanwhile shares that one read. If
 *  SAP fails, the last counts of the same company are better than none. */
export async function openCounts(tenantId: string): Promise<Record<string, number>> {
  try {
    return await cached(tenantId, "open_counts", "", () => read(tenantId));
  } catch (e) {
    const last = e instanceof B1Error && e.code === COMPANY_CHANGED ? null : await entry<Record<string, number>>(tenantId, "open_counts", "");
    if (last?.data) return last.data;
    throw e;
  }
}
