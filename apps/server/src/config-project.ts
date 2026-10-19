import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, configMasterdata, configModel, configProject, type ConfigCandidate } from "@confire/db";
import {
  computeOutputs, DslError, enumerate, propagate, syncTables,
  type Entries, type ModelDef, type ResolvedLookups, type TableRows,
} from "@confire/config-engine";
import {
  bindEntryValues, masterdataVersion, queryPageSource, resolveLookups, toResolvedTable,
  type MasterdataRow, type RowCache,
} from "./lookups.ts";
import { ensureFresh, pageRows, rowCache } from "./masterdata-sync.ts";

// The configuration engine's server half: model, lookups, calculate, value-help paging. Moved out
// of orpc/routers/configs.ts (spec §7.5) because that module imports orpc/base.ts and with it the
// internal auth.ts, which the portal process must not build. Both processes import this one.

/** Every masterdata row of a tenant, in the shape the resolvers take. `id` is in there because it
 *  is the key of the row cache, and the sync state because a resolve reports it. */
export async function masterdataRows(tenantId: string): Promise<MasterdataRow[]> {
  return db
    .select({
      id: configMasterdata.id, name: configMasterdata.name, kind: configMasterdata.kind,
      columns: configMasterdata.columns, rows: configMasterdata.rows, query: configMasterdata.query,
      syncedAt: configMasterdata.syncedAt, syncError: configMasterdata.syncError,
      rowCount: configMasterdata.rowCount,
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
// customer's network. It exists to stop the process page's auto-calculate re-projecting the same
// tables on every keystroke, and nothing more.
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
 *  turn this Map into a leak and miss on every keystroke. `bindEntryValues` is the per-
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
  tenantId: string, project: { modelId: string; entries: Entries; tables?: TableRows },
) {
  const model = await loadModel(tenantId, project.modelId);
  return { model, lookups: await cachedLookups(tenantId, model, project.entries, project.tables) };
}

/** The calculate path.
 *
 *  Reuse: a project whose model is unchanged keeps its candidates instead of re-enumerating.
 *  `calculatedAt` is what proves those candidates still match the project's own entries — every
 *  writer of entries/batches/tables empties `candidates` and nulls `calculatedAt` in the same
 *  statement, so a non-null one cannot describe stale inputs.
 *
 *  `cache` stays injectable for tests; omitted, cachedLookups builds one for the tenant — and only
 *  past the reuse check, so a no-op recalculate never pays for it. */
export async function calculateProject(
  tenantId: string, projectId: string, cache?: RowCache,
) {
  const [project] = await db
    .select({
      modelId: configProject.modelId, entries: configProject.entries,
      batches: configProject.batches, tables: configProject.tables, candidates: configProject.candidates,
      calculatedAt: configProject.calculatedAt, updatedAt: configProject.updatedAt,
    })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const { entries, batches, tables: tableRows } = project;
  if (!batches.length) throw new ORPCError("BAD_REQUEST", { message: "Add at least one batch quantity" });

  const model = await loadModel(tenantId, project.modelId);

  // Runs before the lookups resolve: a no-op recalculate must not pay for a resolution it is
  // about to throw away. The process page auto-calculates ~1s after every edit.
  if (project.calculatedAt && project.calculatedAt >= model.updatedAt) {
    return {
      projectVersion: project.updatedAt.toISOString(), reused: true,
      candidateCount: project.candidates.length, capped: project.candidates.length >= 200,
      widest: undefined, candidates: project.candidates,
    };
  }

  const lookups = await cachedLookups(tenantId, model, entries, tableRows, cache);

  try {
    const pre = propagate(model.definition, lookups, entries, tableRows);
    if (pre.conflicts.length)
      throw new ORPCError("BAD_REQUEST", {
        message: `Configuration has conflicts: ${pre.conflicts.map((c) => c.message).join("; ")}`,
      });
    const en = enumerate(model.definition, lookups, entries, 200, tableRows);
    if (!en.candidates.length)
      throw new ORPCError("BAD_REQUEST", { message: "No valid configuration completes the current entries" });
    const candidates: ConfigCandidate[] = en.candidates.map((assignment) => ({
      assignment,
      perBatch: batches.map((batchQty) => ({
        batchQty, outputs: computeOutputs(model.definition, lookups, assignment, batchQty, tableRows),
      })),
    }));

    // One row, overwritten in place: entries and candidates move together. calculatedAt going
    // non-null here is the only claim that they match — there is no status flag restating it.
    // The selection goes too: it is indices into the list being replaced.
    const now = new Date();
    const updated = await db.update(configProject)
      .set({ entries, batches, candidates, selection: null, calculatedAt: now, updatedAt: now })
      .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
      .returning({ id: configProject.id });
    if (!updated.length) throw new ORPCError("NOT_FOUND");
    return {
      projectVersion: now.toISOString(), reused: false,
      candidateCount: candidates.length, capped: en.capped, widest: en.widest, candidates,
    };
  } catch (e) {
    if (e instanceof DslError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
}
