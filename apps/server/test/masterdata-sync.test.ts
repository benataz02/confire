import { afterAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { db, configMasterdata, configMasterdataRow } from "@confire/db";
import { pageRows, rowCache, syncMasterdata } from "../src/masterdata-sync.ts";
import type { MasterdataQueryRow, QueryRunner } from "../src/lookups.ts";

// The sync walks a B1 read page by page and inserts as it goes — there is no maxPages cap, so the
// two things that can go wrong silently are a cursor that never ends and a half-written table.

const tenantId = `test-sync-${crypto.randomUUID()}`;

const seed = async (name: string): Promise<MasterdataQueryRow> => {
  const [r] = await db.insert(configMasterdata).values({
    tenantId, name, kind: "query",
    query: { target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"] },
  }).returning({ id: configMasterdata.id });
  return {
    id: r!.id, name, kind: "query", columns: [], rows: [],
    query: { target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"] },
  };
};

const cached = (id: string) =>
  db.select({ seq: configMasterdataRow.seq, row: configMasterdataRow.row })
    .from(configMasterdataRow)
    .where(and(eq(configMasterdataRow.tenantId, tenantId), eq(configMasterdataRow.masterdataId, id)))
    .orderBy(asc(configMasterdataRow.seq));

const state = async (id: string) =>
  (await db.select({ rowCount: configMasterdata.rowCount, syncError: configMasterdata.syncError, syncedAt: configMasterdata.syncedAt })
    .from(configMasterdata).where(eq(configMasterdata.id, id)))[0]!;

/** Pages of two, cursor advancing, last page without one — exactly what runnerFor emits. */
const paged = (codes: string[], onPage?: (skip: number) => void): QueryRunner => async (_t, _q, _c, opts) => {
  const skip = opts?.skip ?? 0;
  onPage?.(skip);
  const rows = codes.slice(skip, skip + 2).map((ItemCode) => ({ ItemCode }));
  return { rows, ...(skip + rows.length < codes.length ? { nextSkip: skip + rows.length } : {}) };
};

describe.skipIf(!process.env.DATABASE_URL)("syncMasterdata", () => {
  afterAll(async () => {
    await db.delete(configMasterdataRow).where(eq(configMasterdataRow.tenantId, tenantId));
    await db.delete(configMasterdata).where(eq(configMasterdata.tenantId, tenantId));
  });

  test("walks every page, keeps the read's order, and terminates", async () => {
    const md = await seed("walk");
    const skips: number[] = [];
    const { count } = await syncMasterdata(tenantId, md, paged(["A", "B", "C", "D", "E"], (s) => skips.push(s)));

    expect(count).toBe(5);
    expect(skips).toEqual([0, 2, 4]); // three pages, cursor advancing, then no nextSkip
    // `seq` is the read's order, which is what replays the query's own orderby on the way out.
    const rows = await cached(md.id);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(rows.map((r) => (r.row as { ItemCode: string }).ItemCode)).toEqual(["A", "B", "C", "D", "E"]);
    expect(await state(md.id)).toMatchObject({ rowCount: 5, syncError: null });
  });

  test("a resync replaces wholesale — the query is the source of truth", async () => {
    const md = await seed("replace");
    await syncMasterdata(tenantId, md, paged(["A", "B", "C"]));
    await syncMasterdata(tenantId, md, paged(["X"]));
    expect((await cached(md.id)).map((r) => (r.row as { ItemCode: string }).ItemCode)).toEqual(["X"]);
    expect((await state(md.id)).rowCount).toBe(1);
  });

  test("a failure mid-walk records the error and leaves the previous rows intact", async () => {
    const md = await seed("halfway");
    await syncMasterdata(tenantId, md, paged(["A", "B"]));

    const explodes: QueryRunner = async (_t, _q, _c, opts) =>
      (opts?.skip ?? 0) === 0
        ? { rows: [{ ItemCode: "N" }], nextSkip: 1 }
        : Promise.reject(new Error("agent unreachable"));
    await expect(syncMasterdata(tenantId, md, explodes)).rejects.toThrow("agent unreachable");

    // The delete and every insert share one transaction, so a walk that dies partway leaves the
    // last good sync in place rather than a table truncated at the page it reached.
    expect((await cached(md.id)).map((r) => (r.row as { ItemCode: string }).ItemCode)).toEqual(["A", "B"]);
    const s = await state(md.id);
    expect(s.syncError).toBe("agent unreachable");
    expect(s.rowCount).toBe(2); // still describing the rows that are actually there
  });

  test("an empty read is a legitimate answer, not a failure", async () => {
    const md = await seed("empty");
    const { count } = await syncMasterdata(tenantId, md, paged([]));
    expect(count).toBe(0);
    expect(await cached(md.id)).toEqual([]);
    expect((await state(md.id)).syncError).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("rowCache / pageRows", () => {
  afterAll(async () => {
    await db.delete(configMasterdataRow).where(eq(configMasterdataRow.tenantId, tenantId));
    await db.delete(configMasterdata).where(eq(configMasterdata.tenantId, tenantId));
  });

  test("pages in seq order and stops emitting a cursor at the end", async () => {
    const md = await seed("paging");
    await syncMasterdata(tenantId, md, paged(["A", "B", "C", "D", "E"]));

    const first = await pageRows(tenantId, md.id, { top: 2 });
    expect(first.rows.map((r) => r.ItemCode)).toEqual(["A", "B"]);
    expect(first.nextSkip).toBe(2);

    const last = await pageRows(tenantId, md.id, { skip: 4, top: 2 });
    expect(last.rows.map((r) => r.ItemCode)).toEqual(["E"]);
    expect(last.nextSkip).toBeUndefined();
  });

  test("search is case-insensitive over the named columns only", async () => {
    const md = await seed("search");
    await syncMasterdata(tenantId, md, paged(["Alpha", "beta", "GAMMA"]));
    const hit = await pageRows(tenantId, md.id, { search: "a", searchCols: ["ItemCode"] });
    expect(hit.rows.map((r) => r.ItemCode)).toEqual(["Alpha", "beta", "GAMMA"]);
    const one = await pageRows(tenantId, md.id, { search: "mm", searchCols: ["ItemCode"] });
    expect(one.rows.map((r) => r.ItemCode)).toEqual(["GAMMA"]);
    const none = await pageRows(tenantId, md.id, { search: "zz", searchCols: ["ItemCode"] });
    expect(none.rows).toEqual([]);
  });

  test("the cache resolves values by column, which is how an off-page pick is bound", async () => {
    const md = await seed("bycol");
    await syncMasterdata(tenantId, md, paged(["A", "B", "C"]));
    const rows = await rowCache(tenantId)(md.id, { col: "ItemCode", values: ["C"] });
    expect(rows.map((r) => r.ItemCode)).toEqual(["C"]);
  });
});
