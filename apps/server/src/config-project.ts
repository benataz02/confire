import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import { db, configMasterdata, configModel, configProject, type ConfigCandidate, type ConfigProject } from "@confire/db";
import {
  computeOutputs, DslError, enumerate, missingInputs, propagate, syncTables,
  type Entries, type ModelDef, type Notice, type Propagation, type ResolvedLookups, type TableRows,
} from "@confire/config-engine";
import {
  bindEntryValues, masterdataVersion, queryPageSource, resolveLookups, toResolvedTable,
  type MasterdataRow, type RowCache,
} from "./lookups.ts";
import { ensureFresh, pageRows, rowCache } from "./masterdata-sync.ts";
import { canWrite, type Side } from "./project-lifecycle.ts";

// The configuration engine's server half: model, lookups, calculate, value-help paging. Moved out
// of orpc/routers/configs.ts (spec §7.5) because that module imports orpc/base.ts and with it the
// internal auth.ts, which the portal process must not build. Both processes import this one.

/** Every masterdata row of a tenant, in the shape the resolvers take. `id` is in there because it
 *  is the key of the row cache, the sync state because a view reports it, and both timestamps
 *  because they are what makes a stored calculation stale. */
export async function masterdataRows(tenantId: string): Promise<MasterdataRow[]> {
  return db
    .select({
      id: configMasterdata.id, name: configMasterdata.name, kind: configMasterdata.kind,
      columns: configMasterdata.columns, rows: configMasterdata.rows, query: configMasterdata.query,
      syncedAt: configMasterdata.syncedAt, syncError: configMasterdata.syncError,
      rowCount: configMasterdata.rowCount, updatedAt: configMasterdata.updatedAt,
    })
    .from(configMasterdata)
    .where(eq(configMasterdata.tenantId, tenantId));
}

