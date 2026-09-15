import { z } from "zod";

export type Val = number | string | boolean | null | string[];

export const ValZ = z.union([z.number(), z.string(), z.boolean(), z.null()]);
/** User-entry value: scalar Val, or string[] for multicombo params. */
export const EntriesZ = z.record(z.string(), z.union([ValZ, z.array(z.string())]));

export const LookupRefZ = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("manual"),
    options: z.array(z.object({ value: ValZ, label: z.string().optional() })),
  }),
  z.object({
    source: z.literal("table"),
    table: z.string(),
    valueCol: z.string(),
    labelCol: z.string().optional(),
    /** extra columns shown in pickers; absent = all extra. Derived keys always use every extra column. */
    columns: z.array(z.string()).optional(),
  }),
  z.object({
    source: z.literal("query"),
    /** names a tenant masterdata table of kind "query" — the query itself is defined there */
    table: z.string(),
    /** convention: absent = 1st declared column (see refKeyCols) */
    valueCol: z.string().optional(),
    labelCol: z.string().optional(),
    columns: z.array(z.string()).optional(),
  }),
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
  ui: z.enum(["input", "select", "radio", "checkbox", "multicombo", "step"]),
  domain: z
    .union([
      z.object({ kind: z.literal("options"), ref: LookupRefZ }),
      z.object({ kind: z.literal("range"), min: z.number(), max: z.number(), step: z.number().optional() }),
    ])
    .optional(),
  defaultExpr: z.string().optional(),
  visibleWhen: z.string().optional(),
  requiredWhen: z.string().optional(),
  /** informational per-unit price shown at the field's top-right; never enters the calculated price */
  priceExpr: z.string().optional(),
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

export const BomLineZ = z.object({
  id: z.string(),
  itemCode: z.string(), // expr
  desc: z.string().optional(), // expr
  condition: z.string().optional(), // expr -> boolean
  qty: z.string(), // expr, per finished unit; batch qty available as `qty`
  price: z.string(), // expr, cost per item unit
  scrapPct: z.number().default(0),
});

export const OperationZ = z.object({
  id: z.string(),
  resource: z.string(),
  condition: z.string().optional(),
  setupMin: z.string(), // expr, minutes per batch
  runMinPerUnit: z.string(), // expr, minutes per unit
  ratePerHour: z.string(), // expr, cost per hour
});

export const HistoryMappingZ = z.object({
  param: KeyZ,
  column: z.string().min(1),
  match: z.enum(["exact", "closeness", "contains"]),
  weight: z.number().positive().default(1),
});
export type HistoryMapping = z.infer<typeof HistoryMappingZ>;

/** One column of a config table. `cell` is what the salesperson sees: a plain field, a picker
 *  over the same LookupRef params use, or a value the model computes per row. */
