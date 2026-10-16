import { expect, test } from "bun:test";
import {
  buildPool, decodeFilters, defaultState, encodeFilters, mergeKnownColumns, pickInitial, resolveListState,
  sameState, systemViewsOf, toQuery, type View,
} from "./views.ts";
import type { FilterField, ListColumn, ViewState } from "./types.ts";

const COLUMNS: ListColumn[] = [
  { key: "DocNum", type: "number" },
  { key: "CardCode", type: "string" },
  { key: "DocDate", type: "date" },
  { key: "Status", type: "enum", options: [{ value: "O", label: "Open" }, { value: "C", label: "Closed" }] },
  { key: "Remarks", type: "string", hidden: true },
];
const FIELDS: FilterField[] = [
  { key: "DocNum", exact: true },
  { key: "CardCode", cfl: { dialogConfig: { title: "BP", source: { kind: "entity", entitySet: "BusinessPartners" }, columns: [{ key: "CardCode" }], searchFields: ["CardCode"] } } },
];
const POOL = buildPool(FIELDS, COLUMNS);
const state = (over: Partial<ViewState> = {}): ViewState => ({ ...defaultState(COLUMNS, POOL), ...over });

test("buildPool: declared filters first, every other column a hidden auto filter", () => {
  expect(POOL.map((f) => [f.key, f.visible])).toEqual([
    ["DocNum", undefined], ["CardCode", undefined], ["DocDate", false], ["Status", false], ["Remarks", false],
  ]);
  expect(POOL.find((f) => f.key === "DocDate")?.type).toBe("date"); // typed by its column
});

test("toQuery: range ge/lt-next-day, list in, typed eq, string contains or exact eq", () => {
  const q = toQuery(state({
    filterValues: {
      DocNum: 42, CardCode: ["C1", "C2"], DocDate: { from: "2026-01-01", to: "2026-01-31" },
      Status: ["O"], Remarks: "rush",
    },
    searchTerm: "  acme ",
  }), POOL);
  expect(q.filter).toEqual([
    { field: "DocNum", op: "eq", value: 42 },
    { field: "CardCode", op: "in", value: ["C1", "C2"] },
    { field: "DocDate", op: "ge", value: "2026-01-01" },
    { field: "DocDate", op: "lt", value: "2026-02-01" },
    { field: "Status", op: "in", value: ["O"] },
    { field: "Remarks", op: "contains", value: "rush" },
  ]);
  expect(q.search).toBe("acme");
});

test("toQuery: select is the visible columns, sorted — a reorder is not a new query", () => {
  const a = toQuery(state({ columns: ["DocNum", "CardCode"] }), POOL);
  const b = toQuery(state({ columns: ["CardCode", "DocNum"] }), POOL);
  expect(a.select).toEqual(b.select);
  expect(toQuery(state({ sortBy: [{ field: "DocNum", direction: "desc" }] }), POOL).orderby)
    .toEqual([{ field: "DocNum", dir: "desc" }]);
});

test("empty filters are no filters", () => {
  expect(toQuery(state({ filterValues: { CardCode: [], DocDate: { from: "", to: "" }, DocNum: "" } }), POOL).filter).toEqual([]);
});

test("URL codec round trip: ranges a~b, lists a,b, the search term, defaults left out", () => {
  const s = state({ filterValues: { CardCode: ["C1", "C2"], DocDate: { from: "2026-01-01", to: "2026-01-31" }, DocNum: 7 }, searchTerm: "acme" });
  const url = encodeFilters(s, POOL);
  expect(url).toEqual({ CardCode: "C1,C2", DocDate: "2026-01-01~2026-01-31", DocNum: 7, search: "acme" });
  const back = decodeFilters(url, POOL);
  expect(back).toEqual({ filterValues: s.filterValues, searchTerm: "acme" });
  // keys match case-insensitively, and nothing in the URL is "no URL"
  expect(decodeFilters({ cardcode: "C9" }, POOL)?.filterValues).toEqual({ CardCode: ["C9"] });
  expect(decodeFilters({ unrelated: "x" }, POOL)).toBeNull();
});

test("a leading-zero key stays a string in the URL", () => {
  const fields = buildPool([{ key: "ItemCode" }], [{ key: "ItemCode", type: "string" }]);
  expect(encodeFilters({ filterValues: { ItemCode: "0001" }, searchTerm: "" }, fields)).toEqual({ ItemCode: "0001" });
});

test("mergeKnownColumns: a column added since the save slots in after its neighbour", () => {
  const cols: ListColumn[] = [{ key: "A" }, { key: "B" }, { key: "New" }, { key: "C" }, { key: "Hidden", hidden: true }];
  expect(mergeKnownColumns(["C", "A", "B"], ["A", "B", "C"], cols)).toEqual(["C", "A", "B", "New"]);
  // a column the user hid on purpose (known) stays hidden; a dropped one goes
  expect(mergeKnownColumns(["A", "Gone"], ["A", "B", "C", "Gone"], cols)).toEqual(["A", "New"]);
});

test("resolveListState: a partial system view overrides only what it names", () => {
  const r = resolveListState({ filterValues: { Status: ["O"], Bogus: "x" } }, COLUMNS, POOL);
  expect(r.columns).toEqual(["DocNum", "CardCode", "DocDate", "Status"]);
  expect(r.filterValues).toEqual({ Status: ["O"] }); // unknown keys dropped (M())
  expect(r.adaptFilterKeys).toEqual(["DocNum", "CardCode"]);
});

test("sameState ignores jsonb key order and empty objects, not array order", () => {
  const written = { sortBy: [{ field: "DocNum", direction: "desc" }], columnWidths: {} };
  const fromPostgres = JSON.parse('{"sortBy": [{"direction": "desc", "field": "DocNum"}]}');
  expect(JSON.stringify(written)).not.toBe(JSON.stringify(fromPostgres));
  expect(sameState(written, fromPostgres)).toBe(true);
  expect(sameState({ columns: ["a", "b"] }, { columns: ["b", "a"] })).toBe(false);
});

test("system views: Standard first unless declared; the active id, then defaults, pick the view", () => {
  const sys = systemViewsOf<ViewState>([{ key: "open", name: "Open", state: {} }]);
  expect(sys.map((v) => v.id)).toEqual(["system:default", "system:open"]);
  expect(systemViewsOf<ViewState>([{ key: "default", name: "Mine", state: null }]).map((v) => v.name)).toEqual(["Mine"]);

  const mine: View<ViewState> = { id: "p", name: "P", visibility: "personal", isDefault: true, canEdit: true, state: null };
  const shared: View<ViewState> = { id: "s", name: "S", visibility: "shared", isDefault: true, canEdit: false, state: null };
  expect(pickInitial([...sys, shared, mine], "system:open").id).toBe("system:open");
  expect(pickInitial([...sys, shared, mine], null).id).toBe("p");
  expect(pickInitial([...sys, shared], "deleted").id).toBe("s");
  expect(pickInitial(sys, null).id).toBe("system:default");
});
