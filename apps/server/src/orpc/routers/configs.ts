import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, configModel, configProject, user,
  type ConfigCandidate, type ConfigSelection, type ProjectEvent,
} from "@confire/db";
import {
  computeOutputs, DslError, enumerate, EntriesZ, OutputOverridesZ, propagate, referencedTables, TableRowsZ,
  type Entries, type ModelDef, type Outputs, type ResolvedLookups, type TableRows, type Val,
} from "@confire/config-engine";
import { userProcedure } from "../base.ts";
import { B1Error, rowsOf } from "@confire/b1";
import { runnerFor, tenantConnector, viaB1 } from "../../b1.ts";
import { masterdataRows } from "./masterdata.ts";
import {
  enrichLookups, fetchQueryTable, masterdataVersion, needsSap, queryPageSource, resolveLookups,
  type MasterdataRow, type QueryRunner,
} from "../../lookups.ts";
import { compileSpec, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { loadHistoryRows } from "../../history-sync.ts";
import { scoreRows } from "../../similarity.ts";
import { copyName } from "../../copy-name.ts";
import { docHistoryQuery, flattenDocs, sortDocRows, type DocRow } from "../../doc-history.ts";
import {
  assertConfigMutable,
  buildQuoteSeed,
  configDocumentCommandId,
  quotedTotals,
  validateSelectionPairs,
  DEDUP_UDF,
} from "../../config-quote.ts";
// The configuration process API: any member drives a project (draft -> quoted).
// Trust model: browser propagates for preview; THESE handlers compute the numbers that get
// stored. Lookups: ~5-min cache for interactive use, always fresh inside calculateProject.

/** A runner for this model: the tenant's agent when the model reads live data, and otherwise one
 *  that would throw if anything called it — so an agent-free model never touches sap_connection.
 *  "Reads live data" is a property of the model *and* the tenant's masterdata now: true only when
 *  a table the model names is of kind "query". */
export async function modelRunner(tenantId: string, m: ModelDef, rows?: MasterdataRow[]): Promise<QueryRunner> {
  if (!needsSap(m, rows ?? (await masterdataRows(tenantId))))
    return () => Promise.reject(new Error("Model has no live queries"));
  return runnerFor(await tenantConnector(tenantId));
}

export async function loadModel(tenantId: string, modelId: string) {
  const [m] = await db
    .select({
      id: configModel.id, name: configModel.name, definition: configModel.definition,
      updatedAt: configModel.updatedAt, portal: configModel.portal,
    })
    .from(configModel)
    .where(and(eq(configModel.id, modelId), eq(configModel.tenantId, tenantId)))
    .limit(1);
  if (!m) throw new ORPCError("NOT_FOUND", { message: "Model not found" });
  return m;
}

async function freshLookups(model: ModelDef, rows: MasterdataRow[], run: QueryRunner): Promise<ResolvedLookups> {
  try {
    return await resolveLookups(model, rows, run);
  } catch (e) {
    if (e instanceof ORPCError) throw e; // SAP-not-connected etc. — keep the specific message
    throw new ORPCError("BAD_GATEWAY", { message: e instanceof Error ? e.message : String(e) });
  }
}

// ponytail: per-process cache keyed by model updatedAt (auto-invalidates on save);
// Redis/LRU only if the server ever scales past one Bun process.
const CACHE_TTL_MS = 5 * 60_000;
// The *promise* is cached, not the value: concurrent cold callers then share one lookup fetch
// instead of racing (same trick as resolveLookups' fetchOnce).
const lookupCache = new Map<string, { at: number; lookups: Promise<ResolvedLookups> }>();

/** The one way to resolve a model's lookups. Every caller goes through this cache — a run fired by
 *  the process page's auto-calculate would otherwise re-GET every query table on each keystroke. */
export function cachedLookups(
  tenantId: string, model: Awaited<ReturnType<typeof loadModel>>,
  run?: QueryRunner, rows?: MasterdataRow[],
): Promise<ResolvedLookups> {
  // masterdataVersion is in the key because a table edit changes the answer without touching the model.
  const key = `${tenantId}:${model.id}:${model.updatedAt.getTime()}:${masterdataVersion(tenantId)}`;
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.lookups;
  // An injected runner is the test seam (see configurator.test.ts); production resolves the
  // tenant's agent — but only for a model that actually reads live data.
  const p = (async () => {
    const md = rows ?? (await masterdataRows(tenantId));
    return freshLookups(model.definition, md, run ?? (await modelRunner(tenantId, model.definition, md)));
  })();
  p.catch(() => lookupCache.delete(key)); // a failed live lookup must not poison the key for 5 minutes
  lookupCache.set(key, { at: Date.now(), lookups: p });
  return p;
}

/** Cached lookups plus the off-page query rows a persisted entry depends on — the one call every
 *  read path makes. `enrichLookups` is not optional: a stored entry can name a row that is not on
 *  the canonical first page. */
export async function enrichedLookups(
  tenantId: string, model: Awaited<ReturnType<typeof loadModel>>, entries: Entries, run?: QueryRunner,
): Promise<ResolvedLookups> {
  const rows = await masterdataRows(tenantId);
  const runner = run ?? (await modelRunner(tenantId, model.definition, rows));
  return enrichLookups(model.definition, rows, entries, await cachedLookups(tenantId, model, runner, rows), runner);
}

/** One page of a model's query table, for the value help. The caller names a table; the query is
 *  resolved from the tenant's masterdata by queryPageSource (`masterdata.queryPage` is the
 *  ad-hoc-query variant and stays admin-only). The cursor is a plain row offset and nothing else. */
export const QueryPageZ = z.object({
  modelId: z.uuid(),
  table: z.string().min(1),
  search: z.string().optional(),
  searchCols: z.array(z.string()).optional(),
  cursor: z.number().int().min(0).optional(),
});

/** `scopeTo` bounds the read to the tables a model names. The portal passes it: masterdata is
 *  tenant-wide, and an external client must not be able to page a table their model never
 *  references. Internal callers do not — the builder previews a draft whose newest query domain is
 *  not in the saved definition yet, and a member can reach any of the tenant's tables anyway. */
export async function queryTablePage(
  tenantId: string, input: z.infer<typeof QueryPageZ>, scopeTo?: ModelDef,
) {
  if (scopeTo && !referencedTables(scopeTo).has(input.table))
    throw new ORPCError("BAD_REQUEST", { message: `Model does not use query table '${input.table}'` });
  let q;
  try {
    q = queryPageSource(await masterdataRows(tenantId), input);
  } catch (e) {
    throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
  }
  const run = runnerFor(await tenantConnector(tenantId));
  return fetchQueryTable(run, q.target, q.query, q.columns, { skip: q.skip });
}

/** Live model + lookups for a stored calculation. There is no snapshot: stored candidates are
 *  always re-priced against what the model and SAP say now. `enrichLookups` is not optional — it
 *  re-appends the off-page query rows a persisted entry may depend on. */
export async function liveEngine(tenantId: string, project: { modelId: string; entries: Entries }) {
  const model = await loadModel(tenantId, project.modelId);
  return { model, lookups: await enrichedLookups(tenantId, model, project.entries) };
}

/** The calculate path, shared by configs.calculate and portal.run.
 *
 *  Reuse: a project whose model is unchanged keeps its candidates instead of re-enumerating.
 *  `calculatedAt` is what proves those candidates still match the project's own entries — every
 *  writer of entries/batches/tables empties `candidates` and nulls `calculatedAt` in the same
 *  statement, so a non-null one cannot describe stale inputs.
 *
 *  `run` stays injectable for tests and for portal.run; omitted, enrichedLookups builds it from
 *  the model — and only past the reuse check, so a no-op recalculate never pays for it. */
export async function calculateProject(
  tenantId: string, projectId: string, run?: QueryRunner,
) {
  const [project] = await db
    .select({
      modelId: configProject.modelId, status: configProject.status, entries: configProject.entries,
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

  // Runs before the runner and the lookups resolve: a no-op recalculate must not pay for a
  // resolution it is about to throw away. The process page auto-calculates ~1s after every edit.
  if (project.calculatedAt && project.calculatedAt >= model.updatedAt) {
    return {
      projectVersion: project.updatedAt.toISOString(), reused: true,
      candidateCount: project.candidates.length, capped: project.candidates.length >= 200,
      widest: undefined, candidates: project.candidates,
    };
  }

  const lookups = await enrichedLookups(tenantId, model, entries, run);

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
        batchQty, outputs: computeOutputs(model.definition, lookups, assignment, batchQty, undefined, tableRows),
      })),
    }));

    // One row, overwritten in place: entries and candidates move together. calculatedAt going
    // non-null here is the only claim that they match — there is no status flag restating it.
    const now = new Date();
    const updated = await db.update(configProject)
      .set({ entries, batches, candidates, calculatedAt: now, updatedAt: now })
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