export const TableColumnZ = z.object({
  key: KeyZ,
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  unit: z.string().optional(),
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

/** A section holds two kinds of group, and the form renders each as one UI5 FormGroup.
 *
 *  A **table group** carries nothing but the table key: its FormGroup is keyed and titled from the
 *  TableDef itself, so a rename in TableDialog cannot leave a stale title behind in the structure.
 *  A **field group** is the ordinary label-and-fields group and is unchanged.
 *
 *  Plain `z.union`, not `discriminatedUnion`: there is no tag field, so every model saved before
 *  tables were groups still parses as the field arm. Its table keys simply stop being placed, and
 *  the form's trailing catch-all section (UNPLACED_TABLES_SECTION) picks them up — which is the
 *  whole migration. The table arm is listed first so it wins for `{ table }` objects.
 */
export const TableGroupZ = z.object({ table: KeyZ });
export const FieldGroupZ = z.object({
  key: KeyZ,
  title: z.string(),
  /** The group's fields in render order. Parameter keys only — a table is a group of its own now. */
  params: z.array(KeyZ),
});
export const GroupZ = z.union([TableGroupZ, FieldGroupZ]);
export type TableGroup = z.infer<typeof TableGroupZ>;
export type FieldGroup = z.infer<typeof FieldGroupZ>;
export type Group = z.infer<typeof GroupZ>;

/** The one type guard for the group union. `"table" in g` inlined everywhere would work, but this
 *  narrows in .filter()/.map() callbacks where TypeScript loses the `in` narrowing. */
export const isTableGroup = (g: Group): g is TableGroup => "table" in g;

export const ModelDefZ = z.object({
  name: z.string(),
  parameters: z.array(ParamZ),
  structure: z.object({
    sections: z.array(
      z.object({
        key: KeyZ,
        title: z.string(),
        groups: z.array(GroupZ),
      }),
    ),
  }),
  // `under` is a display anchor only — which parameter row the builder tree draws this formula
  // beneath. Scope is unaffected: a computed value is global and usable in any expression.
  computed: z.array(z.object({ key: KeyZ, expr: z.string(), under: KeyZ.optional() })),
  // optional, not .default([]): same reason as pricing.currency below — a zod default is required
  // in the inferred type and would force `tables: []` into every existing ModelDef literal.
  tables: z.array(TableDefZ).optional(),
  constraints: z.array(ConstraintZ),
  bom: z.array(BomLineZ),
  routing: z.array(OperationZ),
  history: z
    .object({
      itemCodeParam: KeyZ.optional(),
      query: QuerySourceZ.optional(),
      mappings: z.array(HistoryMappingZ),
      display: z.array(z.string()),
    })
    .optional(),
  // currency is optional, not .default("EUR"): a zod default lands in the inferred type as required
  // and would force the key into every ModelDef literal. One `?? "EUR"` in money() covers it.
  pricing: z.object({ priceExpr: z.string(), quoteItemCode: z.string().min(1), currency: z.string().optional() }),
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
};
/** Everything external, already fetched: engine never sees source kinds. */
export type ResolvedLookups = {
  domains: Record<string, Option[]>;
  tables: Record<string, ResolvedTable>;
};
/** User-entered values only; absent key = open parameter. */
export type Entries = Record<string, Val>;

/** Effective key/label columns; query refs default by convention: 1st column = key, 2nd = label. */
export function refKeyCols(ref: LookupRef, all: string[] | undefined): { valueCol: string; labelCol?: string } {
  if (ref.source === "manual") return { valueCol: "" };
  if (ref.source === "query")
    return { valueCol: ref.valueCol || (all?.[0] ?? ""), labelCol: ref.labelCol ?? all?.[1] };
  return { valueCol: ref.valueCol, labelCol: ref.labelCol };
}

/** Extra source columns bound as `<param>_<col>`; ignores `ref.columns`. */
export function derivedColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  const { valueCol } = refKeyCols(ref, all);
  return (all ?? []).filter((c) => c !== valueCol);
}

/** Extra columns shown in pickers; `ref.columns` is the visibility subset. */
export function displayColumns(ref: LookupRef, all: string[] | undefined): string[] {
  if (ref.source === "manual") return [];
  if (ref.columns) return ref.columns;
  return derivedColumns(ref, all);
}

/** Derived value key for a param's source column, e.g. material_density. */
export const derivedKey = (paramKey: string, col: string) => `${paramKey}_${col}`;

/** The one mandatory item grid every model carries. `itemcode` rides to SAP as a UDF rather than
 *  DocumentLine.ItemCode: the generic configurator item stays the B1 item (config-quote.ts, and
 *  RESERVED_LINE_FIELDS enforces it), and the Crystal Report layouts read U_CF_ItemCode.
 *  Basis defaults to 1: the split is then weighted by `quantity` alone, which is the sane answer
 *  before the author says what their shop actually costs by. */
export const itemsTable = (): ItemsTable => ({
  key: "items",
  title: "Items",
  role: "items",
  basisExpr: "1",
  map: { itemcode: "U_CF_ItemCode", itemname: "ItemDescription" },
  columns: [
    { key: "itemcode", label: "Item code", type: "string", cell: { kind: "input" } },
    { key: "itemname", label: "Item name", type: "string", cell: { kind: "input" } },
    { key: QTY_COL, label: "Quantity", type: "number", cell: { kind: "input" } },
  ],
});

/** Table keys the form actually shows, in render order. A table is a group of its own and lives
 *  nowhere else — a key naming no TableDef is dropped, so a group left behind by a deleted table
 *  never renders. */
export const placedTables = (model: ModelDef): string[] => {
  const keys = new Set((model.tables ?? []).map((t) => t.key));
  return model.structure.sections.flatMap((s) =>
    s.groups.filter(isTableGroup).map((g) => g.table).filter((k) => keys.has(k)),
  );
};
