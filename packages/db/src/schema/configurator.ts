import { sql } from "drizzle-orm";
import {
  boolean, customType, doublePrecision, index, jsonb, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { Entries, ModelDef, Outputs, QuerySource, TableRows, Val } from "@confire/config-engine";

// Configurator persistence: a mutable model, and one configuration document that carries its own
// latest calculation. Spec: docs/superpowers/specs/2026-07-03-configurator-design.md.

// The whole model is one jsonb document (ModelDef), loaded/saved whole like ui_view.state.
/** What a portal client sees of a model's prices before the quotation (spec §7.2). */
export type PortalPricing = "indicative" | "request";

export const configModel = pgTable(
  "config_model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    definition: jsonb("definition").$type<ModelDef>().notNull(),
    // Customer portal (spec D15, D21): columns, not ModelDef keys. Saved by models.save beside the
    // definition; only a definition change bumps `updatedAt`, which makes stored calculations stale.
    portal: boolean("portal").notNull().default(false),
    portalPricing: text("portal_pricing").$type<PortalPricing>().notNull().default("request"),
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

/** Internal configurations use only draft and quoted; the rest is the portal lifecycle (spec §7).
 *  project-lifecycle.ts is the only writer. */
export const PROJECT_STATUSES = ["draft", "submitted", "in_review", "returned", "declined", "quoted"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectCustomer = { cardCode: string; cardName: string };
/** Where a value came from: a quote read off a named file, or the user's own words in the chat. */
export type ValueSource = { file: string; page: number | null; quote: string } | { chat: string };
/** By field key (a parameter, a table, or `batches`): the value the source wrote, and the source. */
export type ProjectSources = Record<string, { value: unknown; source: ValueSource }>;
export type QuoteResponse = "accepted" | "declined";

// One enumerated configuration, priced per batch quantity, and the user's pick of one.
export type ConfigCandidate = { assignment: Entries; perBatch: { batchQty: number; outputs: Outputs }[] };
export type ConfigSelection = { candidateIdx: number; batchQty: number };

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
    // The portal fence (spec §6): a client's project. Null = an internal-only configuration. Every
    // portal read and write is fenced on it together with tenantId — a company is (tenant, CardCode) —
    // and an internal read never sees one in `draft`.
    portalCardCode: text("portal_card_code"),
    // Set by accept when nobody holds it yet, and by staff's Reassign (project-lifecycle.ts `assign`);
    // the client sees the name. No foreign key and nothing clears it: someone who has left the
    // workspace counts as no assignee when a notification is routed.
    assigneeId: text("assignee_id"),
    quoteResponse: text("quote_response").$type<QuoteResponse>(),
    quoteRespondedAt: timestamp("quote_responded_at", { withTimezone: true }),
    entries: jsonb("entries").$type<Entries>().notNull().default({}),
    batches: jsonb("batches").$type<number[]>().notNull().default([]),
    // This configuration's margin in percent, over the model's `pricing.margin`; null = the model's.
    // An engine input like `batches`: writing it empties the calculation. Staff only (configs.calculate).
    margin: doublePrecision("margin"),
    // Row data for the model's tables (item matrix, calculation tables), by table key. A sibling
    // column rather than more keys in `entries`: Entries values are compared with === across
    // propagate/enumerate/enrichLookups, and widening Val to hold row arrays would touch all of it.
    tables: jsonb("tables").$type<TableRows>().notNull().default({}),
    // Value provenance (assistant spec §4.7). Written only by `configs.calculate` (and copied by
    // duplicate), in the same UPDATE as the patch: a write without a source for a key drops it. A
    // key's marker shows while its entry still equals `value`.
    sources: jsonb("sources").$type<ProjectSources>().notNull().default({}),
    candidates: jsonb("candidates").$type<ConfigCandidate[]>().notNull().default([]),
    selection: jsonb("selection").$type<ConfigSelection[]>(),
    // When `candidates` was computed, and null whenever they are empty. Compared against
    // config_model.updatedAt to decide whether a recalculate can be skipped — cheaper than the
    // ModelDef deep-compare it replaces.
    calculatedAt: timestamp("calculated_at", { withTimezone: true }),
    // The CURRENT quotation: a re-quote modifies it, or replaces it when B1 has it closed (§7.3).
    // Each `quoted` event keeps its own docEntry, so an earlier quotation stays findable.
    b1DocEntry: integer("b1_doc_entry"),
    // The company b1DocEntry lives in (sap_connection.companyDb when it was posted). A DocEntry means
    // nothing in another company: there a re-quote creates instead of patching, and no link shows.
    b1Company: text("b1_company"),
    quotedAt: timestamp("quoted_at", { withTimezone: true }),
    // Engineered value/cost of the selected candidates, captured when the quotation is confirmed
    // so the posted document's DocTotal can be checked against a frozen figure. Recomputing would
    // resolve the model's live lookups and could disagree with what was posted.
    quotedValue: numeric("quoted_value", { precision: 18, scale: 4 }),
    quotedCost: numeric("quoted_cost", { precision: 18, scale: 4 }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("config_project_tenant_status_idx").on(t.tenantId, t.status),
    index("config_project_portal_company_idx").on(t.tenantId, t.portalCardCode),
  ],
);

export type ConfigProject = typeof configProject.$inferSelect;

export const PROJECT_EVENT_KINDS = [
  "created", "submitted", "resubmitted", "withdrawn", "accepted", "returned", "declined", "revised",
  "quoted", "quote_accepted", "quote_declined", "comment", "file", "assigned",
] as const;
export type ProjectEventKind = (typeof PROJECT_EVENT_KINDS)[number];
export type ProjectInputs = { entries: Entries; batches: number[]; tables: TableRows };
/** Indicative figures per batch quantity — what the client saw at submit (§7.2). `from`: several
 *  candidates, so the cheapest one. */
export type PortalPrice = { batchQty: number; unitPrice: number; total: number; from: boolean };
export type RevisionDiff = {
  entries: Record<string, [Val | undefined, Val | undefined]>;
  batches?: [number[], number[]];
  /** row counts, before and after, for every table whose rows changed */
  tables: Record<string, [number, number]>;
};
/** `payload` per kind (spec §6). */
export type ProjectEventPayload =
  | { inputs: ProjectInputs; prices?: PortalPrice[] }
  | RevisionDiff
  // `company`: where docEntry lives (absent on events older than company switches = the project's b1Company)
  | { docEntry: number; docNum: number | null; value: number; mode: "created" | "updated"; inputs: ProjectInputs; company?: string | null }
  | { fileId: string; name: string; size: number }
  /** `assigned`: the name is snapshotted, so the timeline needs no join */
  | { assigneeId: string; assigneeName: string }
  /** `created` from the assistant's panel */
  | { via: "assistant" };

// The project's timeline (spec §6, §8), append-only. project-lifecycle.ts writes every status
// event in the same transaction as the guarded status UPDATE; comments are written beside it.
// `visibility` is the portal fence: the portal reads `external` only, in SQL.
export const configProjectEvent = pgTable(
  "config_project_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    projectId: uuid("project_id").notNull().references(() => configProject.id, { onDelete: "cascade" }),
    // clock_timestamp(), not now(): now() is the transaction's start, and a transition writes
    // `revised` and its own event in one transaction — they must not tie on the timeline.
    at: timestamp("at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    kind: text("kind").$type<ProjectEventKind>().notNull(),
    actorUserId: text("actor_user_id"),
    actorSide: text("actor_side").$type<"internal" | "external">().notNull(),
    visibility: text("visibility").$type<"external" | "internal">().notNull().default("external"),
    note: text("note"),
    payload: jsonb("payload").$type<ProjectEventPayload>(),
    // P7: a notification that failed lands here instead of failing the request.
    mailError: text("mail_error"),
  },
  (t) => [index("config_project_event_project_idx").on(t.projectId, t.at)],
);
export type ConfigProjectEvent = typeof configProjectEvent.$inferSelect;

// node-postgres reads bytea as a Buffer and writes one as is.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// Attachments (spec D14) in Postgres: a project's files, and the tenant's branding logo
// (`projectId` null — the one row GET /files/:id serves without a session, D20). Append-only like
// the timeline: nothing deletes a file. A project's are written only by project-lifecycle.ts.
// ponytail: bytea in the main database; move `data` to S3-compatible storage (Bun's S3Client)
// when database size or backups hurt.
export const projectFile = pgTable(
  "project_file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    projectId: uuid("project_id").references(() => configProject.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => configProjectEvent.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    uploadedBy: text("uploaded_by"),
    // The download fence, as on the event: the portal serves `external` files only.
    visibility: text("visibility").$type<"external" | "internal">().notNull().default("external"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("project_file_project_idx").on(t.projectId)],
);

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
