import { z } from "zod";

export type Val = number | string | boolean | null | string[];

export const ValZ = z.union([z.number(), z.string(), z.boolean(), z.null()]);
/** User-entry value: scalar Val, or string[] for multicombo params. */
export const EntriesZ = z.record(z.string(), z.union([ValZ, z.array(z.string())]));

/** Both named sources carry the same fields: the ref names a tenant masterdata table and takes its
 *  key and label columns by convention (refKeyCols). `source` only mirrors that row's kind — rows
 *  maintained here resolve whole, a query pages a live read — so the builder reads it off the
 *  picked table rather than asking. The explicit columns stay accepted: a ref written before the
 *  convention keeps the columns it named. */
const namedSource = {
  table: z.string(),
  /** convention: absent = 1st declared column, label = 2nd (see refKeyCols) */
  valueCol: z.string().optional(),
  labelCol: z.string().optional(),
  /** extra columns shown in pickers; absent = all extra. Derived keys always use every extra column. */
  columns: z.array(z.string()).optional(),
  /** keep only the rows whose `col` holds one of `values` — one masterdata (all operations), each
   *  parameter its own rows of it. Compared as text, as the cache's SQL compares them. */
  where: z.object({ col: z.string(), values: z.array(ValZ).min(1) }).optional(),
};

export const LookupRefZ = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("manual"),
    options: z.array(z.object({ value: ValZ, label: z.string().optional() })),
  }),
  z.object({ source: z.literal("table"), ...namedSource }),
  z.object({ source: z.literal("query"), ...namedSource }),
]);
export type LookupRef = z.infer<typeof LookupRefZ>;

export const KeyZ = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "must be a valid identifier");

/** A live read, as data rather than as a URL string. `$select` is derived from the source's
 *  `columns` and deliberately not stored — one field fewer, and the two can never disagree.
 *  URL construction lives in packages/b1's query.ts and nowhere else. */
export const ODataQueryZ = z.object({
  entitySet: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an entity set name"),
  filter: z.string().optional(),
  orderby: z.string().optional(),
});
export type ODataQuery = z.infer<typeof ODataQueryZ>;

/** One named live source: where to read, what to read, and the column set it yields. */
export const QuerySourceZ = z.object({
  target: z.enum(["b1", "beas"]),
  query: ODataQueryZ,
  columns: z.array(z.string()),
});
export type QuerySource = z.infer<typeof QuerySourceZ>;

export const ParamZ = z.object({
  key: KeyZ,
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  // "select" is the advanced one (a value help over a query domain); "dropdown" is always a plain list.
  ui: z.enum(["input", "textarea", "dropdown", "select", "radio", "checkbox", "multicombo", "slider"]),
  domain: z
    .union([
      z.object({ kind: z.literal("options"), ref: LookupRefZ }),
      z.object({ kind: z.literal("range"), min: z.number(), max: z.number(), step: z.number().optional() }),
    ])
    .optional(),
  defaultExpr: z.string().optional(),
  visibleWhen: z.string().optional(),
  /** mandatory only while this holds — see `mandatory` */
  requiredWhen: z.string().optional(),
  /** per-unit cost of the field's current value, shown at its top-right — part of the unit cost
   *  (computeOutputs' `other`) */
  priceExpr: z.string().optional(),
  /** the quote waits for it (missingInputs, enforced by buildQuoteSeed): asterisk on the label,
   *  negative state while empty. A default that fills the field counts as an answer; a hidden
   *  field is never required. */
  mandatory: z.boolean().optional(),
  readonly: z.boolean().optional(),
  excludeFromDomains: z.boolean().optional(),
  unit: z.string().optional(),
  help: z.string().optional(),
});
export type Param = z.infer<typeof ParamZ>;

