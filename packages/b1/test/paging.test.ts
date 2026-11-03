import { describe, expect, test } from "bun:test";
import { DirectTransport, followPages, nextLinkOf, type B1Request } from "../src/index.ts";

// The Service Layer pages server-side at 20 rows unless asked otherwise, and that default is
// invisible: you get 20 rows and an @odata.nextLink, which looks exactly like a short last page to
// anyone inferring "there is more" from the row count. These lock in both halves of the fix.

const spy = () => {
  const calls: B1Request[] = [];
  const t = new DirectTransport(async (r) => {
    calls.push(r);
    return { status: 200, data: { value: [] } };
  });
  return { calls, t };
};

describe("Prefer: odata.maxpagesize", () => {
  test("asking for $top implies asking for a page that big — otherwise B1 answers with 20", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { top: 100 });
    expect(calls[0]!.path).toContain("$top=100");
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=100" });
  });

  test("an explicit maxPageSize wins over $top", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { top: 100, maxPageSize: 20 });
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=20" });
  });

  test("maxPageSize 0 disables server paging and is not confused with 'unset'", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { maxPageSize: 0 });
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=0" });
  });

  test("no $top and no maxPageSize sends no Prefer header at all", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Items", { select: ["ItemCode"] });
    expect(calls[0]!.headers).toBeUndefined();
  });

  test("readNext re-sends it — Prefer is per-request, so page 2 would otherwise drop to 20", async () => {
    const { calls, t } = spy();
    await t.readNext("Items?$skip=100", 100);
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=100" });
  });

  // A link outside the Service Layer is the agent's to refuse: apps/agent/allow_test.go.
});

describe("nextLinkOf is the 'there is more' signal", () => {
  test("reads both the v4 and v3 spellings, and ignores an empty one", () => {
    expect(nextLinkOf({ value: [], "@odata.nextLink": "Items?$skip=20" })).toBe("Items?$skip=20");
    expect(nextLinkOf({ value: [], "odata.nextLink": "Items?$skip=20" })).toBe("Items?$skip=20");
    expect(nextLinkOf({ value: [] })).toBeUndefined();
    expect(nextLinkOf({ value: [], "@odata.nextLink": "" })).toBeUndefined();
  });

  test("a full page that is genuinely the last one has no nextLink — the row count cannot tell", () => {
    // 20 rows returned for $top=20 used to mean "probably more"; B1 says otherwise.
    expect(nextLinkOf({ value: new Array(20).fill({}) })).toBeUndefined();
  });
});

describe("$apply", () => {
  test("an entity set read carries $apply after $filter, the value encoded like $filter", async () => {
    const { calls, t } = spy();
    await t.readEntitySet("Orders", { apply: "groupby((CardCode),aggregate(DocTotal with sum as a0))", maxPageSize: 500 });
    expect(calls[0]!.path).toBe(`Orders?$apply=${encodeURIComponent("groupby((CardCode),aggregate(DocTotal with sum as a0))")}`);
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=500" });
  });

  test("a crossjoin carries $apply and pages with Prefer", async () => {
    const { calls, t } = spy();
    await t.crossJoin({ entities: ["Orders", "Orders/DocumentLines"], expand: [], apply: "aggregate($count as n)", maxPageSize: 500 });
    expect(calls[0]!.path).toBe(`$crossjoin(Orders,Orders/DocumentLines)?$apply=${encodeURIComponent("aggregate($count as n)")}`);
    expect(calls[0]!.headers).toEqual({ Prefer: "odata.maxpagesize=500" });
  });
});

describe("followPages", () => {
  test("follows every nextLink from a first page it did not read, and stops at maxPages", async () => {
    const pages = [{ value: [{ i: 2 }], "@odata.nextLink": "Orders?$skip=2" }, { value: [{ i: 3 }] }];
    const t = new DirectTransport(async () => ({ status: 200, data: pages.shift() }));
    const first = { status: 200, data: { value: [{ i: 1 }], "@odata.nextLink": "Orders?$skip=1" } };
    expect(await followPages(t, first, { pageSize: 1, maxPages: 10 })).toEqual({ rows: [{ i: 1 }, { i: 2 }, { i: 3 }], truncated: false });
    const capped = await followPages(t, { status: 200, data: { value: [{ i: 1 }], "@odata.nextLink": "x" } }, { pageSize: 1, maxPages: 1 });
    expect(capped.truncated).toBe(true);
  });
});
