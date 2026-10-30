import { displayColumns, refKeyCols, type LookupRef, type ResolvedTable } from "@confire/config-engine";
import type { CflDialogConfig, Row } from "../types.ts";

// CflConfigsService: one factory per entity a value help can pick from. Each returns a literal and
// spreads `overrides` last, so a call site adjusts behaviour without a second factory
// (`cfl.items({ multiSelect: true })`). Search fields must be text fields — the server refuses a
// number there — so a numeric key (PriceListNo) is searched through its name instead.

/** The key everything uses: what is stored, probed, deduplicated and filtered on. Without
 *  `keyField`, the first column IS the key — so a config that puts a decorative column first must
 *  name its key. */
export const keyFieldOf = (d: Pick<CflDialogConfig, "keyField" | "columns">): string =>
  d.keyField ?? d.columns[0]?.key ?? "";

/** N(): multi-select tokens (row objects) -> the key values a filter or a URL carries. */
export const tokensToKeys = (tokens: Row[], d: Pick<CflDialogConfig, "keyField" | "columns">): (string | number)[] => {
  const k = keyFieldOf(d);
  return tokens
    .map((t) => t[k])
    .filter((v): v is string | number => (typeof v === "string" && v.trim() !== "") || typeof v === "number")
    .map((v) => (typeof v === "string" ? v.trim() : v));
};

/** C()'s other half: keys back to tokens, `{[keyField]: key}`, for a filter read from a URL or a view. */
export const keysToTokens = (keys: unknown, d: Pick<CflDialogConfig, "keyField" | "columns">): Row[] => {
  const k = keyFieldOf(d);
  return (Array.isArray(keys) ? keys : keys === null || keys === undefined || keys === "" ? [] : [keys])
    .map((v) => ({ [k]: v }));
};

/** A token's text: `displayField`, else the key. */
export const tokenLabel = (row: Row, d: Pick<CflDialogConfig, "keyField" | "columns" | "displayField">): string =>
  String(row[d.displayField ?? keyFieldOf(d)] ?? row[keyFieldOf(d)] ?? "");

type Overrides = Partial<CflDialogConfig>;

/** Which model's query table a configurator value help pages. */
export type QueryScope = { modelId: string };

export const cfl = {
  /** Customers only — CardType is fixed on every read, probe included. */
  customers: (o: Overrides = {}): CflDialogConfig => ({
    title: "Business partner",
    source: { kind: "entity", entitySet: "BusinessPartners" },
    route: "/b1/BusinessPartners",
    keyField: "CardCode",
    fixedFilters: [{ field: "CardType", op: "eq", value: "cCustomer" }],
    columns: [
      { key: "CardCode", width: 140 },
      { key: "CardName" },
      { key: "City", hidden: true },
    ],
    searchFields: ["CardCode", "CardName"],
    ...o,
  }),

  businessPartners: (o: Overrides = {}): CflDialogConfig => ({
    title: "Business partner",
    source: { kind: "entity", entitySet: "BusinessPartners" },
    route: "/b1/BusinessPartners",
    keyField: "CardCode",
    columns: [
      { key: "CardCode", width: 140 },
      { key: "CardName" },
      { key: "CardType" },
    ],
    searchFields: ["CardCode", "CardName"],
    ...o,
  }),

  items: (o: Overrides = {}): CflDialogConfig => ({
    title: "Item",
    source: { kind: "entity", entitySet: "Items" },
    route: "/b1/Items",
    keyField: "ItemCode",
    columns: [
      { key: "ItemCode", width: 160 },
      { key: "ItemName" },
      { key: "ItemsGroupCode", hidden: true },
    ],
    searchFields: ["ItemCode", "ItemName"],
    ...o,
  }),

  priceLists: (o: Overrides = {}): CflDialogConfig => ({
    title: "Price list",
    source: { kind: "entity", entitySet: "PriceLists" },
    keyField: "PriceListNo",
    displayColumns: ["PriceListName"],
    columns: [
      { key: "PriceListNo", width: 90 },
      { key: "PriceListName" },
    ],
    searchFields: ["PriceListName"],
    ...o,
  }),

  currencies: (o: Overrides = {}): CflDialogConfig => ({
    title: "Currency",
    source: { kind: "entity", entitySet: "Currencies" },
    keyField: "Code",
    columns: [
      { key: "Code", width: 90 },
      { key: "Name" },
    ],
    searchFields: ["Code", "Name"],
    ...o,
  }),

  /** SAP's languages (OLNG): `BusinessPartners.LanguageCode` points at `Code`. */
  userLanguages: (o: Overrides = {}): CflDialogConfig => ({
    title: "Language",
    source: { kind: "entity", entitySet: "UserLanguages" },
    keyField: "Code",
    displayColumns: ["LanguageFullName"],
    columns: [
      { key: "Code", width: 90 },
      { key: "LanguageShortName", width: 90 },
      { key: "LanguageFullName" },
    ],
    searchFields: ["LanguageFullName"],
    ...o,
  }),

  warehouses: (o: Overrides = {}): CflDialogConfig => ({
    title: "Warehouse",
    source: { kind: "entity", entitySet: "Warehouses" },
    keyField: "WarehouseCode",
    columns: [
      { key: "WarehouseCode", width: 120 },
      { key: "WarehouseName" },
    ],
    searchFields: ["WarehouseCode", "WarehouseName"],
    ...o,
  }),

  salesPersons: (o: Overrides = {}): CflDialogConfig => ({
    title: "Sales employee",
    source: { kind: "entity", entitySet: "SalesPersons" },
    keyField: "SalesEmployeeCode",
    displayColumns: ["SalesEmployeeName"],
    columns: [
      { key: "SalesEmployeeCode", width: 90 },
      { key: "SalesEmployeeName" },
    ],
    searchFields: ["SalesEmployeeName"],
    ...o,
  }),

  /**
   * A configurator query table. Key and label are the ref's convention (refKeyCols: 1st column,
   * 2nd column) against the masterdata row's own column list; the dialog's headers and hidden
   * columns come from that row too. Label mode unless the caller wants the key shown (`showValue`
   * — an items grid, whose stored code is what rides to SAP).
   */
  masterdataQuery: (
    scope: QueryScope, ref: LookupRef, canonical: ResolvedTable | undefined,
    o: Overrides & { showValue?: boolean } = {},
  ): CflDialogConfig => {
    const { showValue, ...rest } = o;
    const table = ref.source === "manual" ? "" : ref.table;
    const cols = canonical?.columns ?? [];
    const { valueCol, labelCol } = refKeyCols(ref, cols);
    // The parameter's "Columns shown" (ref.columns) starts the rest hidden; every column is still
    // fetched (CflDialog's select) and offered in the dialog's settings.
    const shown = new Set([valueCol, labelCol, ...displayColumns(ref, cols)]);
    return {
      title: table,
      source: { kind: "masterdata", modelId: scope.modelId, table },
      keyField: valueCol,
      ...(labelCol && !showValue ? { displayColumns: [labelCol] } : {}),
      columns: (cols.length ? cols : [valueCol]).map((c) => ({
        key: c,
        label: canonical?.labels?.[c] || c,
        ...(canonical?.hidden?.includes(c) || !shown.has(c) ? { hidden: true } : {}),
      })),
      searchFields: [valueCol, labelCol].filter((c): c is string => !!c),
      // A masterdata page can search and match a key, nothing else — no per-column filters.
      showAdaptFilters: false,
      ...rest,
    };
  },
};