export const ConstraintZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("expr"),
    when: z.string().optional(),
    assert: z.string(),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("table"),
    params: z.array(KeyZ).min(2),
    rows: z.array(z.array(ValZ)),
    mode: z.enum(["allow", "forbid"]),
  }),
]);
export type Constraint = z.infer<typeof ConstraintZ>;

// No unit price here on purpose: a line names an item, and what that item costs is read live
// from `pricing.priceList` on every calculate (ResolvedLookups.prices). A stored price would be
// the one number in a configuration that is a snapshot — see the "nothing is snapshotted" rule.
export const BomLineZ = z.object({
  itemCode: z.string(), // expr -> a B1 item code
  // Plain text, not an expression: it is the item's name, filled from B1 when the line is picked.
  desc: z.string().optional(),
  condition: z.string().optional(), // expr -> boolean
  qty: z.string(), // expr, per finished unit; batch qty available as `qty`
});

export const OperationZ = z.object({
  // expr -> a Beas OperationId (spec 2026-11-08). Absent = a hand-written line with no catalog
  // link: every model saved before operations existed, and every line in a workspace without Beas.
  operationId: z.string().optional(),
  // Plain text; empty = the catalog's ResourceId for the evaluated operation.
  resource: z.string().optional(),
  // Plain text, not an expression, like BomLineZ.desc: what the operation does, for the salesperson.
  desc: z.string().optional(),
  condition: z.string().optional(),
  setupMin: z.string(), // expr, minutes per batch
  runMinPerUnit: z.string(), // expr, minutes per unit
  ratePerHour: z.string(), // expr, cost per hour
});

/** The names a linked routing line's setup, run and rate formulas may read: the operation's
 *  current catalog figures (ResolvedLookups.operations). Picking an operation writes them in, so
 *  the line follows Beas the way a BOM line follows the price list — never a copied number. */
export const OPERATION_VARS = ["beasSetup", "beasRun", "beasRate"] as const;

export const HistoryMappingZ = z.object({
  param: KeyZ,
  /** Set: `param` is a column of this table — the items grid — matched against every row; the best one counts. */
  table: KeyZ.optional(),
  column: z.string().min(1),
  match: z.enum(["exact", "closeness", "contains"]),
  weight: z.number().positive().default(1),
});
export type HistoryMapping = z.infer<typeof HistoryMappingZ>;

/** A mapping's key in `configs.similar`'s entries and values: the parameter's own, or
 *  `<table>.<column>` — a dot no KeyZ holds, so the two never collide. */
export const historyKey = (m: { param: string; table?: string }) => (m.table ? `${m.table}.${m.param}` : m.param);

/** What a mapping may name, by historyKey: every parameter and the items grid's typed columns. A
 *  formula column is left out — its value is computed per read, never in the row a match reads. */
export function historyFields(model: ModelDef): Map<string, { type: Param["type"]; label: string }> {
  const out = new Map(model.parameters.map((p) => [p.key, { type: p.type, label: p.label }]));
  const items = model.tables?.find((t) => t.role === "items");
  for (const c of items?.columns ?? [])
    if (c.cell.kind !== "formula") out.set(historyKey({ table: items!.key, param: c.key }), { type: c.type, label: c.label });
  return out;
}

/** One column of a config table. `cell` is what the salesperson sees: a plain field, a picker
 *  over the same LookupRef params use, or a value the model computes per row. */
export const TableColumnZ = z.object({
  key: KeyZ,
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  unit: z.string().optional(),
  /** every row needs a value here before the quote — see requiredColumn */
  required: z.boolean().optional(),
  cell: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("input") }),
    z.object({ kind: z.literal("options"), ref: LookupRefZ }),
    z.object({ kind: z.literal("formula"), expr: z.string() }),
  ]),
});
export type TableColumn = z.infer<typeof TableColumnZ>;

const TableBaseZ = {
  key: KeyZ,
  title: z.string(),
  columns: z.array(TableColumnZ).min(1),
};

/** The items grid's quantity column. Fixed, not a pointer field: every item row carries pieces,
 *  and a configurable name only ever bought a way for it to dangle. */
