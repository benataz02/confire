import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db, sapCache, sapConnection } from "@confire/db";
import {
  cached, entry, fail, fill, forget, isFresh, put, rows, PARSER_EPOCH, type CacheEntry, type RowsHeader,
} from "../src/sap-cache.ts";
import { adoptCompany } from "../src/b1.ts";

// The one SAP cache (spec 2026-11-09): seq 0 is the entry, a many-row entry's rows are seq 1..n, and
// an entry of another company than the tenant's is no entry.

const tenants: string[] = [];
const tenant = async (companyDb?: string | null) => {
  const tenantId = `test-cache-${crypto.randomUUID()}`;
  tenants.push(tenantId);
  if (companyDb !== undefined) await db.insert(sapConnection).values({ tenantId, agentUrl: "http://x", secret: "x", companyDb });
  return tenantId;
};
const raw = (tenantId: string) => db.select().from(sapCache).where(eq(sapCache.tenantId, tenantId));
async function* pages(...ps: Record<string, unknown>[][]) { for (const p of ps) yield p; }
const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));

describe.skipIf(!process.env.DATABASE_URL)("sap-cache", () => {
  afterAll(async () => {
    setSystemTime();
    await db.delete(sapCache).where(inArray(sapCache.tenantId, tenants));
    await db.delete(sapConnection).where(inArray(sapConnection.tenantId, tenants));
  });

  test("a fresh entry is served without loading; concurrent misses load once", async () => {
    const t = await tenant("A");
    let loads = 0;
    const load = async () => { loads++; await Bun.sleep(5); return { company: "A", data: { Quotations: 1 } }; };
    expect(await Promise.all([1, 2, 3].map(() => cached(t, "open_counts", "", load)))).toEqual([{ Quotations: 1 }, { Quotations: 1 }, { Quotations: 1 }]);
    expect(loads).toBe(1);
    expect(await cached(t, "open_counts", "", load)).toEqual({ Quotations: 1 });
    expect(loads).toBe(1);
    await cached(t, "open_counts", "", load, { lifetimeMs: 0 });
    expect(loads).toBe(2);
  });

  test("a failed load writes nothing, and the next call loads again", async () => {
    const t = await tenant("A");
    let loads = 0;
    const load = async (): Promise<{ company: string; data: string }> => { loads++; throw new Error("agent down"); };
    expect(cached(t, "currency", "", load)).rejects.toThrow("agent down");
    await Bun.sleep(1);
    expect(await entry(t, "currency", "")).toBeNull();
    await cached(t, "currency", "", load).catch(() => {});
    expect(loads).toBe(2);
  });

  test("an entry of another company is no entry", async () => {
    const t = await tenant("B");
    await put(t, "currency", [{ key: "", data: "EUR" }], { company: "A" });
    expect(await entry(t, "currency", "")).toBeNull();
  });

  test("an entry written under no company reads back for a tenant with none", async () => {
    const t = await tenant();
    await put(t, "currency", [{ key: "", data: "EUR" }], { company: null });
    expect((await entry<string>(t, "currency", ""))?.data).toBe("EUR");
  });

  test("fill streams pages into seq 1..n in order; the same rows keep changedAt, new rows move it", async () => {
    const t = await tenant("A");
    try {
      expect(await fill(t, "masterdata", "k", "A", pages([{ c: "A" }, { c: "B" }], [{ c: "C" }]))).toEqual({ rows: 3, changed: true });
      expect((await rows(t, "masterdata", "k")).map((r) => r.c)).toEqual(["A", "B", "C"]);
      const first = (await entry<RowsHeader>(t, "masterdata", "k"))!;
      expect(first.data).toMatchObject({ rows: 3 });

      later(1000);
      expect(await fill(t, "masterdata", "k", "A", pages([{ c: "A" }, { c: "B" }], [{ c: "C" }]))).toEqual({ rows: 3, changed: false });
      const same = (await entry<RowsHeader>(t, "masterdata", "k"))!;
      expect(same.data!.changedAt).toBe(first.data!.changedAt);
      expect(same.fetchedAt!.getTime()).toBeGreaterThan(first.fetchedAt!.getTime());

      later(1000);
      expect(await fill(t, "masterdata", "k", "A", pages([{ c: "D" }]))).toEqual({ rows: 1, changed: true });
      expect((await entry<RowsHeader>(t, "masterdata", "k"))!.data!.changedAt).not.toBe(first.data!.changedAt);
    } finally {
      setSystemTime();
    }
  });

  test("a failed fill keeps the previous rows and records the error", async () => {
    const t = await tenant("A");
    await fill(t, "masterdata", "k", "A", pages([{ c: "A" }]));
    const before = (await entry(t, "masterdata", "k"))!;
    async function* broken() { yield [{ c: "X" }]; throw new Error("agent down"); }
    expect(fill(t, "masterdata", "k", "A", broken())).rejects.toThrow("agent down");
    await Bun.sleep(50);
    expect((await rows(t, "masterdata", "k")).map((r) => r.c)).toEqual(["A"]);
    const after = (await entry(t, "masterdata", "k"))!;
    expect(after.error).toBe("agent down");
    expect(after.fetchedAt).toEqual(before.fetchedAt);
  });

  test("a failed first fill leaves an entry carrying only its error", async () => {
    const t = await tenant("A");
    await fail(t, "masterdata", "k", "A", new Error("no agent"));
    expect(await entry(t, "masterdata", "k")).toEqual({ data: null, company: "A", fetchedAt: null, error: "no agent" } satisfies CacheEntry);
  });

  test("rows filters, searches and pages in seq order", async () => {
    const t = await tenant("A");
    await fill(t, "masterdata", "k", "A", pages([
      { code: "A1", name: "Steel", grp: "m" }, { code: "B2", name: "steel wire", grp: "w" },
      { code: "C3", name: "Copper", grp: "m" }, { code: "D4", name: "Brass", grp: "m" },
    ]));
    const codes = (rs: Record<string, unknown>[]) => rs.map((r) => r.code);
    expect(codes(await rows(t, "masterdata", "k", { col: "code", values: ["C3", "A1"] }))).toEqual(["A1", "C3"]);
    expect(codes(await rows(t, "masterdata", "k", { col: "code", values: ["A1", "B2"], where: { col: "grp", values: ["m"] } }))).toEqual(["A1"]);
    expect(codes(await rows(t, "masterdata", "k", { search: "STEEL", searchCols: ["name"] }))).toEqual(["A1", "B2"]);
    expect(codes(await rows(t, "masterdata", "k", { search: "A1", searchCols: ["name"] }))).toEqual([]);
    expect(codes(await rows(t, "masterdata", "k", { top: 2, skip: 1 }))).toEqual(["B2", "C3"]);
  });

  test("rows of an entry whose company is not the tenant's are not served", async () => {
    const t = await tenant("A");
    await fill(t, "masterdata", "k", "A", pages([{ c: "A" }]));
    await db.update(sapConnection).set({ companyDb: "B" }).where(eq(sapConnection.tenantId, t));
    expect(await rows(t, "masterdata", "k")).toEqual([]);
    expect(await entry(t, "masterdata", "k")).toBeNull();
  });

  test("two fills of one entry at once both finish, leaving one set", async () => {
    const t = await tenant("A");
    const results = await Promise.all([
      fill(t, "masterdata", "k", "A", pages([{ c: 1 }, { c: 2 }], [{ c: 3 }])),
      fill(t, "masterdata", "k", "A", pages([{ c: 9 }])),
    ]);
    expect(results.map((r) => r.rows).sort()).toEqual([1, 3]);
    const left = await db.select().from(sapCache)
      .where(and(eq(sapCache.tenantId, t), eq(sapCache.kind, "masterdata"), eq(sapCache.key, "k"), gte(sapCache.seq, 1)));
    expect([1, 3]).toContain(left.length);
  });

  test("a company switch adopted while a refill is mid-walk does not wait on it", async () => {
    // The 409 path: a page read answers COMPANY_CHANGED and awaits adoptCompany while the fill's
    // transaction still holds the rows it deleted.
    const t = await tenant("A");
    await fill(t, "masterdata", "k", "A", pages([{ c: 1 }]));
    let adopted: unknown;
    async function* walk() {
      yield [{ c: 2 }];
      adopted = await Promise.race([adoptCompany(t, "B"), Bun.sleep(2000).then(() => "blocked")]);
      throw new Error("COMPANY_CHANGED");
    }
    expect(fill(t, "masterdata", "k", "A", walk())).rejects.toThrow("COMPANY_CHANGED");
    await Bun.sleep(2100);
    expect(adopted).toBe(true);
    expect(await rows(t, "masterdata", "k")).toEqual([]);
  });

  test("a fill waiting on a failing one finishes, its fresh entry clear of that failure", async () => {
    const t = await tenant("A");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* failing() { yield [{ c: 1 }]; await gate; throw new Error("agent down"); }
    const a = fill(t, "masterdata", "k", "A", failing());
    const aDone = a.catch(() => {});
    await Bun.sleep(50); // A holds the entry's lock
    async function* ok() { yield [{ c: 2 }]; await aDone; } // A's failure is recorded before B ends
    const b = fill(t, "masterdata", "k", "A", ok());
    await Bun.sleep(50);
    release();
    expect(await b).toEqual({ rows: 1, changed: true });
    expect(await entry(t, "masterdata", "k")).toMatchObject({ error: null });
  });

  test("a failure older than the entry's last good read is not stamped on it", async () => {
    const t = await tenant("A");
    const attempt = new Date(Date.now() - 1000);
    await fill(t, "masterdata", "k", "A", pages([{ c: 1 }]));
    await fail(t, "masterdata", "k", "A", new Error("late"), attempt);
    expect((await entry(t, "masterdata", "k"))!.error).toBeNull();
  });

  test("forget by tenant, by kind, by keys", async () => {
    const t = await tenant("A");
    await put(t, "schema", [{ key: "Items", data: {} }, { key: "Orders", data: {} }], { company: "A" });
    await put(t, "currency", [{ key: "", data: "EUR" }], { company: "A" });
    await fill(t, "masterdata", "k", "A", pages([{ c: 1 }]));
    await forget(t, { kind: "schema", keys: ["Items"] });
    expect((await raw(t)).map((r) => `${r.kind}:${r.key}:${r.seq}`).sort()).toEqual(["currency::0", "masterdata:k:0", "masterdata:k:1", "schema:Orders:0"]);
    await forget(t, { kind: "masterdata" });
    expect((await raw(t)).map((r) => r.kind).sort()).toEqual(["currency", "schema"]);
    await forget(t);
    expect(await raw(t)).toEqual([]);
  });
});

