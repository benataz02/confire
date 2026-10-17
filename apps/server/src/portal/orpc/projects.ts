import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, configModel, configProject, configProjectEvent, user,
  type ConfigProject, type PortalPrice,
} from "@confire/db";
import {
  DslError, EntriesZ, missingInputs, propagate, referencedTables, TableRowsZ,
} from "@confire/config-engine";
import { portalBuyerProcedure, portalMemberProcedure } from "./base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { compileQuery, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { cachedLookups, calculateProject, loadModel, QueryPageZ, queryTablePage } from "../../config-project.ts";
import { assertWritable, inputsOf, recordCreated, transition, writableBy, type Action, type Actor } from "../../project-lifecycle.ts";
import {
  acceptPortalInputs, toPortalBadges, toPortalLookups, toPortalModelDef, toPortalPage, toPortalPrices, toPortalProp,
  toPortalRows,
} from "../projection.ts";

// The client's projects (spec §7, §9, §11). One project = one configuration, fenced on the seat's
// company in every read and write. The engine runs here: the page gets the §7.1 projection and the
// §7.2 figures, and nothing else — no model, no lookups, no candidates.

type Seat = { tenantId: string; companyId: string; cardCode: string; cardName: string; user: { id: string } };
const actorOf = (c: Seat): Actor => ({ userId: c.user.id, side: "external", companyId: c.companyId });

/** The batch field's message key: data-param shares its namespace with parameter keys. */
const BATCHES = "__batches";

const PROJECT_FIELDS: SqlFields = {
  name: { col: configProject.name, kind: "string" },
  modelName: { col: configModel.name, kind: "string" },
  status: { col: configProject.status, kind: "enum" },
  createdBy: { col: user.name, kind: "string" },
  updatedAt: { col: configProject.updatedAt, kind: "date" },
};

async function ownProject(c: Seat, id: string): Promise<ConfigProject> {
  const [p] = await db.select().from(configProject)
    .where(and(eq(configProject.id, id), eq(configProject.tenantId, c.tenantId), eq(configProject.portalCompanyId, c.companyId)))
    .limit(1);
  if (!p) throw new ORPCError("NOT_FOUND");
  return p;
}

/** What the Prices section shows (§7.2) — the first matching row wins. */
async function pricesOf(p: ConfigProject, indicative: boolean): Promise<
  | { kind: "quotation"; declined: boolean }
  | { kind: "request" }
  | { kind: "live"; rows: PortalPrice[] }
  | { kind: "submitted"; rows: PortalPrice[]; at: Date }
> {
  if (p.b1DocEntry !== null) return { kind: "quotation", declined: p.quoteResponse === "declined" && p.status === "in_review" };
  if (!indicative) return { kind: "request" };
  if (p.status === "draft" || p.status === "returned") return { kind: "live", rows: toPortalPrices(p.candidates, p.batches) };
  // Frozen at submit, on the append-only event row: the project itself stays live.
  const [e] = await db.select({ at: configProjectEvent.at, payload: configProjectEvent.payload }).from(configProjectEvent)
    .where(and(eq(configProjectEvent.projectId, p.id), inArray(configProjectEvent.kind, ["submitted", "resubmitted"])))
    .orderBy(desc(configProjectEvent.at)).limit(1);
  return { kind: "submitted", rows: (e?.payload as { prices?: PortalPrice[] } | null)?.prices ?? [], at: e?.at ?? p.updatedAt };
}