export const QTY_COL = "quantity";

/** The items grid's SAP item code column, fixed for the same reason as QTY_COL: every item row
 *  carries a code, so the document history matches on this column instead of a model setting
 *  naming some parameter — one less pointer that can go stale. */
export const ITEM_COL = "itemcode";

/** The items grid's description column — the quotation line's text. */
export const ITEM_NAME_COL = "itemname";

/** Code, name and quantity are what make a row a quotation line, so they are required whatever
 *  the column says; any other column only when the author ticks `required`. */
export const REQUIRED_ITEM_COLS = new Set([ITEM_COL, ITEM_NAME_COL, QTY_COL]);
export const requiredColumn = (t: TableDef, c: TableColumn): boolean =>
  !!c.required || (t.role === "items" && REQUIRED_ITEM_COLS.has(c.key));

/** The two money columns the items grid renders at runtime. Deliberately NOT `TableColumn`s: a
 *  model never declares them, so they take no room in the author's namespace and produce no
 *  `items_*` aggregate — and `evalTableRows` therefore ignores a stored one, which is what stops a
 *  hand-typed price feeding back into `basisExpr`. `COST_COL` is display only and never written;
 *  `PRICE_COL` is the one cell a salesperson may store, and storing it means "I typed over the
 *  split", exactly like an override on a formula column. */
export const COST_COL = "unitcost";
export const PRICE_COL = "unitprice";

/** `calc` feeds sums into the model's formulas. `items` does that too, and additionally becomes
 *  n quotation lines: merge production is 1 config, 1 BOM, 1 routing, n items. */
export const TableDefZ = z.discriminatedUnion("role", [
  z.object({
    ...TableBaseZ,
    role: z.literal("calc"),
    minRows: z.number().int().nonnegative().optional(),
    maxRows: z.number().int().positive().optional(),
  }),
  z.object({
    ...TableBaseZ,
    role: z.literal("items"),
    /** What the joint cost is divided in proportion to — evaluated per row, with that row's own
     *  columns in scope, then weighted by the row's `quantity`. An items grid always holds at
     *  least one row and is never capped, so it carries no minRows/maxRows. */
    basisExpr: z.string(),
    /** column key -> B1 DocumentLine field. ItemCode/Quantity/UnitPrice are the split's, not yours. */
    map: z.record(z.string(), z.string()).optional(),
  }),
]);
export type TableDef = z.infer<typeof TableDefZ>;
export type ItemsTable = Extract<TableDef, { role: "items" }>;

/** Per-project row data, by table key. Formula cells are re-evaluated on every read, like every
 *  other number in this engine — unless the row stores one, which is a manual override (tables.ts). */
export type TableRows = Record<string, Record<string, Val>[]>;
// same union as EntriesZ, for the same reason: Val's list arm is real (a multicombo cell), and a
// zod schema narrower than the TS type would fail to typecheck at every call site that stores one.
export const TableRowsZ = z.record(
  z.string(),
  z.array(z.record(z.string(), z.union([ValZ, z.array(z.string())]))),
);

/** Scalar a table contributes to every expression scope, e.g. holes_perimeter, holes_count. */
export const aggregateKey = (tableKey: string, col: string) => `${tableKey}_${col}`;

/** A section's groups, each rendered as one UI5 FormGroup. A group lists its fields in render
 *  order: parameter keys and table keys alike — they share one namespace (checkModel), so a key
 *  names one or the other. A table draws across the whole form, titled from its TableDef, so a
 *  rename on the table's page never leaves a stale title in the structure. */
export const GroupZ = z.object({
  key: KeyZ,
  title: z.string(),
  params: z.array(KeyZ),
  /** false hides every field in it, exactly as each field's own `visibleWhen` would, and its
   *  tables, whose rows then count for nothing */
  visibleWhen: z.string().optional(),
});
export type Group = z.infer<typeof GroupZ>;

