import { pgTable, primaryKey, uuid, text, jsonb, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { z } from "zod";

// Saved views, copied from the Beas GridViews/UserGridStates pair. A view is a named snapshot of one
// list's layout + filters (or one object page's layout); the views a feature declares in code are
// not rows here, they are "system" views the client prepends. Tenant-scoped like the rest
// (tenant_id text, no FK), owned by user_id, published tenant-wide by an admin via visibility.

// --- the wire query ----------------------------------------------------------------------------
// What a list asks a server for. The browser never sends an OData or SQL string: entity-list.ts
// compiles this to OData for B1 and list-sql.ts to SQL for Confire's own tables.
export const FilterOpZ = z.enum(["eq", "ne", "contains", "startswith", "gt", "ge", "lt", "le", "in"]);
export type FilterOp = z.infer<typeof FilterOpZ>;
export const FilterScalarZ = z.union([z.string(), z.number(), z.boolean()]);
export const FilterCondZ = z.object({
  field: z.string(),
  op: FilterOpZ,
  // `in` is an OR of equals (multi-select filters); every other op is a single scalar.
  value: z.union([FilterScalarZ, z.array(FilterScalarZ)]),
});
export type FilterCond = z.infer<typeof FilterCondZ>;
export const ListQueryZ = z.object({
  select: z.array(z.string()), // visible columns; the server adds the keys. [] = every field
  filter: z.array(FilterCondZ), // AND-combined
  orderby: z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]) })),
  search: z.string().optional(), // free text over string fields
  /** limit the search to these string fields; one that is not a string field is an error */
  searchFields: z.array(z.string()).optional(),
  /** the value help's type-ahead uses startswith (Beas §3); everything else contains */
  searchMode: z.enum(["contains", "startswith"]).optional(),
});
export type ListQuery = z.infer<typeof ListQueryZ>;

// --- view state --------------------------------------------------------------------------------
// One combined variant per list: the Beas grid-view and filter-view payloads in one document, with
// Beas's own field names, so a view restores the filters and the table layout together.
const FilterValueZ = z.union([
  z.string(), z.number(), z.boolean(), z.null(),
  z.array(z.union([z.string(), z.number()])),
  z.object({ from: z.string(), to: z.string() }),
]);
export type FilterValue = z.infer<typeof FilterValueZ>;
export const ViewStateZ = z.object({
  columns: z.array(z.string()), // visible columns, in order
  knownColumns: z.array(z.string()), // every column that existed at save time (qc() merge)
  sortBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })),
  groupBy: z.array(z.string()),
  columnWidths: z.record(z.string(), z.number()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  adaptFilterKeys: z.array(z.string()), // visible filters, in order
  filterValues: z.record(z.string(), FilterValueZ),
  searchTerm: z.string(),
});
export type ViewState = z.infer<typeof ViewStateZ>;

/** An object page's layout: which declared sections and fields show, in what order, renamed how. */
export const ObjectViewStateZ = z.object({
  sections: z.array(z.object({
    id: z.string(),
    visible: z.boolean(),
    fields: z.array(z.object({ key: z.string(), visible: z.boolean(), label: z.string().optional() })),
  })),
});
export type ObjectViewState = z.infer<typeof ObjectViewStateZ>;

/** Object views live under `<entity>::object`, list views under the list's table id. */
export const OBJECT_TABLE_SUFFIX = "::object";

// ponytail: one jsonb `state` loaded/saved whole, same as config_model — a view is small.
export const uiView = pgTable(
  "ui_view",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(), // creator/owner
    tableId: text("table_id").notNull(),
    name: text("name").notNull(),
    visibility: text("visibility").$type<"personal" | "shared">().notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    state: jsonb("state").$type<ViewState | ObjectViewState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ui_view_lookup_idx").on(t.tenantId, t.tableId)],
);

/** Per-user key/value state, the UserGridStates of Beas: the active view per table
 *  (`<tableId>::activeView`) and the value-help dialog layouts (`cfl:<source>`). */
export const uiUserState = pgTable(
  "ui_user_state",
  {
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.key] })],
);