export async function loadModel(tenantId: string, modelId: string) {
  const [m] = await db
    .select({
      id: configModel.id, name: configModel.name, definition: configModel.definition,
      updatedAt: configModel.updatedAt, portal: configModel.portal, portalPricing: configModel.portalPricing,
    })
    .from(configModel)
    .where(and(eq(configModel.id, modelId), eq(configModel.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new ORPCError("NOT_FOUND", { message: "Model not found" });
  return m;
}
export type LoadedModel = Awaited<ReturnType<typeof loadModel>>;

/** The model as one configuration prices it: its own margin over the model's. Both ways to a
 *  project's engine (liveEngine, liveProject) go through here, so the view, the recalculation and
 *  the quotation price alike. */
const withMargin = (model: LoadedModel, margin: number | null | undefined): LoadedModel =>
  margin == null ? model
  : { ...model, definition: { ...model.definition, pricing: { ...model.definition.pricing, margin } } };

/** Each parameter's and table's label by key. A revision stores keys (§7.4); the timeline and the
 *  mail that lists it read them with the model as it is now. */
export const modelLabels = (def: ModelDef | undefined): Record<string, string> => Object.fromEntries([
  ...(def?.parameters ?? []).map((x) => [x.key, x.label || x.key]),
  ...(def?.tables ?? []).map((t) => [t.key, t.title || t.key]),
]);

// ponytail: per-process cache keyed by model updatedAt (auto-invalidates on save);
// Redis/LRU only if the server ever scales past one Bun process.
//
// Short, because a miss is now a handful of indexed SQL reads rather than a round trip to the
// customer's network. It exists to stop every view — one per committed edit — re-projecting the same
// tables, and nothing more.
const CACHE_TTL_MS = 30_000;
// The *promise* is cached, not the value: concurrent cold callers then share one resolve.
const lookupCache = new Map<string, { at: number; lookups: Promise<ResolvedLookups> }>();

/** The model's canonical lookups, memoized.
 *
 *  Reads Postgres and nothing else, so unlike its predecessor it has no failure mode worth
 *  wrapping — there is no agent on this path to be unreachable and no BAD_GATEWAY to report. A
 *  query table whose cache is empty resolves to an empty table, the form still renders, and
 *  `ensureFresh` fills it in behind the request.
 *
 *  Keyed by the model and the masterdata version and nothing else. A configuration's entries stay
 *  out of the key deliberately: they are unbounded user input, and a key that grew with them would
 *  turn this Map into a leak and miss on every edit. `bindEntryValues` is the per-
 *  configuration half, and it is cheap enough not to need caching. */
function canonicalLookups(
  tenantId: string, model: LoadedModel, cache?: RowCache, rows?: MasterdataRow[],
): Promise<ResolvedLookups> {
  const key = `${tenantId}:${model.id}:${model.updatedAt.getTime()}:${masterdataVersion(tenantId)}`;
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lookups;
  const p = (async () => {
    const md = rows ?? (await masterdataRows(tenantId));
    // Fire the frequency-driven refresh for the tables this model reads, off the request path.
    ensureFresh(tenantId, md.filter((r) => syncTables(model.definition).has(r.name)));
    return resolveLookups(model.definition, md, cache ?? rowCache(tenantId));
  })();
  p.catch(() => lookupCache.delete(key));
  lookupCache.set(key, { at: Date.now(), lookups: p });
  return p;
}

/** Canonical lookups plus the rows a stored configuration depends on — the one call every read
 *  path makes. The binding is not optional: a persisted entry, or a stored grid cell, can name a
 *  row that is not on the canonical page. */
export async function cachedLookups(
  tenantId: string, model: LoadedModel,
  entries: Entries = {}, tableRows: TableRows = {}, cache?: RowCache, rows?: MasterdataRow[],
): Promise<ResolvedLookups> {
  const md = rows ?? (await masterdataRows(tenantId));
  const rc = cache ?? rowCache(tenantId);
  const canonical = await canonicalLookups(tenantId, model, rc, md);
  return bindEntryValues(model.definition, md, canonical, rc, entries, tableRows);
}

/** One page of a model's query table, for the value help. The caller names a table; the table is
 *  resolved from the tenant's masterdata by queryPageSource (`masterdata.queryPage` is the
 *  ad-hoc-query variant and stays admin-only, because it takes a query instead of naming one).
 *  The cursor is a plain row offset and nothing else. */
export const QueryPageZ = z.object({
  modelId: z.uuid(),
  table: z.string().min(1),
  search: z.string().optional(),
  searchCols: z.array(z.string()).optional(),
  cursor: z.number().int().min(0).optional(),
  /** exact key: the value help's existence probe and label lookup */
  match: z.object({ col: z.string(), value: z.union([z.string(), z.number()]) }).optional(),
});

/** One page of a query table the value help asked for. The caller has already proved the model
 *  belongs to this tenant (and, on the portal, that it is published and names the table). */
export async function queryTablePage(tenantId: string, input: z.infer<typeof QueryPageZ>) {
  const rows = await masterdataRows(tenantId);
  let src;
  try {
    src = queryPageSource(rows, input);
  } catch (e) {
    throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
  }
  ensureFresh(tenantId, [src.row]);
  const page = await pageRows(tenantId, src.row.id, src.q);
  return {
    ...toResolvedTable(page.rows, src.row.query.columns),
    ...(page.nextSkip === undefined ? {} : { nextSkip: page.nextSkip }),
    ...(src.row.query.labels ? { labels: src.row.query.labels } : {}),
    ...(src.row.query.hidden ? { hidden: src.row.query.hidden } : {}),
  };
}

/** Live model + lookups for a stored calculation. There is no snapshot: stored candidates are
 *  always re-priced against what the model and the cache say now. */
export async function liveEngine(
  tenantId: string, project: { modelId: string; entries: Entries; tables?: TableRows; margin: number | null },
) {
  const model = withMargin(await loadModel(tenantId, project.modelId), project.margin);
  return { model, lookups: await cachedLookups(tenantId, model, project.entries, project.tables) };
}

// ---- The calculation ------------------------------------------------------------------------

/** The General fields' message keys. `__`: they share the page's data-param namespace with
 *  parameter and table keys. */
export const NAME_KEY = "__name";
export const CUSTOMER_KEY = "__customer";
export const BATCHES_KEY = "__batches";

/** What a project still needs before it is calculated and quoted, in form order: General's name,
 *  customer and batch quantities, then the model's required parameters and items grid. Empty is
 *  the whole gate — the calculation waits for it, and the page's Create quote shows once it is. */
export function missingOf(
  model: ModelDef, lookups: ResolvedLookups, prop: Propagation,
  p: Pick<ConfigProject, "name" | "customer" | "batches" | "tables">,
): Notice[] {
  return [
    ...(p.name.trim() ? [] : [{ key: NAME_KEY, code: "name_required", params: [], message: "Enter a name" }]),
    // cardCode, not just a truthy customer: a half-filled one would otherwise reach the B1 seed.
    ...(p.customer?.cardCode ? [] : [{ key: CUSTOMER_KEY, code: "customer_required", params: [], message: "Pick a customer" }]),
    ...(p.batches.length ? [] : [{ key: BATCHES_KEY, code: "batches_required", params: [], message: "Add at least one batch quantity" }]),
    ...missingInputs(model, lookups, prop, p.tables),
  ];
}

/** A stored calculation is stale once the model changed after it, or any masterdata row the model
 *  reads was synced or edited after it — a price sync must reach the candidates, not only the
 *  quotation. Absent counts as stale. */
export function isStale(calculatedAt: Date | null, model: LoadedModel, md: MasterdataRow[]): boolean {
  if (!calculatedAt) return true;
  if (calculatedAt < model.updatedAt) return true;
  const named = syncTables(model.definition);
  return md.some((r) => named.has(r.name)
    && ((!!r.syncedAt && r.syncedAt > calculatedAt) || (!!r.updatedAt && r.updatedAt > calculatedAt)));
}

/** waiting: something is missing, or there are conflicts. failed: nothing valid completes the
 *  inputs, or a formula broke — the inputs are saved, and the message says why. */
export type Calculation = { state: "waiting" | "current" | "failed"; message?: string };

/** The row as the calculation reads it, plus its version: `updated_at` as text, exact to the
 *  microsecond — a JS Date would round a database-set default to the millisecond and never match. */
const projectRow = (where: SQL) =>
  db.select({ ...getTableColumns(configProject), version: sql<string>`${configProject.updatedAt}::text` })
    .from(configProject).where(where).limit(1).then((r) => r[0]);
export type ProjectRow = NonNullable<Awaited<ReturnType<typeof projectRow>>>;

/**
 * Recalculate a project from the row it was read as. Never enumerates while anything is missing or
 * a rule is broken. A failure is state, not an error: the inputs are kept, and it is not stored —
 * the next read of a complete project tries again, which picks up a fixed model or a refilled cache.
 *
 * The write is the calculation only (candidates, selection, calculatedAt), and only if the row is
 * still at the version it was read at. A patch that landed meanwhile wins: `lost` says the result
 * was dropped, and the newer writer's own call calculates. It does not touch `updatedAt` — a
 * refresh on read is not an edit, so lists do not reorder under it.
 */
export async function recalculate(
  tenantId: string, row: ProjectRow, model: LoadedModel, lookups: ResolvedLookups,
  gate: { missing: Notice[]; conflicts: unknown[] },
): Promise<Calculation & { lost: boolean }> {
  const write = async (set: Partial<typeof configProject.$inferInsert>) => {
    const done = await db.update(configProject).set(set)
      .where(and(eq(configProject.id, row.id), eq(configProject.tenantId, tenantId),
        sql`${configProject.updatedAt} = ${row.version}::timestamptz`))
      .returning({ id: configProject.id });
    return done.length === 0;
  };
  // Stale candidates never outlive the gate, or a failure: they go, and nothing replaces them.
  const clear = () => (row.candidates.length ? write({ candidates: [], selection: null, calculatedAt: null }) : Promise.resolve(false));
  if (gate.missing.length || gate.conflicts.length) return { state: "waiting", lost: await clear() };
  let candidates: ConfigCandidate[];
  try {
    const en = enumerate(model.definition, lookups, row.entries, 200, row.tables);
    if (!en.candidates.length)
      return { state: "failed", message: "No valid configuration completes the current entries", lost: await clear() };
    candidates = en.candidates.map((assignment) => ({
      assignment,
      perBatch: row.batches.map((batchQty) => ({
        batchQty, outputs: computeOutputs(model.definition, lookups, assignment, batchQty, row.tables),
      })),
    }));
  } catch (e) {
    if (e instanceof DslError || e instanceof RangeError) return { state: "failed", message: e.message, lost: await clear() };
    throw e;
  }
  // calculatedAt going non-null is the only claim that inputs and candidates match. The selection
  // goes too: it is indices into the list being replaced.
  return { state: "current", lost: await write({ candidates, selection: null, calculatedAt: new Date() }) };
}

/**
 * A project as every view reads it: the row, its model and lookups, the propagation and what is
 * missing — with its calculation brought up to date first when `side` may write it and it is absent
 * or stale. A locked project shows its stored calculation as it is. Both processes' views and
 * `calculateProject` come through here, so a view is always current without a client effect.
 */
export async function liveProject(tenantId: string, where: SQL, side: Side, cache?: RowCache) {
  const read = async () => {
    const row = await projectRow(where);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  };
  const derive = async (row: ProjectRow) => {
    const lookups = await cachedLookups(tenantId, model, row.entries, row.tables, cache, md);
    let prop: Propagation;
    try {
      prop = propagate(model.definition, lookups, row.entries, row.tables);
    } catch (e) {
      if (e instanceof DslError) throw new ORPCError("BAD_REQUEST", { message: e.message });
      throw e;
    }
    return { lookups, prop, missing: missingOf(model.definition, lookups, prop, row) };
  };
  const shown = (row: ProjectRow): Calculation => ({ state: row.candidates.length ? "current" : "waiting" });

  let row = await read();
  const model = withMargin(await loadModel(tenantId, row.modelId), row.margin);
  const md = await masterdataRows(tenantId);
  let d = await derive(row);
  let calculation = shown(row);
  const gateOpen = !d.missing.length && !d.prop.conflicts.length;
  if (canWrite(row, side) && isStale(row.calculatedAt, model, md) && (gateOpen || row.candidates.length)) {
    const r = await recalculate(tenantId, row, model, d.lookups, { missing: d.missing, conflicts: d.prop.conflicts });
    row = await read();
    // Lost: the newer row is built once, as it is — no loop.
    if (r.lost) { d = await derive(row); calculation = shown(row); }
    else calculation = { state: r.state, ...(r.message ? { message: r.message } : {}) };
  }
  return { row, model, md, ...d, calculation };
}
export type LiveProject = Awaited<ReturnType<typeof liveProject>>;

/** Bring one project's calculation up to date, as a staff read would. What `configs.duplicate`
 *  runs on its copy, and the tests' way in. */
export async function calculateProject(tenantId: string, projectId: string, cache?: RowCache): Promise<Calculation> {
  const live = await liveProject(tenantId, and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))!, "internal", cache);
  return live.calculation;
}
