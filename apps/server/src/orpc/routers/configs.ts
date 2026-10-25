import { ORPCError } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import { z } from "zod";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, configModel, configProject, portalCompany, user } from "@confire/db";
import { EntriesZ, syncTables, type Entries, type Val } from "@confire/config-engine";
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
import { PatchZ, SourcesZ, patchColumns, patchProblems, touchesEngine, writtenOf } from "../../config-patch.ts";
import { configView } from "../../config-view.ts";
import { applySelection, createQuote, quoteDraft, validateSelectionPairs } from "../../config-quote.ts";
import { assertWritable, internalVisible, recordCreated, writableBy } from "../../project-lifecycle.ts";
// The configuration process API: any member drives a project (draft -> quoted), and staff work a
// client's request here once it is submitted (spec §10). The engine itself lives in
// config-project.ts, shared with the portal process.
// Trust model: the server is the one source of every figure. The page sends what the user changed
// and draws the view it gets back (config-view.ts); the engine runs in the browser only in the model
// builder's preview of an unsaved model.
//
// The process, as a client (the page, or an MCP client) walks it: create → get → calculate until
// `missing` is empty → select → quoteDraft → createQuote. Alongside: queryPage to search a value
// help's options, similar for history, update to switch the model.

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
  candidateIdx: z.number().int().min(0).describe("Index into the view's candidates.rows"),
  batchQty: z.number().int().min(1).describe("One of the configuration's batch quantities"),
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

/** The company and assignee of a client's request; null for an internal configuration. */
async function requestOf(tenantId: string, p: { portalCardCode: string | null; assigneeId: string | null }) {
  if (p.portalCardCode === null) return null;
  const [company] = await db.select({ cardCode: portalCompany.cardCode, cardName: portalCompany.cardName })
    .from(portalCompany)
    .where(and(eq(portalCompany.tenantId, tenantId), eq(portalCompany.cardCode, p.portalCardCode))).limit(1);
  const [assignee] = p.assigneeId
    ? await db.select({ name: user.name }).from(user).where(eq(user.id, p.assigneeId)).limit(1)
    : [];
  return { cardCode: company?.cardCode ?? "", cardName: company?.cardName ?? "", assigneeName: assignee?.name ?? null };
}

/** What every edit answers: the view, plus the SAP company the agent serves now — the page links
 *  the quotation only when it is the project's b1Company (a DocEntry means nothing in another).
 *  Deliberately no model: it is a large jsonb document an edit cannot change, so the client keeps
 *  the one `get` gave it and merges this over it. */
async function viewOf(tenantId: string, id: string) {
  const { live, view } = await configView(tenantId, visible(tenantId, id)!);
  return { ...view, sapCompany: await tenantCompany(tenantId), live };
}

/** viewOf plus what only a page load, a model switch or a lifecycle action can change: the model,
 *  and for a client's request the company and the assignee's name. */
async function fullView(tenantId: string, id: string) {
  const { live, ...view } = await viewOf(tenantId, id);
  const m = live.model;
  return { ...view, model: { id: m.id, name: m.name, definition: m.definition }, request: await requestOf(tenantId, live.row) };
}

/** What a partial answer is: the view without `live` (server-side only). */
const partial = async (tenantId: string, id: string) => {
  const { live: _live, ...view } = await viewOf(tenantId, id);
  return view;
};

export const Customer = z.object({ cardCode: z.string().min(1), cardName: z.string() });

/** A new configuration of a model, and its `created` event in the same transaction. The assistant's
 *  start passes `via` so the timeline says who made it. */
export async function createProject(
  tenantId: string, userId: string, input: { modelId: string; name: string; customer?: z.infer<typeof Customer> | null },
  via?: "assistant",
) {
  const model = await loadModel(tenantId, input.modelId);
  return db.transaction(async (tx) => {
    const [ins] = await tx
      .insert(configProject)
      .values({
        tenantId, modelId: model.id, name: input.name, customer: input.customer ?? null,
        batches: model.definition.batchDefaults, createdBy: userId,
      })
      .returning({ id: configProject.id });
    await recordCreated(tx, tenantId, ins!.id, { userId, side: "internal" }, via ? { via } : undefined);
    return { id: ins!.id };
  });
}

