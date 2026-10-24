import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, configModel, configProject, portalCompany, user } from "@confire/db";
import { EntriesZ, syncTables, TableRowsZ, type Entries, type Val } from "@confire/config-engine";
import { userProcedure } from "../base.ts";
import { tenantCompany } from "../../b1.ts";
import { queryRowOf } from "../../lookups.ts";
import { ensureFresh, rowCache, syncNow } from "../../masterdata-sync.ts";
import { compileQuery, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { scoreRows } from "../../similarity.ts";
import { copyName } from "../../copy-name.ts";
import {
  cachedLookups, calculateProject, liveEngine, loadModel, masterdataRows, QueryPageZ, queryTablePage,
} from "../../config-project.ts";
import { applySelection, createQuote, quoteDraft, validateSelectionPairs } from "../../config-quote.ts";
import { assertWritable, internalVisible, recordCreated, writableBy } from "../../project-lifecycle.ts";
// The configuration process API: any member drives a project (draft -> quoted), and staff work a
// client's request here once it is submitted (spec §10). The engine itself lives in
// config-project.ts, shared with the portal process.
// Trust model: browser propagates for preview; THESE handlers compute the numbers that get
// stored. Lookups: ~5-min cache for interactive use, always fresh inside calculateProject.

/** A project staff can see: this tenant's, and never a client's draft. */
const visible = (tenantId: string, id: string) =>
  and(eq(configProject.id, id), eq(configProject.tenantId, tenantId), internalVisible);

// Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
// the row's mapped param values, coerced to each param's type — what the Copy button applies.
export async function searchSimilarRows(tenantId: string, projectId: string, entries: Entries) {
  const [project] = await db
    .select({ modelId: configProject.modelId })
    .from(configProject)
    .where(visible(tenantId, projectId))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  const model = await loadModel(tenantId, project.modelId);
  const h = model.definition.history;
  if (!h?.mappings.length || !h.table) return { results: [] };
  // The history query is an ordinary masterdata query now, cached by the same sync as every other
  // one — there is no config_history table and no second sync path behind this any more.
  const md = await masterdataRows(tenantId);
  const source = queryRowOf(md, h.table);
  if (!source) return { results: [] };
  ensureFresh(tenantId, [source]);
  const rows = (await rowCache(tenantId)(source.id)) as Record<string, Val>[];
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

const SelectionZ = z.object({
  candidateIdx: z.number().int().min(0),
  batchQty: z.number().int().min(1),
});

/** `customer` is jsonb; the list reads the name out of it so a saved view can sort and filter on
 *  Customer like any other column. It used to be flattened in the browser, which only worked while
 *  the page held every row. */
const CUSTOMER_NAME = sql<string>`${configProject.customer}->>'cardName'`;

/** Filterable/sortable columns of the configurations list. `mine` is per caller, so the fields are too. */
const configFields = (userId: string): SqlFields => ({
  name: { col: configProject.name, kind: "string" },
  modelName: { col: configModel.name, kind: "string" },
  customerName: { col: CUSTOMER_NAME, kind: "string" },
  status: { col: configProject.status, kind: "enum" },
  mine: { col: sql<string>`case when ${configProject.createdBy} = ${userId} then 'yes' else 'no' end`, kind: "enum" },
  updatedAt: { col: configProject.updatedAt, kind: "date" },
});

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
    .where(visible(tenantId, id))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  return {
    project,
    // The SAP company the agent serves now: the page links the quotation only when it is the
    // project's b1Company (a DocEntry means nothing in another company).
    sapCompany: await tenantCompany(tenantId),
    capped: calc?.capped ?? project.candidates.length >= 200,
    // ponytail: `widest` is a run-time hint only — a plain get (page reload) has no run to report,
    // same as calculateProject's reuse path. Store it on the row if the hint has to survive one.
    widest: calc?.widest,
  };
}

/** projectState plus what only a page load, a model switch or a lifecycle action can change: the
 *  model, and for a client's request the company and the assignee's name. */
async function projectPayload(tenantId: string, id: string) {
  const state = await projectState(tenantId, id);
  const { project } = state;
  const model = await loadModel(tenantId, project.modelId);
  let request = null;
  if (project.portalCardCode !== null) {
    const [company] = await db.select({ cardCode: portalCompany.cardCode, cardName: portalCompany.cardName })
      .from(portalCompany)
      .where(and(eq(portalCompany.tenantId, tenantId), eq(portalCompany.cardCode, project.portalCardCode))).limit(1);
    const [assignee] = project.assigneeId
      ? await db.select({ name: user.name }).from(user).where(eq(user.id, project.assigneeId)).limit(1)
      : [];
    request = { cardCode: company?.cardCode ?? "", cardName: company?.cardName ?? "", assigneeName: assignee?.name ?? null };
  }
  return { ...state, model, request };
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
      // The staff's own work list: a client's request lives in Requests (spec §10).
      .where(and(eq(configProject.tenantId, context.tenantId), isNull(configProject.portalCardCode)))
      .orderBy(desc(configProject.updatedAt)),
  ),

  /** One page of the configurations list for a saved view. Same wire shape as entities.rows, so
   *  ListReport pages a Postgres list exactly the way it pages a B1 entity set. `customerName` is
   *  flattened out of the `customer` jsonb here rather than in the browser: it has to be sortable
   *  and filterable server-side now that the page only ever holds one page. */
  rows: userProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileQuery(configFields(context.userId), input.query);
    const raw = await db
      .select({
        id: configProject.id, name: configProject.name, status: configProject.status,
        customerName: CUSTOMER_NAME, modelName: configModel.name, updatedAt: configProject.updatedAt,
        _total: TOTAL,
      })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .where(and(eq(configProject.tenantId, context.tenantId), isNull(configProject.portalCardCode), where))
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
      return db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(configProject)
          .values({
            tenantId: context.tenantId, modelId: model.id, name: input.name,
            customer: input.customer ?? null,
            batches: model.definition.batchDefaults, createdBy: context.userId,
          })
          .returning({ id: configProject.id });
        await recordCreated(tx, context.tenantId, ins!.id, { userId: context.userId, side: "internal" });
        return { id: ins!.id };
      });
    }),

  // Copy the inputs, then recalculate so the copy opens against what SAP says now. Deliberately
  // no assertWritable: duplicating a *quoted* configuration is the point — the source stays
  // locked and the copy is a fresh draft. Everything not named below takes its column default,
  // which is what clears status/candidates/calculatedAt/quoted*/b1DocEntry. b1DocEntry especially:
  // it is the quote idempotency record, so a copy inheriting it would refuse to post.
  // A client's request duplicates into an internal configuration: the copy is the staff's own.
  duplicate: userProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configProject)
      .where(visible(context.tenantId, input.id));
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
        createdBy: context.userId,
      })
      .returning({ id: configProject.id });
    const id = ins!.id;
    await recordCreated(db, context.tenantId, id, { userId: context.userId, side: "internal" });
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
        // Read the BP here if a hand-crafted code starts showing up on quotations.
        customer: z.object({ cardCode: z.string(), cardName: z.string() }).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const p = await assertWritable(context.tenantId, input.id, { userId: context.userId, side: "internal" });
      // The model was the client's pick and the customer is the company (spec §7).
      if (p.portalCardCode !== null && (input.modelId !== undefined || input.customer !== undefined))
        throw new ORPCError("BAD_REQUEST", { message: "A request's model and customer are the client's" });
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
          fields.selection = null;
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
  // not assertWritable per id, which would NOT_FOUND a stale row the current delete ignores.
  // A client's request is declined, never deleted by staff: it is the client's record too.
  remove: userProcedure.input(z.object({ ids: z.array(z.uuid()).min(1) })).handler(async ({ input, context }) => {
    const locked = await db
      .select({ status: configProject.status, portal: configProject.portalCardCode })
      .from(configProject)
      .where(and(
        inArray(configProject.id, input.ids),
        eq(configProject.tenantId, context.tenantId),
        sql`(${configProject.status} = 'quoted' or ${isNotNull(configProject.portalCardCode)})`,
      ))
      .limit(1);
    if (locked.length)
      throw new ORPCError("CONFLICT", {
        message: locked[0]!.portal ? "A client's request can't be deleted — decline it instead" : "Configuration is quoted and locked",
      });
    await db.delete(configProject).where(and(inArray(configProject.id, input.ids), eq(configProject.tenantId, context.tenantId), isNull(configProject.portalCardCode)));
    return { ok: true };
  }),

  // Resolved lookups for client-side live propagation, plus the sync state of the tables they
  // came from. Postgres only: this call cannot fail because SAP is down, which is what lets the
  // form render every section, parameter, BOM and routing line with the agent switched off.
  lookups: userProcedure
    .input(z.object({ modelId: z.uuid(), entries: EntriesZ.optional() }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      const md = await masterdataRows(context.tenantId);
      const lookups = await cachedLookups(context.tenantId, model, input.entries ?? {}, {}, undefined, md);
      const named = syncTables(model.definition);
      return {
        ...lookups,
        // Freshness travels with the data rather than in a second query: the page shows "synced
        // 3 h ago" or the last sync's error without having to ask again.
        sync: md
          .filter((r) => r.kind === "query" && named.has(r.name))
          .map((r) => ({
            table: r.name, syncedAt: r.syncedAt ?? null, syncError: r.syncError ?? null,
            rowCount: r.rowCount ?? 0,
          })),
      };
    }),

  /** Refill the cache for every query table this configuration's model reads. The toolbar button;
   *  unlike the background refresh it reports failure, because a user asked for it. */
  sync: userProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context }) => {
      const [project] = await db
        .select({ modelId: configProject.modelId })
        .from(configProject)
        .where(visible(context.tenantId, input.id))
        .limit(1);
      if (!project) throw new ORPCError("NOT_FOUND");
      const model = await loadModel(context.tenantId, project.modelId);
      const named = syncTables(model.definition);
      const due = (await masterdataRows(context.tenantId)).filter((r) => r.kind === "query" && !!r.query && named.has(r.name));
      // Sequential on purpose: each one walks every page of a B1 read, and firing them together
      // would point N concurrent multi-page walks at one customer's Service Layer.
      let count = 0;
      for (const md of due) count += (await syncNow(context.tenantId, md as never)).count;
      return { tables: due.length, count };
    }),

  // Value help paging for a query-backed parameter (see queryTablePage).
  queryPage: userProcedure.input(QueryPageZ).handler(async ({ input, context }) => {
    await loadModel(context.tenantId, input.modelId); // the model must exist and be this tenant's
    return queryTablePage(context.tenantId, input);
  }),

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
      await assertWritable(context.tenantId, input.id, { userId: context.userId, side: "internal" });
      const { id, ...edits } = input;
      // Inputs and candidates move in ONE statement: a concurrent reader sees either the old pair
      // or the new inputs with no candidates, never a mismatched pair. That is what replaces the
      // old `status === "calculated"` convention. Deliberately not one transaction with the
      // recompute — a calc that throws (conflict, no valid candidate) must still keep the edits,
      // and calculateProject's own UPDATE is what makes the result durable.
      if (Object.keys(edits).length) {
        const written = await db
          .update(configProject)
          .set({ ...edits, candidates: [], selection: null, calculatedAt: null, updatedAt: new Date() })
          .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId), writableBy("internal")))
          .returning({ id: configProject.id });
        if (!written.length) throw new ORPCError("CONFLICT", { message: "The configuration changed hands meanwhile — reload it" });
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
      // Empty is a save too (unpicking the last cell); buildQuoteSeed is what refuses to quote it.
      selection: z.array(SelectionZ),
    }))
    .handler(async ({ input, context }) => {
      // Lookups resolve outside the transaction: they can involve a round trip to the customer's
      // agent, and holding a row lock across that is how you get a pile of stuck writers.
      const [pre] = await db
        .select({ modelId: configProject.modelId, entries: configProject.entries, tables: configProject.tables })
        .from(configProject)
        .where(visible(context.tenantId, input.projectId))
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
        await assertWritable(context.tenantId, input.projectId, { userId: context.userId, side: "internal" }, tx);
        validateSelectionPairs(project.candidates, input.selection);
        // Pricing gate, result discarded: validateSelectionPairs proves the candidate/batch pairs
        // exist, but only computeOutputs proves they still price against today's cache — a price
        // line can vanish since the calculation. Let a DslError through here and it resurfaces at
        // quoteDraft, against a locked project.
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
      // Header fields only, and only the ones QUOTE_HEADER names — filtered in the handler so a
      // rejection can name them. Every number on the document is recomputed server-side.
      header: z.record(z.string(), z.unknown()).optional(),
    }))
    .handler(({ input, context }) => createQuote(context.tenantId, context.userId, input)),
};