/** A section's (`key`) or field group's (`section/group`) id in FormState.hidden. Keys are
 *  identifiers, so the slash never collides; a group key alone is only unique in its section. */
export const structureId = (section: string, group?: string) => (group === undefined ? section : `${section}/${group}`);

export const ModelDefZ = z.object({
  name: z.string(),
  /** free text, shown as the builder's page subtitle. */
  description: z.string().optional(),
  /** free text for the assistant: how to configure a product on this model. Prompt only, the
   *  engine never reads it. */
  instructions: z.string().optional(),
  parameters: z.array(ParamZ),
  structure: z.object({
    sections: z.array(
      z.object({
        key: KeyZ,
        title: z.string(),
        groups: z.array(GroupZ),
        /** false hides everything in it: its groups' fields, and its tables, whose rows then count
         *  for nothing. checkModel refuses one on the section or group holding the items grid. */
        visibleWhen: z.string().optional(),
      }),
    ),
  }),
  // A computed value is global: it shares one namespace with the parameters and is usable in any
  // expression. `param` is the builder's alone: the parameter it is drawn under and deleted with
  // (absent on older models, which draw under the last parameter).
  computed: z.array(z.object({ key: KeyZ, expr: z.string(), param: KeyZ.optional() })),
  // optional, not .default([]): a zod default lands in the inferred type as *required*, which
  // would force `tables: []` into every existing ModelDef literal.
  tables: z.array(TableDefZ).optional(),
  constraints: z.array(ConstraintZ),
  bom: z.array(BomLineZ),
  routing: z.array(OperationZ),
  // No item-code pointer here: exact help reads the items grid's ITEM_COL column, which every
  // items table already declares. This object is only the similarity cache's configuration —
  // `table` names a tenant masterdata query; the query itself is not stored on the model.
  history: z
    .object({
      table: z.string().min(1).optional(),
      mappings: z.array(HistoryMappingZ),
      display: z.array(z.string()),
    })
    .optional(),
  // No currency here: it is B1's, fixed when the company database is created, so it belongs to the
  // tenant rather than to each model — sap_connection.localCurrency, served on `me`.
  pricing: z.object({
    // Share of the price, in percent: price = unit cost / (1 - margin / 100). checkModel keeps it
    // in [0, 100). A configuration may override it (config_project.margin).
    margin: z.number(),
    quoteItemCode: z.string().min(1),
    // The B1 price list the BOM materials are costed from. Optional here, required by checkModel:
    // a model saved before price lists existed must still load, it just cannot be saved again
    // until one is picked.
    priceList: z.number().int().positive().optional(),
    // The tenant masterdata query whose cached rows carry the item prices — an `Items` read with
    // no declared columns, so B1 returns whole rows and the nested `ItemPrices` collection
    // survives into the cache. `priceList` then picks the line out of it. Named here rather than
    // built in, for the same reason `history.table` is: the query is the tenant's, defined once.
    itemTable: z.string().min(1).optional(),
    // The tenant masterdata query (target beas, OperationsCatalog) whose cached rows carry the
    // routing operations' times and rates. Required by checkModel once a routing line is linked.
    operationTable: z.string().min(1).optional(),
  }),
  batchDefaults: z.array(z.number().int().positive()),
});
export type ModelDef = z.infer<typeof ModelDefZ>;