export const configsRouter = {
  // Members can list models (id + name only) to start a configuration; editing stays admin-only.
  models: userProcedure
    .meta(openapi({ summary: "List the models", description: "Every model a configuration can be started from: id, name, and the author's description of what it configures." }))
    .handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name, description: sql<string | null>`${configModel.definition}->>'description'` })
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
    .meta(openapi({
      summary: "Read a configuration",
      description: "The configuration as the process page shows it: its fields, the model, the form state of every parameter (value, options, visibility, requiredness, price badge), what is still `missing`, the candidates with their prices per batch quantity, the cost breakdown per batch quantity, and the messages (`issues`). A stale calculation is brought up to date first. Fill what `missing` lists with `configs.calculate`.",
    }))
    .input(z.object({ id: z.uuid().describe("The configuration's id") }))
    .handler(({ input, context }) => fullView(context.tenantId, input.id)),

  create: userProcedure
    .meta(openapi({
      summary: "Start a configuration",
      description: "Create a configuration of a model (see `configs.models`), named, optionally for a customer. Answers its id; read it with `configs.get`.",
    }))
    // The new page collects these before insert. Name is required so a cancelled /configs/new
    // never leaves an unnamed row; customer can wait for the process page (needs a live B1).
    .input(z.object({
      modelId: z.uuid().describe("The model to configure"),
      name: z.string().trim().min(1).describe("The configuration's name"),
      customer: Customer.nullable().optional().describe("The SAP business partner the quotation will go to"),
    }))
    .handler(({ input, context }) => createProject(context.tenantId, context.userId, input)),

  // Copy the inputs, then recalculate so the copy opens against what the cache says now. Deliberately
  // no assertWritable: duplicating a *quoted* configuration is the point — the source stays
  // locked and the copy is a fresh draft. Everything not named below takes its column default,
  // which is what clears status/candidates/calculatedAt/quoted*/b1DocEntry. b1DocEntry especially:
  // it is the quote idempotency record, so a copy inheriting it would refuse to post.
  // A client's request duplicates into an internal configuration: the copy is the staff's own.
  duplicate: userProcedure
    .meta(openapi({ summary: "Duplicate a configuration", description: "Copy a configuration's inputs into a new draft, quoted ones included, and calculate it. Answers the copy's id." }))
    .input(z.object({ id: z.uuid().describe("The configuration to copy") })).handler(async ({ input, context }) => {
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
        customer: row.customer, entries: row.entries, batches: row.batches, tables: row.tables, sources: row.sources,
        createdBy: context.userId,
      })
      .returning({ id: configProject.id });
    const id = ins!.id;
    await recordCreated(db, context.tenantId, id, { userId: context.userId, side: "internal" });
    // A calculation that cannot complete is state now, not an error: the copy stays, as a draft
    // whose page says why.
    await calculateProject(context.tenantId, id);
    return { id };
  }),

  // The model switch, and nothing else: it wipes every input, so it stays a separate, deliberate
  // act. Every field the user fills is configs.calculate.
  update: userProcedure
    .meta(openapi({
      summary: "Switch a configuration's model",
      description: "Point a configuration at another model. Every parameter value, batch quantity and table row starts over (a key only means something inside its own model); re-sending the current model changes nothing. Refused on a client's request, whose model was the client's pick. Answers what `configs.get` answers.",
    }))
    .input(z.object({ id: z.uuid().describe("The configuration's id"), modelId: z.uuid().describe("The model to switch to") }))
    .handler(async ({ input, context }) => {
      const p = await assertWritable(context.tenantId, input.id, { userId: context.userId, side: "internal" });
      if (p.portalCardCode !== null) throw new ORPCError("BAD_REQUEST", { message: "A request's model is the client's" });
      const [cur] = await db
        .select({ modelId: configProject.modelId })
        .from(configProject)
        .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId)))
        .limit(1);
      if (!cur) throw new ORPCError("NOT_FOUND");
      // loadModel also proves the model is this tenant's.
      if (cur.modelId !== input.modelId) {
        const model = await loadModel(context.tenantId, input.modelId);
        const updated = await db
          .update(configProject)
          .set({
            modelId: model.id, entries: {}, batches: model.definition.batchDefaults, tables: {}, sources: {},
            // Candidates go with the inputs that produced them, or the page renders the old
            // model's assignments against the new definition.
            candidates: [], selection: null, calculatedAt: null, updatedAt: new Date(),
          })
          .where(and(eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId), writableBy("internal")))
          .returning({ id: configProject.id });
        if (!updated.length) throw new ORPCError("CONFLICT", { message: "The configuration changed hands meanwhile — reload it" });
      }
      return fullView(context.tenantId, input.id);
    }),

  // One delete path: the object page passes its single id in the same array the list report's
  // bulk action passes. One statement either way, so a partial delete is not a state that exists.
  // Quoted is the same lock as update/calculate/select (the SAP document stays the system of
  // record). Checked up front so a mixed list selection is all-or-nothing, like models.remove —
  // not assertWritable per id, which would NOT_FOUND a stale row the current delete ignores.
  // A client's request is declined, never deleted by staff: it is the client's record too.
  remove: userProcedure
    .meta(openapi({ summary: "Delete configurations", description: "Delete drafts. Refused for a quoted configuration and for a client's request (decline it instead), all or nothing." }))
    .input(z.object({ ids: z.array(z.uuid()).min(1).describe("The configurations to delete") })).handler(async ({ input, context }) => {
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

  // The display tables a form draws from: value-help seeds, the table cells' options. Display data,
  // not an input to any figure, and moved only by a sync — so a cached query of its own, rather
  // than more weight on every edit's answer. Postgres only: it renders with the agent switched off.
  lookups: userProcedure
    .meta(openapi({
      summary: "A model's option tables",
      description: "The masterdata tables a model's fields and table cells pick from, first page of each query table. Display data for drawing a form; the options a field offers right now are in `configs.get`'s form state.",
    }))
    .input(z.object({ modelId: z.uuid().describe("The model") }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      return { tables: (await cachedLookups(context.tenantId, model)).tables };
    }),

  /** Refill the cache for every query table this configuration's model reads. The toolbar button;
   *  unlike the background refresh it reports failure, because a user asked for it. */
  sync: userProcedure
    .meta(openapi({ summary: "Refresh a configuration's data from SAP", description: "Refill the cache of every SAP query table this configuration's model reads, one after another. Answers how many tables and rows; read the configuration again for the new prices." }))
    .input(z.object({ id: z.uuid().describe("The configuration's id") }))
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
  queryPage: userProcedure
    .meta(openapi({
      summary: "Search a field's options",
      description: "One page of a query table a model names, for a field whose options come from SAP: search it (`search` over `searchCols`), page it (`cursor` is the next row offset, `nextSkip` in the answer), or look one key up exactly (`match`).",
    }))
    .input(QueryPageZ).handler(async ({ input, context }) => {
    await loadModel(context.tenantId, input.modelId); // the model must exist and be this tenant's
    return queryTablePage(context.tenantId, input);
  }),

  // Similarity help: rank cached historic rows against the live (unsaved) entries. `values` are
  // the row's mapped param values, coerced to each param's type — what the Copy button applies.
  similar: userProcedure
    .meta(openapi({
      summary: "Find similar past documents",
      description: "Rank the model's history rows against the given parameter values, best first. Each result's `values` can be written back with `configs.calculate`'s `set`.",
    }))
    .input(z.object({ id: z.uuid().describe("The configuration's id"), entries: EntriesZ.describe("The parameter values to match, by key") }))
    .handler(({ input, context }) => searchSimilarRows(context.tenantId, input.id, input.entries)),

  // One edit is one call: write what changed and answer the view it produced. The page sends a
  // commit at once (a field's change, a pick, a row), one call in flight; there is no timer.
  calculate: userProcedure
    .meta(openapi({
      summary: "Fill in a configuration",
      description: "Write what changed — the name, the customer, parameter values (`set`), cleared parameters (`unset`), the batch quantities, whole tables — and answer the configuration as `configs.get` does, without the model. A field not named is left alone, so two clients editing different fields never overwrite each other. Refused with one message naming every problem: a key that is not a parameter, a read-only parameter, a value of the wrong type, a table or column the model does not declare, or a configuration that is quoted or not in review. Candidates are calculated once `missing` is empty; a calculation that cannot complete keeps the inputs and says why in `calculation`. Call with only the id to read the current state.",
    }))
    .input(z.object({
      id: z.uuid().describe("The configuration's id"),
      name: z.string().trim().min(1).optional().describe("Rename the configuration"),
      // ponytail: shape only, no SAP existence check — the UI picks CardCode through a
      // BusinessPartners value help, so a bad code has to be hand-crafted against the API.
      // Read the BP here if a hand-crafted code starts showing up on quotations.
      customer: Customer.nullable().optional().describe("The SAP business partner the quotation goes to (CardCode and CardName); null clears it"),
      ...PatchZ,
      sources: SourcesZ.optional()
        .describe("Where each written value came from, by field key (a parameter, a table, `batches` or `customer`): the exact text read off a file with its page, or the user's own words. Optional; the in-app assistant always sends it."),
    }))
    .handler(async ({ input, context }) => {
      const { id, name, customer, sources, ...patch } = input;
      const other = customer !== undefined ? { customer } : {};
      const written = writtenOf(patch, other);
      for (const k of Object.keys(sources ?? {}))
        if (!(k in written)) throw new ORPCError("BAD_REQUEST", { message: `sources: ${k} is not written by this call` });
      const p = await assertWritable(context.tenantId, id, { userId: context.userId, side: "internal" });
      // The customer is the company (spec §7).
      if (p.portalCardCode !== null && customer !== undefined)
        throw new ORPCError("BAD_REQUEST", { message: "A request's customer is the client's" });
      const engine = touchesEngine(patch);
      if (engine) {
        const [row] = await db.select({ modelId: configProject.modelId }).from(configProject)
          .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId))).limit(1);
        const problems = patchProblems((await loadModel(context.tenantId, row!.modelId)).definition, patch, "internal");
        if (problems.length) throw new ORPCError("BAD_REQUEST", { message: `Not accepted: ${problems.join("; ")}` });
      }
      if (engine || name !== undefined || customer !== undefined || sources !== undefined) {
        // Inputs and candidates move in ONE statement: a reader sees the old inputs with their
        // candidates or the new inputs with none, never a mismatched pair. Name and customer feed no
        // figure, so they keep the candidates and the picks — except clearing the customer, which
        // leaves something mandatory missing, and candidates never outlive the gate.
        const written = await db
          .update(configProject)
          .set({
            ...patchColumns(patch, sources, other),
            ...(name !== undefined ? { name } : {}),
            ...(customer !== undefined ? { customer } : {}),
            ...(engine || customer === null ? { candidates: [], selection: null, calculatedAt: null } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(configProject.id, id), eq(configProject.tenantId, context.tenantId), writableBy("internal")))
          .returning({ id: configProject.id });
        if (!written.length) throw new ORPCError("CONFLICT", { message: "The configuration changed hands meanwhile — reload it" });
      }
      return partial(context.tenantId, id);
    }),

  // Store the user's candidate/batch/override picks; totals are recomputed HERE against the live
  // model and lookups — client-sent numbers are never persisted. The FOR UPDATE below is the fence.
  select: userProcedure
    .meta(openapi({
      summary: "Pick what to quote",
      description: "Store which candidates to quote at which batch quantities — each pick is one quotation line (or one per items-grid row). Indices refer to `candidates.rows` of the current calculation. Answers what `configs.calculate` answers.",
    }))
    .input(z.object({
      projectId: z.uuid().describe("The configuration's id"),
      // Empty is a save too (unpicking the last cell); buildQuoteSeed is what refuses to quote it.
      selection: z.array(SelectionZ).describe("The picks, as candidate index and batch quantity"),
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
      return partial(context.tenantId, input.projectId);
    }),

  // What will be posted to B1, recomputed from the persisted project. The commandId comes back
  // with it and is echoed by createQuote, so the client can never widen the selection between
  // preview and post.
  quoteDraft: userProcedure
    .meta(openapi({
      summary: "Preview the quotation",
      description: "The SAP Sales Quotation the current picks would post — header and lines, recomputed on the server — with its totals and the `commandId` that `configs.createQuote` must echo.",
    }))
    .input(z.object({ projectId: z.uuid().describe("The configuration's id") }))
    .handler(({ input, context }) => quoteDraft(context.tenantId, input.projectId)),

  createQuote: userProcedure
    .meta(openapi({
      summary: "Post the quotation to SAP",
      description: "Create the SAP Sales Quotation for the current picks, or update the open one of a reopened request. Idempotent: a retry with the same `commandId` finds the document already posted. Refused with STATE_CHANGED when the picks moved since `configs.quoteDraft`.",
    }))
    .input(z.object({
      projectId: z.uuid().describe("The configuration's id"),
      commandId: z.string().length(64).describe("The commandId configs.quoteDraft answered"),
      // Header fields only, and only the ones QUOTE_HEADER names — filtered in the handler so a
      // rejection can name them. Every number on the document is recomputed server-side.
      header: z.record(z.string(), z.unknown()).optional().describe("Quotation header fields to set (dates, currency, contact…)"),
    }))
    .handler(({ input, context }) => createQuote(context.tenantId, context.userId, input)),
};