// Exact help: live B1 Orders + Quotations for the project customer and/or the item-code param.
// itemCode is only ever a quoted filter value.
export async function fetchDocHistory(
  tenantId: string,
  projectId: string,
  itemCode?: string,
): Promise<{ itemCode: string | null; cardCode: string | null; rows: DocRow[] }> {
  const [project] = await db
    .select({ customer: configProject.customer })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const trimmedItemCode = itemCode?.trim() || undefined;
  const cardCode = project.customer?.cardCode;
  if (!trimmedItemCode && !cardCode) return { itemCode: null, cardCode: null, rows: [] };

  const opts = { itemCode: trimmedItemCode, cardCode };
  const { b1 } = await tenantConnector(tenantId);
  // Two crossjoins in parallel — one per document type; B1 has no union.
  const [orders, quotes] = await viaB1(() =>
    Promise.all([
      b1.crossJoin(docHistoryQuery("Orders", opts)),
      b1.crossJoin(docHistoryQuery("Quotations", opts)),
    ]),
  );
  return {
    itemCode: trimmedItemCode ?? null,
    cardCode: cardCode ?? null,
    rows: sortDocRows([
      ...flattenDocs("order", orders.data, opts),
      ...flattenDocs("quotation", quotes.data, opts),
    ]),
  };
}

// Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
// the row's mapped param values, coerced to each param's type — what the Copy button applies.
export async function searchSimilarRows(tenantId: string, projectId: string, entries: Entries) {
  const [project] = await db
    .select({ modelId: configProject.modelId })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const model = await loadModel(tenantId, project.modelId);
  const h = model.definition.history;
  if (!h?.mappings.length) return { results: [] };
  const rows = await loadHistoryRows(tenantId, model.id);
  const typeOf = new Map(model.definition.parameters.map((p) => [p.key, p.type]));
  const coerce = (param: string, v: Val): Val =>
    v === null ? null
    : typeOf.get(param) === "number" ? (Number.isFinite(Number(v)) ? Number(v) : null)
    : typeOf.get(param) === "boolean" ? (typeof v === "boolean" ? v : String(v).toLowerCase() === "true")
    : String(v);
  return {
    results: scoreRows(h, entries, rows).map((s) => ({
      score: s.score,
      matches: s.matches,
      display: Object.fromEntries(h.display.map((c) => [c, s.row[c] ?? null])),
      values: Object.fromEntries(h.mappings.map((m) => [m.param, coerce(m.param, s.row[m.column] ?? null)])),
    })),
  };
}

// ---- Quotation write-back -------------------------------------------------------------------
// Numbers are recomputed from the persisted selection on both the draft and the post, so the
// browser can influence *which* selection is quoted (via commandId) and nothing else.

async function loadProject(tenantId: string, projectId: string) {
  const [project] = await db.select().from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId))).limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (!project.candidates.length)
    throw new ORPCError("BAD_REQUEST", { message: "Calculate the configuration before quoting" });
  return project;
}