export type Option = { value: Val; label: string };
export type ResolvedTable = {
  columns: string[];
  rows: Val[][];
  /** $skip for the next page; absent = last page */
  nextSkip?: number;
  /** value-help headers, from the masterdata row. Engine ignores; the picker reads them. */
  labels?: Record<string, string>;
  /** keys the value-help dialog hides. Still fetched, still derived. */
  hidden?: string[];
  /** a query table too big to reason over: `rows` is only its start, so a parameter over it is
   *  picked (value help), never enumerated, and never short of options (propagate's `open`) */
  partial?: true;
};
/** Everything external, already fetched: engine never sees source kinds. */
export type ResolvedLookups = {
  domains: Record<string, Option[]>;
  tables: Record<string, ResolvedTable>;
  /** B1 item code -> unit price in the model's `pricing.priceList`, read live on every resolve.
   *  Same seam as `tables`: the engine never learns where the number came from. */
  prices?: Record<string, number>;
  /** Beas OperationId -> its catalog figures, read out of `pricing.operationTable`'s cache on
   *  every resolve, like `prices`. Minutes and per hour, as Beas keeps them. */
  operations?: Record<string, CatalogOperation>;
};
export type CatalogOperation = { desc: string; resource: string; setupMin: number; runMinPerUnit: number; ratePerHour: number };
/** User-entered values only; absent key = open parameter. */
export type Entries = Record<string, Val>;

/** Effective key/label columns, by convention for both named sources: 1st column = key, 2nd =
 *  label. A ref that names them explicitly still wins — the builder stopped writing them. */
export function refKeyCols(ref: LookupRef, all: string[] | undefined): { valueCol: string; labelCol?: string } {
  if (ref.source === "manual") return { valueCol: "" };
  return { valueCol: ref.valueCol || (all?.[0] ?? ""), labelCol: ref.labelCol ?? all?.[1] };
}

/** The rows of `t` a ref offers: all of them, or those its `where` keeps. */
export function refRows(ref: LookupRef, t: Pick<ResolvedTable, "columns" | "rows">): Val[][] {
  if (ref.source === "manual" || !ref.where) return t.rows;
  const ci = t.columns.indexOf(ref.where.col);
  const keep = new Set(ref.where.values.map(String));
  return ci < 0 ? [] : t.rows.filter((r) => r[ci] !== null && r[ci] !== undefined && keep.has(String(r[ci])));
}

/** Source columns bound as `<param>_<col>`, the key column included (it is the code an author
 *  sees in the source, so `<param>_<key>` must resolve too); ignores `ref.columns`. */
export function derivedColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  return all ?? [];
}

/** Extra columns shown in pickers; `ref.columns` is the visibility subset. */
export function displayColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  if (ref.columns) return ref.columns;
  return derivedColumns(ref, all);
}

/** Derived value key for a param's source column, e.g. material_density. */
export const derivedKey = (paramKey: string, col: string) => `${paramKey}_${col}`;

/** The one mandatory item grid every model carries. An `itemcode` that is a SAP item is the line's
 *  ItemCode; any other is a part with no item yet, quoted on the model's generic item with the code
 *  in its mapped UDF (config-quote.ts; RESERVED_LINE_FIELDS keeps a map off ItemCode itself), which
 *  the Crystal Report layouts read.
 *  Basis defaults to 1: the split is then weighted by `quantity` alone, which is the sane answer
 *  before the author says what their shop actually costs by. */
export const itemsTable = (): ItemsTable => ({
  key: "items",
  title: "Items",
  role: "items",
  basisExpr: "1",
  map: { [ITEM_COL]: "U_CF_ItemCode", [ITEM_NAME_COL]: "ItemDescription" },
  columns: [
    { key: ITEM_COL, label: "Item code", type: "string", cell: { kind: "input" } },
    { key: ITEM_NAME_COL, label: "Item name", type: "string", cell: { kind: "input" } },
    { key: QTY_COL, label: "Quantity", type: "number", cell: { kind: "input" } },
  ],
});

/** Table keys the form actually shows, in render order: the ones a group lists. A key naming no
 *  TableDef is a parameter's, or one left behind by a deleted table, which never renders. */
export const placedTables = (model: ModelDef): string[] => {
  const keys = new Set((model.tables ?? []).map((t) => t.key));
  return model.structure.sections.flatMap((s) => s.groups.flatMap((g) => g.params.filter((k) => keys.has(k))));
};
