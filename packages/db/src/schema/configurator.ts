import { boolean, index, jsonb, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Entries, ModelDef, OutputOverrides, Outputs, QuerySource, TableRows, Val } from "@confire/config-engine";

// Configurator persistence: a mutable model, and one configuration document that carries its own
// latest calculation. Spec: docs/superpowers/specs/2026-07-03-configurator-design.md.

// The whole model is one jsonb document (ModelDef), loaded/saved whole like ui_variant.definition.
export const configModel = pgTable(
  "config_model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<ModelDef>().notNull(),
    // Client portal publish flag + catalog card subtitle. Columns (not jsonb) so lists filter on them.
    portal: boolean("portal").notNull().default(false),
    portalDescription: text("portal_description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_model_tenant_idx").on(t.tenantId)],
);

export type ConfigTableColumn = { key: string; label: string; type: "string" | "number" | "boolean" };

/** A live B1/Beas read, stored whole. Same shape QuerySourceZ validates, plus the two
 *  display-only fields the value-help dialog reads. */
export type MasterdataQuery = QuerySource & {
  /** dialog headers; missing/blank -> show the key. Engine ignores. */
  labels?: Record<string, string>;
  /** keys omitted from the value-help dialog. Still fetched, still derived. */
  hidden?: string[];
  /** Minutes before the cache is stale and a read triggers a background sync. Absent = manual
   *  sync only. Lives in the jsonb because the admin authors it, like `labels`/`hidden` — the
   *  sync's own state (syncedAt/syncError/rowCount) is columns, so a save cannot clobber it. */
  syncMinutes?: number;
};

// Admin-maintained masterdata, referenced by name from LookupRef/LOOKUP(). Two kinds in one table:
// "table" keeps its values here in `columns`/`rows`; "query" keeps the B1/Beas read in `query` and
// its VALUES in config_masterdata_row, refilled by a sync. Models reference either kind
// identically — they never hold the definition, and the resolver never learns which kind it was.
// ponytail: a "table" kind's rows stay one jsonb blob — they are hand-typed, so tens of rows.
//           Only synced rows, which have no ceiling, get the subtable.
export const configMasterdata = pgTable(
  "config_masterdata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<"table" | "query">().notNull().default("table"),
    columns: jsonb("columns").$type<ConfigTableColumn[]>().notNull().default([]),
    rows: jsonb("rows").$type<Val[][]>().notNull().default([]),
    query: jsonb("query").$type<MasterdataQuery>(),
    // Sync state for a "query" row. Written only by the sync, never by the editor's save — which
    // is why these are columns and `syncMinutes` is not.
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    syncError: text("sync_error"),
    rowCount: integer("row_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("config_masterdata_tenant_name_uq").on(t.tenantId, t.name)],
);
export type ConfigMasterdata = typeof configMasterdata.$inferSelect;

export type ProjectStatus = "draft" | "quoted" | "requested" | "rejected";
export type ProjectSource = "internal" | "portal";
export type ProjectCustomer = { cardCode: string; cardName: string };
// Client-facing history; appended inside each transition. Feeds the portal Timeline and
// survives submit → reject → resubmit cycles without extra timestamp columns.
export type ProjectEvent = {
  at: string;
  kind: "created" | "submitted" | "withdrawn" | "rejected" | "quoted";
  note?: string;
};

// One enumerated configuration, priced per batch quantity, and the user's pick of one.
export type ConfigCandidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type ConfigSelection = { candidateIdx: number; batchQty: number; overrides?: OutputOverrides };

// The "Configurations" document: customer + model + entries + batches, plus the single calculation
// those entries produced. There is no run history and no id but this one — a recalculate overwrites
// `candidates` in place.
//
// `candidates` are the entries in this same row, enumerated: there is no second copy of `entries`
// because `candidates` is emptied in the SAME statement that writes `entries`/`batches`/`tables`.
// A reader therefore sees either the old inputs with their own candidates, or the new inputs with
// none — never a mismatched pair. That is structural, which is why there is no `calculated` status
// flag claiming it: `calculatedAt !== null` is the whole freshness signal.
export const configProject = pgTable(
  "config_project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    modelId: uuid("model_id").notNull(),
    name: text("name").notNull(),
    customer: jsonb("customer").$type<ProjectCustomer>(),
    status: text("status").$type<ProjectStatus>().notNull().default("draft"),
    source: text("source").$type<ProjectSource>().notNull().default("internal"),
    rejectionNote: text("rejection_note"),
    events: jsonb("events").$type<ProjectEvent[]>().notNull().default([]),
    entries: jsonb("entries").$type<Entries>().notNull().default({}),
    batches: jsonb("batches").$type<number[]>().notNull().default([]),
    // Row data for the model's tables (item matrix, calculation tables), by table key. A sibling
    // column rather than more keys in `entries`: Entries values are compared with === across
    // propagate/enumerate/enrichLookups, and widening Val to hold row arrays would touch all of it.
    tables: jsonb("tables").$type<TableRows>().notNull().default({}),
    candidates: jsonb("candidates").$type<ConfigCandidate[]>().notNull().default([]),
    selection: jsonb("selection").$type<ConfigSelection[]>(),
    // When `candidates` was computed, and null whenever they are empty. Compared against
    // config_model.updatedAt to decide whether a recalculate can be skipped — cheaper than the
    // ModelDef deep-compare it replaces. Also the fence portal.submit guards on.
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    b1DocEntry: integer("b1_doc_entry"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    // Engineered value/cost of the selected candidates, captured once when the quotation is
    // confirmed. Stored rather than recomputed: recomputing resolves the model's live lookups,
    // which means one SAP round trip per row for a 12-month dashboard window.
    // ponytail: no backfill — configurations quoted before this shipped stay null and are excluded
    //           from the margin roll-up rather than counted as zero margin.
    quotedValue: numeric("quoted_value", { precision: 18, scale: 4 }),
    quotedCost: numeric("quoted_cost", { precision: 18, scale: 4 }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("config_project_tenant_status_idx").on(t.tenantId, t.status)],
);

export type ConfigProject = typeof configProject.$inferSelect;

// Cached values of a "query" masterdata, wholesale-replaced per sync.
//
// Raw B1 JSON, deliberately NOT Val-projected on write: a price list line lives inside the nested
// `ItemPrices` collection, and flattening it to a Val at write time would leave "[object Object]".
// Projection to the engine's Val[][] happens at read time instead, which also means the cache is a
// faithful mirror of what B1 returned rather than a lossy copy of it.
//
// `seq` is the row's position in the read, so `ORDER BY seq` replays the query's own `orderby`.
// Without it the value help would page a random-uuid order and the masterdata's Sort field would
// silently mean nothing. The composite key IS the paging index — there is no second one to keep.
export const configMasterdataRow = pgTable(
  "config_masterdata_row",
  {
    tenantId: text("tenant_id").notNull(),
    masterdataId: uuid("masterdata_id").notNull(),
    seq: integer("seq").notNull(),
    row: jsonb("row").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.masterdataId, t.seq] })],
);