export async function quoteDraft(tenantId: string, projectId: string) {
  const project = await loadProject(tenantId, projectId);
  const { model, lookups } = await liveEngine(tenantId, project);
  const commandId = configDocumentCommandId({
    tenantId, projectId, candidates: project.candidates, selection: project.selection ?? [],
    tables: project.tables,
  });
  return {
    commandId,
    data: buildQuoteSeed(project, model.definition, lookups),
    totals: quotedTotals(project, model.definition, lookups),
    quoted: project.b1DocEntry === null ? null : { docEntry: project.b1DocEntry, quotedAt: project.quotedAt },
  };
}

export async function createQuote(
  tenantId: string,
  input: { projectId: string; commandId: string; comments?: string; docDueDate?: string },
) {
  const project = await loadProject(tenantId, input.projectId);
  // Already posted: the row IS the idempotency record for a retry that got its response.
  if (project.b1DocEntry !== null)
    return { docEntry: project.b1DocEntry, docNum: null, reused: true, row: null, etag: null };

  const commandId = configDocumentCommandId({
    tenantId, projectId: input.projectId, candidates: project.candidates, selection: project.selection ?? [],
    tables: project.tables,
  });
  if (commandId !== input.commandId)
    throw new ORPCError("CONFLICT", { message: "STATE_CHANGED" });

  const { model, lookups } = await liveEngine(tenantId, project);
  const seed = buildQuoteSeed(project, model.definition, lookups);
  const { b1 } = await tenantConnector(tenantId);

  return viaB1(async () => {
    // Check-then-create against the dedup UDF. This covers the window the DB cannot: we POSTed,
    // B1 created the quotation, and our response never arrived.
    const existing = await b1.readEntitySet("Quotations", {
      filter: `${DEDUP_UDF} eq '${commandId}'`, select: ["DocEntry", "DocNum"], top: 1,
    }).catch((e) => {
      // Only a 400 means "no such property"; an unreachable agent or a rejected session is a
      // different problem and must keep its own status rather than becoming setup advice.
      if (e instanceof B1Error && e.status === 400)
        throw new ORPCError("BAD_REQUEST", {
          message: `Cannot check for an existing quotation: ${DEDUP_UDF} is missing from Sales Quotation in SAP. Create it (alphanumeric, length 64) and try again. (${e.message})`,
        });
      throw e;
    });
    const prior = rowsOf(existing.data)[0];

    // createEntity answers with the document itself (Prefer: return-representation), not a
    // collection — so this is `.data`, not `rowsOf(.data)[0]`.
    const created = prior ? null : await b1.createEntity("Quotations", {
      ...seed,
      [DEDUP_UDF]: commandId,
      ...(input.comments ? { Comments: input.comments } : {}),
      ...(input.docDueDate ? { DocDueDate: input.docDueDate } : {}),
    }, { prefer: "representation" });
    const doc = (prior ?? created?.data ?? {}) as Record<string, unknown>;
    const docEntry = Number(doc.DocEntry);
    if (!Number.isFinite(docEntry))
      throw new ORPCError("BAD_GATEWAY", { message: "SAP created the quotation but returned no DocEntry" });

    const totals = quotedTotals(project, model.definition, lookups);
    const now = new Date();
    await db.update(configProject)
      .set({
        status: "quoted", events: pushEvent("quoted"), updatedAt: now,
        b1DocEntry: docEntry, quotedAt: now,
        quotedValue: totals.value.toFixed(4), quotedCost: totals.cost.toFixed(4),
      })
      .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, tenantId)));
    return {
      docEntry,
      docNum: doc.DocNum === undefined ? null : Number(doc.DocNum),
      reused: !!prior,
      // The representation is the same document entities.one would read back, ETag and all, so
      // the browser seeds that query from here and opens the quotation without a second Service
      // Layer round trip. Null on the dedup path — that read selected two fields, not a document.
      row: created ? doc : null,
      etag: created?.etag ?? null,
    };
  });
}