describe("isFresh", () => {
  const at = (fetchedAt: Date | null): CacheEntry => ({ data: 1, company: null, fetchedAt, error: null });
  test("absent or never read is stale", () => {
    expect(isFresh("currency", null)).toBe(false);
    expect(isFresh("currency", at(null))).toBe(false);
  });
  test("a schema parsed before the parser epoch is stale, after it fresh", () => {
    expect(isFresh("schema", at(new Date(PARSER_EPOCH - 1)))).toBe(false);
    expect(isFresh("schema", at(new Date(PARSER_EPOCH + 1)))).toBe(true);
  });
  test("forever kinds are fresh at any age; a lifetime elapses", () => {
    expect(isFresh("currency", at(new Date(0)))).toBe(true);
    expect(isFresh("print_layout", at(new Date(Date.now() - 2 * 3600_000 + 1000)))).toBe(true);
    expect(isFresh("print_layout", at(new Date(Date.now() - 2 * 3600_000 - 1)))).toBe(false);
  });
  test("an explicit lifetime wins over the kind's", () => {
    expect(isFresh("currency", at(new Date(Date.now() - 61_000)), 60_000)).toBe(false);
    expect(isFresh("print_layout", at(new Date(Date.now() - 3 * 3600_000)), null)).toBe(true);
  });
});