/** The one payload `get` and `calculate` return (§7.1). */
async function payload(c: Seat, id: string, calcError: string | null = null) {
  const p = await ownProject(c, id);
  const model = await loadModel(c.tenantId, p.modelId);
  const def = model.definition;
  const lookups = await cachedLookups(c.tenantId, model, p.entries, p.tables);
  let prop;
  try {
    prop = propagate(def, lookups, p.entries, p.tables);
  } catch (e) {
    if (e instanceof DslError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
  const indicative = model.portalPricing === "indicative";
  const [assignee] = p.assigneeId ? await db.select({ name: user.name }).from(user).where(eq(user.id, p.assigneeId)).limit(1) : [];
  return {
    project: {
      id: p.id, name: p.name, status: p.status, modelId: p.modelId,
      entries: p.entries, batches: p.batches, tables: toPortalRows(def, p.tables),
      calculatedAt: p.calculatedAt, quoteResponse: p.quoteResponse, quoteRespondedAt: p.quoteRespondedAt,
      createdAt: p.createdAt, updatedAt: p.updatedAt, assigneeName: assignee?.name ?? null,
    },
    model: { id: model.id, name: model.name, portalPricing: model.portalPricing, definition: toPortalModelDef(def) },
    prop: toPortalProp(def, prop, lookups, p.tables),
    lookups: toPortalLookups(def, prop, lookups),
    // The submit gate, in form order — the same rule the internal Create quote follows.
    missing: [
      ...(p.batches.length ? [] : [{ key: BATCHES, message: "Add at least one batch quantity" }]),
      ...missingInputs(def, lookups, prop, p.tables),
    ],
    badges: indicative ? toPortalBadges(def, prop, lookups) : {},
    prices: await pricesOf(p, indicative),
    calcError,
  };
}

/** submit/resubmit (§7): a name, a batch, a calculation, nothing missing. The snapshot freezes the
 *  inputs, and on an indicative model the figures the client saw. */
async function submit(c: Seat, id: string, action: Extract<Action, "submit" | "resubmit">) {
  const pl = await payload(c, id);
  const [p] = await db.select({ calculatedAt: configProject.calculatedAt }).from(configProject).where(eq(configProject.id, id)).limit(1);
  const gaps = [
    ...(pl.project.name.trim() ? [] : ["a name"]),
    ...pl.missing.map((m) => m.message),
    ...(pl.prop.conflicts.length ? ["no conflicts"] : []),
  ];
  if (gaps.length) throw new ORPCError("BAD_REQUEST", { message: `Before submitting: ${gaps.join("; ")}` });
  if (!p?.calculatedAt) throw new ORPCError("BAD_REQUEST", { message: "The configuration is still calculating — try again in a moment" });
  const indicative = pl.model.portalPricing === "indicative";
  await db.transaction((tx) => transition(tx, {
    tenantId: c.tenantId, projectId: id, action, actor: actorOf(c), expectCalculatedAt: p.calculatedAt!,
    payload: (row) => ({ inputs: inputsOf(row), ...(indicative ? { prices: toPortalPrices(row.candidates, row.batches) } : {}) }),
  }));
  return payload(c, id);
}

const IdZ = z.object({ id: z.uuid() });

export const projectsRouter = {
  rows: portalMemberProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileQuery(PROJECT_FIELDS, input.query);
    const raw = await db
      .select({
        id: configProject.id, name: configProject.name, modelName: configModel.name, status: configProject.status,
        createdBy: user.name, updatedAt: configProject.updatedAt, _total: TOTAL,
      })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .leftJoin(user, eq(user.id, configProject.createdBy))
      .where(and(eq(configProject.tenantId, context.tenantId), eq(configProject.portalCompanyId, context.companyId), where))
      .orderBy(...orderBy, sql`${configProject.updatedAt} desc`, configProject.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

  get: portalMemberProcedure.input(IdZ).handler(({ input, context }) => payload(context, input.id)),

  /** From the catalog: a published model, named. The customer is the company (spec §7). */
  create: portalBuyerProcedure
    .input(z.object({ modelId: z.uuid(), name: z.string().trim().min(1).max(200) }))
    .handler(async ({ input, context }) => {
      const model = await loadModel(context.tenantId, input.modelId);
      if (!model.portal) throw new ORPCError("NOT_FOUND", { message: "Model not found" });
      return db.transaction(async (tx) => {
        const [ins] = await tx.insert(configProject).values({
          tenantId: context.tenantId, modelId: model.id, name: input.name,
          customer: { cardCode: context.cardCode, cardName: context.cardName },
          portalCompanyId: context.companyId,
          batches: model.definition.batchDefaults, createdBy: context.user.id,
        }).returning({ id: configProject.id });
        await recordCreated(tx, context.tenantId, ins!.id, actorOf(context));
        return { id: ins!.id };
      });
    }),

  /** The name only: the model was picked at create, and the customer is the company. */
  update: portalBuyerProcedure
    .input(z.object({ id: z.uuid(), name: z.string().trim().min(1).max(200) }))
    .handler(async ({ input, context }) => {
      await assertWritable(context.tenantId, input.id, actorOf(context));
      await db.update(configProject).set({ name: input.name, updatedAt: new Date() })
        .where(and(eq(configProject.id, input.id), eq(configProject.portalCompanyId, context.companyId), writableBy("external")));
      return payload(context, input.id);
    }),

  /** Drafts only — once submitted, the project is the supplier's record too. */
  remove: portalBuyerProcedure.input(IdZ).handler(async ({ input, context }) => {
    const gone = await db.delete(configProject)
      .where(and(
        eq(configProject.id, input.id), eq(configProject.tenantId, context.tenantId),
        eq(configProject.portalCompanyId, context.companyId), eq(configProject.status, "draft"),
      ))
      .returning({ id: configProject.id });
    if (!gone.length) throw new ORPCError("CONFLICT", { message: "Only a draft can be deleted" });
    return { ok: true };
  }),

  /** One edit is one call (§7.1): write the inputs and empty the candidates in one statement, then
   *  recalculate once the inputs are complete. A calculation that fails keeps the edit and comes
   *  back as `calcError` — the page says why rather than losing what was typed. */
  calculate: portalBuyerProcedure
    .input(z.object({
      id: z.uuid(),
      entries: EntriesZ.optional(),
      batches: z.array(z.number().int().min(1)).max(50).optional(),
      tables: TableRowsZ.optional(),
    }))
    .handler(async ({ input, context }) => {
      await assertWritable(context.tenantId, input.id, actorOf(context));
      const { id, batches, ...edits } = input;
      if (Object.keys(edits).length || batches) {
        const stored = await ownProject(context, id);
        const model = await loadModel(context.tenantId, stored.modelId);
        let accepted;
        try {
          accepted = acceptPortalInputs(model.definition, stored, edits);
        } catch (e) {
          throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
        }
        const written = await db.update(configProject)
          .set({ ...accepted, ...(batches ? { batches } : {}), candidates: [], selection: null, calculatedAt: null, updatedAt: new Date() })
          .where(and(eq(configProject.id, id), eq(configProject.portalCompanyId, context.companyId), writableBy("external")))
          .returning({ id: configProject.id });
        if (!written.length) throw new ORPCError("CONFLICT", { message: "This project moved on meanwhile — reload it" });
      }
      const pl = await payload(context, id);
      if (pl.missing.length || pl.prop.conflicts.length || !pl.project.name.trim()) return pl;
      try {
        await calculateProject(context.tenantId, id);
      } catch (e) {
        if (e instanceof ORPCError && e.code === "BAD_REQUEST") return payload(context, id, e.message);
        throw e;
      }
      return payload(context, id);
    }),

  /** Value help (§7.1): a table the model names, of a model the client may use — published, or the
   *  model of one of its own projects (unpublishing never breaks a project). Hidden columns out. */
  queryPage: portalMemberProcedure.input(QueryPageZ).handler(async ({ input, context }) => {
    const model = await loadModel(context.tenantId, input.modelId);
    const own = model.portal || (await db.select({ id: configProject.id }).from(configProject)
      .where(and(eq(configProject.modelId, model.id), eq(configProject.portalCompanyId, context.companyId))).limit(1)).length > 0;
    if (!own || !referencedTables(model.definition).has(input.table)) throw new ORPCError("NOT_FOUND");
    return toPortalPage(model.definition, input.table, await queryTablePage(context.tenantId, input));
  }),

  submit: portalBuyerProcedure.input(IdZ).handler(({ input, context }) => submit(context, input.id, "submit")),
  resubmit: portalBuyerProcedure.input(IdZ).handler(({ input, context }) => submit(context, input.id, "resubmit")),

  withdraw: portalBuyerProcedure.input(IdZ).handler(async ({ input, context }) => {
    await db.transaction((tx) => transition(tx, { tenantId: context.tenantId, projectId: input.id, action: "withdraw", actor: actorOf(context) }));
    return payload(context, input.id);
  }),

  /** Accept or decline the quotation (D20). Nothing is written to SAP: an accept is final and staff
   *  create the order; a decline reopens the project in review (§7.3). */
  respondQuote: portalBuyerProcedure
    .input(z.object({ id: z.uuid(), accept: z.boolean(), note: z.string().trim().max(2000).optional() }))
    .handler(async ({ input, context }) => {
      await db.transaction((tx) => transition(tx, {
        tenantId: context.tenantId, projectId: input.id, action: input.accept ? "quoteAccept" : "quoteDecline",
        actor: actorOf(context), note: input.note,
      }));
      return payload(context, input.id);
    }),

  /** The current quotation's lines and total, live (§7.2) — only after its CardCode is the company's.
   *  Separate from `get` so the page never waits on SAP to draw the configuration. */
  quotation: portalMemberProcedure.input(IdZ).handler(async ({ input, context }) => {
    const p = await ownProject(context, input.id);
    if (p.b1DocEntry === null) return null;
    const { b1 } = await tenantConnector(context.tenantId);
    const doc = (await viaB1(() => b1.readEntity("Quotations", p.b1DocEntry!))).data as Record<string, unknown>;
    if (doc.CardCode !== context.cardCode) throw new ORPCError("NOT_FOUND");
    const lines = (doc.DocumentLines as Record<string, unknown>[] | undefined) ?? [];
    return {
      docNum: Number(doc.DocNum ?? 0), docDate: String(doc.DocDate ?? ""), validUntil: String(doc.DocDueDate ?? ""),
      currency: String(doc.DocCurrency ?? ""), docTotal: Number(doc.DocTotal ?? 0), vatSum: Number(doc.VatSum ?? 0),
      lines: lines.map((l) => ({
        description: String(l.ItemDescription ?? ""), quantity: Number(l.Quantity ?? 0),
        unitPrice: Number(l.UnitPrice ?? l.Price ?? 0), lineTotal: Number(l.LineTotal ?? 0),
      })),
    };
  }),
};

/** The catalog (D21): every published model, for every company on the tenant. */
export const modelsRouter = {
  list: portalMemberProcedure.handler(({ context }) =>
    db.select({
      id: configModel.id, name: configModel.name, portalPricing: configModel.portalPricing,
      description: sql<string | null>`${configModel.definition}->>'description'`,
    })
      .from(configModel)
      .where(and(eq(configModel.tenantId, context.tenantId), eq(configModel.portal, true)))
      .orderBy(configModel.name)),
};