export function applySelection(
  model: ModelDef, lookups: ResolvedLookups,
  candidates: ConfigCandidate[], selection: ConfigSelection[], tableRows?: TableRows,
): { candidateIdx: number; batchQty: number; outputs: Outputs }[] {
  return selection.map((s) => {
    const cand = candidates[s.candidateIdx];
    if (!cand) throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    try {
      const outputs = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides, tableRows);
      return { candidateIdx: s.candidateIdx, batchQty: s.batchQty, outputs };
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) throw new ORPCError("BAD_REQUEST", { message: e.message });
      throw e;
    }
  });
}

/** Append one event to config_project.events inside the same guarded UPDATE. */
export const pushEvent = (kind: ProjectEvent["kind"], note?: string) =>
  sql`${configProject.events} || ${JSON.stringify([{ at: new Date().toISOString(), kind, ...(note ? { note } : {}) }])}::jsonb`;

const SelectionZ = z.object({
  candidateIdx: z.number().int().min(0),
  batchQty: z.number().int().min(1),
  overrides: OutputOverridesZ.optional(),
});

/** `customer` is jsonb; the list reads the name out of it so a saved view can sort and filter on
 *  Customer like any other column. It used to be flattened in the browser, which only worked while
 *  the page held every row. */
const CUSTOMER_NAME = sql<string>`${configProject.customer}->>'cardName'`;

/** Filterable/sortable columns of the configurations list. Exported because portal.projects.rows is
 *  the same table with a narrower set — it must not offer Customer to the client who IS the customer. */
export const CONFIG_FIELDS: SqlFields = {
  name: { col: configProject.name, kind: "string" },
  modelName: { col: configModel.name, kind: "string" },
  customerName: { col: CUSTOMER_NAME, kind: "string" },
  status: { col: configProject.status, kind: "enum" },
  updatedAt: { col: configProject.updatedAt, kind: "date" },
};

/** The project row and the two facts about its last calculation — what a mutation returns, so the
 *  client patches its query cache from the response instead of refetching. Deliberately no model:
 *  it is a large jsonb document that cannot change under a calculate (the Model field locks as
 *  soon as a configuration has any input), so re-sending it on every keystroke would put the
 *  biggest thing on the wire for the one thing that never moved. */
async function projectState(
  tenantId: string,
  id: string,
  calc?: { capped: boolean; widest?: { key: string; size: number } },
) {
  const [project] = await db
    .select()
    .from(configProject)
    .where(and(eq(configProject.id, id), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  return {
    project,
    capped: calc?.capped ?? project.candidates.length >= 200,
    // ponytail: `widest` is a run-time hint only — a plain get (page reload) has no run to report,
    // same as calculateProject's reuse path. Store it on the row if the hint has to survive one.
    widest: calc?.widest,
  };
}

/** projectState plus the two things only a page load or a model switch can change. */
async function projectPayload(tenantId: string, id: string) {
  const state = await projectState(tenantId, id);
  const [model, [creator]] = await Promise.all([
    loadModel(tenantId, state.project.modelId),
    db.select({ email: user.email }).from(user).where(eq(user.id, state.project.createdBy)).limit(1),
  ]);
  return { ...state, model, createdByEmail: creator?.email ?? null };
}

export const configsRouter = {
  // Members can list models (id + name only) to start a configuration; editing stays admin-only.
  models: userProcedure.handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(configModel.name),
  ),

  list: userProcedure.handler(({ context }) =>
    db
      .select({
        id: configProject.id, name: configProject.name, status: configProject.status,
        customer: configProject.customer, modelName: configModel.name, updatedAt: configProject.updatedAt,
      })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .where(eq(configProject.tenantId, context.tenantId))
      .orderBy(desc(configProject.updatedAt)),
  ),

  /** One page of the configurations list for a saved view. Same wire shape as entities.rows, so
   *  ListReport pages a Postgres list exactly the way it pages a B1 entity set. `customerName` is
   *  flattened out of the `customer` jsonb here rather than in the browser: it has to be sortable
   *  and filterable server-side now that the page only ever holds one page. */
  rows: userProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileSpec(CONFIG_FIELDS, input.spec);
    const raw = await db
      .select({
        id: configProject.id, name: configProject.name, status: configProject.status,
        customerName: CUSTOMER_NAME, modelName: configModel.name, updatedAt: configProject.updatedAt,
        _total: TOTAL,
      })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .where(and(eq(configProject.tenantId, context.tenantId), where))
      // Newest first is the list's identity, not a default sort the user can lose; a saved view's
      // orderby goes in front of it. `id` last: OFFSET paging over a non-unique sort silently
      // duplicates and skips rows between pages, so the order has to be total.
      .orderBy(...orderBy, desc(configProject.updatedAt), configProject.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

  get: userProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(({ input, context }) => projectPayload(context.tenantId, input.id)),

  create: userProcedure
    // The new page collects these before insert. Name is required so a cancelled /configs/new
    // never leaves an unnamed row; customer can wait for the process page (needs a live B1).
    .input(z.object({
      modelId: z.uuid(),
      name: z.string().min(1),
      customer: z.object({ cardCode: z.string(), cardName: z.string() }).nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      const [ins] = await db
        .insert(configProject)
        .values({
          tenantId: context.tenantId, modelId: model.id, name: input.name,
          customer: input.customer ?? null,
          batches: model.definition.batchDefaults, createdBy: context.userId,
        })
        .returning({ id: configProject.id });
      return { id: ins!.id };
    }),

  // Copy the inputs, then recalculate so the copy opens against what SAP says now. Deliberately
  // no assertConfigMutable: duplicating a *quoted* configuration is the point — the source stays
  // locked and the copy is a fresh draft. Everything not named below takes its column default,
  // which is what clears status/candidates/calculatedAt/quoted*/b1DocEntry. b1DocEntry especially:
  // it is the quote idempotency record, so a copy inheriting it would refuse to post.
  duplicate: userProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configProject)
      .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)));
    if (!row) throw new ORPCError("NOT_FOUND");
    const taken = await db
      .select({ name: configProject.name })
      .from(configProject)
      .where(eq(configProject.tenantId, context.tenantId));
    const [ins] = await db
      .insert(configProject)
      .values({
        tenantId: context.tenantId, modelId: row.modelId,
        // configs.create inserts an empty name, so a copy of a not-yet-named draft would be
        // called " (copy)" without the fallback.
        name: copyName(row.name.trim() || "Configuration", taken.map((t) => t.name)),
        customer: row.customer, entries: row.entries, batches: row.batches, tables: row.tables,
        // Not row.source: an internal copy of a portal request must not show up in that client's
        // "My requests" list, which filters on source = "portal".
        createdBy: context.userId,
      })
      .returning({ id: configProject.id });
    const id = ins!.id;
    // ponytail: roll the copy back on a failed recompute, so a Duplicate that errors leaves
    // nothing behind. Two lines to flip to "keep it as an uncalculated draft" if failing on a
    // down agent turns out to annoy more than the orphan row would.
    try {
      await calculateProject(context.tenantId, id);
    } catch (e) {
      await db.delete(configProject).where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)));
      throw e;
    }
    return { id };
  }),

  update: userProcedure
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().min(1).optional(),
        modelId: z.uuid().optional(),
        // ponytail: shape only, no SAP existence check — the UI picks CardCode through a
        // BusinessPartners value help, so a bad code has to be hand-crafted against the API.
        // Read the BP here (as portalClients.invite does) if that stops being good enough.
        customer: z.object({ cardCode: z.string(), cardName: z.string() }).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await assertConfigMutable(context.tenantId, input.id);
      const { id, ...rest } = input;
      const fields: Partial<typeof configProject.$inferInsert> = { ...rest, updatedAt: new Date() };
      // entries/batches/tables are configs.calculate's, not this handler's: they cannot be written
      // without recomputing what they produce.
      //
      // Switching the model invalidates every entry (a param key only means something inside its
      // own model), so entries/batches start over. Only on an actual change — re-sending the same
      // modelId must not wipe a configuration. loadModel also proves the model is this tenant's.
      if (input.modelId !== undefined) {
        const [cur] = await db
          .select({ modelId: configProject.modelId })
          .from(configProject)
          .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)))
          .limit(1);
        if (!cur) throw new ORPCError("NOT_FOUND");
        if (cur.modelId !== input.modelId) {
          const model = await loadModel(context.tenantId, input.modelId);
          fields.entries = {};
          fields.batches = model.definition.batchDefaults;
          fields.tables = {}; // a table key only means something inside its own model, like a param key
          // Candidates go with the inputs that produced them, or the page renders the old model's
          // assignments against the new definition.
          fields.candidates = [];
          fields.calculatedAt = null;
        }
      }
      const updated = await db
        .update(configProject)
        .set(fields)
        .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)))
        .returning({ id: configProject.id });
      if (!updated.length) throw new ORPCError("NOT_FOUND");
      return projectPayload(context.tenantId, id);
    }),

  // One delete path: the object page passes its single id in the same array the list report's
  // bulk action passes. One statement either way, so a partial delete is not a state that exists.
  // Quoted is the same lock as update/calculate/select (the SAP document stays the system of
  // record). Checked up front so a mixed list selection is all-or-nothing, like models.remove —
  // not assertConfigMutable per id, which would NOT_FOUND a stale row the current delete ignores.
  remove: userProcedure.input(z.object({ ids: z.array(z.uuid()).min(1) })).handler(async ({ input, context }) => {
    const quoted = await db
      .select({ id: configProject.id })
      .from(configProject)
      .where(and(
        inArray(configProject.id, input.ids),
        eq(configProject.tenantId, context.tenantId),
        eq(configProject.status, "quoted"),
      ))
      .limit(1);
    if (quoted.length)
      throw new ORPCError("CONFLICT", { message: "Configuration is quoted and locked" });
    await db.delete(configProject).where(and(inArray(configProject.id, input.ids), eq(configProject.tenantId, context.tenantId)));
    return { ok: true };
  }),

  // Resolved lookups for client-side live propagation (wizard step 1). Cached ~5 min; key includes
  // the model's updatedAt so a model save is picked up immediately. Query tables contain the same
  // canonical first page used by runs and portal imports.
  lookups: userProcedure
    .input(z.object({ modelId: z.uuid(), entries: EntriesZ.optional() }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      return enrichedLookups(context.tenantId, model, input.entries ?? {});
    }),

  // Value help paging for a query-backed parameter (see queryTablePage).
  queryPage: userProcedure.input(QueryPageZ).handler(async ({ input, context }) => {
    await loadModel(context.tenantId, input.modelId); // the model must exist and be this tenant's
    return queryTablePage(context.tenantId, input);
  }),

  // Exact help: live B1 Orders + Quotations for the project customer and/or the item-code param.
  // itemCode comes from the client (current unsaved entry); it is only ever a quoted filter value.
  docHistory: userProcedure
    .input(z.object({ id: z.uuid(), itemCode: z.string().optional() }))
    .handler(({ input, context }) => fetchDocHistory(context.tenantId, input.id, input.itemCode)),

  // Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
  // the row's mapped param values, coerced to each param's type — what the Copy button applies.
  similar: userProcedure
    .input(z.object({ id: z.uuid(), entries: EntriesZ }))
    .handler(({ input, context }) => searchSimilarRows(context.tenantId, input.id, input.entries)),

  // Edit and recalculate in one round trip. The process page auto-calculates ~1s after every field
  // edit, and update -> get -> run -> get was four calls for one keystroke's worth of change.
  // Returns exactly what `get` returns, so the client sets its cache from the response.
  calculate: userProcedure
    .input(z.object({
      id: z.uuid(),
      entries: EntriesZ.optional(),
      batches: z.array(z.number().int().min(1)).optional(),
      tables: TableRowsZ.optional(),
    }))
    .handler(async ({ input, context }) => {
      await assertConfigMutable(context.tenantId, input.id);
      const { id, ...edits } = input;
      // Inputs and candidates move in ONE statement: a concurrent reader sees either the old pair
      // or the new inputs with no candidates, never a mismatched pair. That is what replaces the
      // old `status === "calculated"` convention. Deliberately not one transaction with the
      // recompute — a calc that throws (conflict, no valid candidate) must still keep the edits,
      // and calculateProject's own UPDATE is what makes the result durable.
      if (Object.keys(edits).length) {
        const written = await db
          .update(configProject)
          .set({ ...edits, candidates: [], calculatedAt: null, updatedAt: new Date() })
          .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId)))
          .returning({ id: configProject.id });
        if (!written.length) throw new ORPCError("NOT_FOUND");
      }
      // No edits is the live case, not a no-op: it is how a fresh draft, or one whose model was
      // just switched, gets its first calculation.
      return projectState(context.tenantId, id, await calculateProject(context.tenantId, id));
    }),

  // Store the user's candidate/batch/override picks; totals are recomputed HERE against the live
  // model and lookups — client-sent numbers are never persisted. The FOR UPDATE below is the fence.
  select: userProcedure
    .input(z.object({
      projectId: z.uuid(),
      selection: z.array(SelectionZ).min(1),
    }))
    .handler(async ({ input, context }) => {
      // Lookups resolve outside the transaction: they can involve a round trip to the customer's
      // agent, and holding a row lock across that is how you get a pile of stuck writers.
      const [pre] = await db
        .select({ modelId: configProject.modelId, entries: configProject.entries })
        .from(configProject)
        .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
        .limit(1);
      if (!pre) throw new ORPCError("NOT_FOUND");
      const { model, lookups } = await liveEngine(context.tenantId, pre);

      await db.transaction(async (tx) => {
        const [project] = await tx
          .select({ candidates: configProject.candidates, tables: configProject.tables })
          .from(configProject)
          .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)))
          .for("update");
        if (!project) throw new ORPCError("NOT_FOUND");
        await assertConfigMutable(context.tenantId, input.projectId, tx);
        validateSelectionPairs(project.candidates, input.selection);
        // Pricing gate, result discarded: validateSelectionPairs proves the candidate/batch pairs
        // exist, but only computeOutputs proves the user's *overrides* can be priced at all. Let a
        // DslError through here and it resurfaces at quoteDraft, against a locked project.
        applySelection(model.definition, lookups, project.candidates, input.selection, project.tables);
        await tx
          .update(configProject)
          .set({ selection: input.selection })
          .where(and(eq(configProject.id, input.projectId), eq(configProject.tenantId, context.tenantId)));
      });
      return projectState(context.tenantId, input.projectId);
    }),

  // What will be posted to B1, recomputed from the persisted project. The commandId comes back
  // with it and is echoed by createQuote, so the client can never widen the selection between
  // preview and post.
  quoteDraft: userProcedure
    .input(z.object({ projectId: z.uuid() }))
    .handler(({ input, context }) => quoteDraft(context.tenantId, input.projectId)),

  createQuote: userProcedure
    .input(z.object({
      projectId: z.uuid(),
      commandId: z.string().length(64),
      // Only these two are the salesperson's to set; every number is recomputed server-side.
      comments: z.string().max(2000).optional(),
      docDueDate: z.iso.date().optional(),
    }))
    .handler(({ input, context }) => createQuote(context.tenantId, input)),

  // Internal reviewer sends a portal request back with a note. requested → rejected.
  reject: userProcedure
    .input(z.object({ id: z.uuid(), note: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const updated = await db
        .update(configProject)
        .set({ status: "rejected", rejectionNote: input.note, events: pushEvent("rejected", input.note), updatedAt: new Date() })
        .where(and(
          eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId),
          eq(configProject.status, "requested"),
        ))
        .returning({ id: configProject.id });
      if (!updated.length) throw new ORPCError("BAD_REQUEST", { message: "Only a requested configuration can be rejected" });
      return projectState(context.tenantId, input.id);
    }),
};
