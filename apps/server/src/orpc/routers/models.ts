import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, configModel, configProject } from "@confire/db";
import { applyModelPatch, checkModel, isEmptyPatch, ModelDefZ, ModelPatchZ, syncTables, type KnownTable, type ModelDef } from "@confire/config-engine";
import { adminProcedure } from "../base.ts";
import { resolveLookups } from "../../lookups.ts";
import { knownTables } from "./masterdata.ts";
import { masterdataRows } from "../../config-project.ts";
import { ensureFresh, rowCache } from "../../masterdata-sync.ts";
import { compileQuery, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { copyName } from "../../copy-name.ts";

// Admin-only configurator model builder API. save is the gate: a model that passes
// ModelDefZ + checkModel here can never produce a parse/unknown-ref error at runtime.

/** models.save/create reject an invalid definition with BAD_REQUEST + data.issues (span Issues). */
function assertValid(definition: ModelDef, known: KnownTable[]) {
  const issues = checkModel(definition, known);
  if (issues.length) throw new ORPCError("BAD_REQUEST", { message: "Model has errors", data: { issues } });
}

/** The customer portal's columns beside the definition: optional on a save, defaulted on a create. */
const PortalZ = {
  portal: z.boolean().optional(),
  portalPricing: z.enum(["indicative", "request"]).optional(),
};

const MODEL_FIELDS: SqlFields = {
  name: { col: configModel.name, kind: "string" },
  updatedAt: { col: configModel.updatedAt, kind: "date" },
};

export const modelsRouter = {
  /** One page of the models list for a saved view. */
  rows: adminProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileQuery(MODEL_FIELDS, input.query);
    const raw = await db
      .select({ id: configModel.id, name: configModel.name, updatedAt: configModel.updatedAt, _total: TOTAL })
      .from(configModel)
      .where(and(eq(configModel.tenantId, context.tenantId), where))
      // `id` last so the order is total — OFFSET paging over a non-unique sort duplicates and skips
      // rows between pages.
      .orderBy(...orderBy, configModel.name, configModel.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

  get: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  /** A model's first save: there is nothing stored to diff against yet. RETURNING the whole row so
   *  the builder seeds models.get for the page it moves to instead of fetching it back. */
  create: adminProcedure
    .input(z.object({ definition: ModelDefZ, ...PortalZ }))
    .handler(async ({ input, context }) => {
      assertValid(input.definition, knownTables(await masterdataRows(context.tenantId)));
      const [ins] = await db
        .insert(configModel)
        .values({
          tenantId: context.tenantId, name: input.definition.name, definition: input.definition,
          portal: input.portal, portalPricing: input.portalPricing,
        })
        .returning();
      return ins!;
    }),

  /** What changed since the builder's last save (`diffModel`), laid over the stored definition under
   *  a row lock, so a concurrent save of other items is merged rather than overwritten. The gate
   *  runs on the merged model: that is what is stored. The portal columns (spec D15, D21) ride
   *  along when they changed, but only a definition change moves `updatedAt`: it is what makes a
   *  stored calculation stale, and publishing cannot change one. Unpublishing hides the model from
   *  the catalog; projects already created from it keep working. */
  save: adminProcedure
    .input(z.object({ id: z.uuid(), patch: ModelPatchZ, ...PortalZ }))
    .handler(async ({ input, context }) => {
      const known = knownTables(await masterdataRows(context.tenantId));
      const portal = {
        ...(input.portal === undefined ? {} : { portal: input.portal }),
        ...(input.portalPricing === undefined ? {} : { portalPricing: input.portalPricing }),
      };
      return db.transaction(async (tx) => {
        const fence = and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId));
        const [row] = await tx.select({ definition: configModel.definition, updatedAt: configModel.updatedAt })
          .from(configModel).where(fence).for("update");
        if (!row) throw new ORPCError("NOT_FOUND");
        // The stored definition already passed the gate: a portal-only save does not run it again.
        const changed = !isEmptyPatch(input.patch);
        const definition = changed ? applyModelPatch(row.definition, input.patch) : row.definition;
        if (changed) assertValid(definition, known);
        if (!changed && !Object.keys(portal).length) return { updatedAt: row.updatedAt };
        const [updated] = await tx.update(configModel)
          .set({ ...portal, ...(changed ? { name: definition.name, definition, updatedAt: new Date() } : {}) })
          .where(fence)
          .returning({ updatedAt: configModel.updatedAt });
        return updated!;
      });
    }),

  // Copy under the first free name. Server-side so the stored definition is what gets copied,
  // not whatever the browser last rendered. No checkModel: a byte-identical copy of a stored
  // definition either already passed on save, or now fails only because masterdata was deleted
  // since — an unhelpful error on an unedited copy. Nothing cached is copied: the definition
  // keeps its table names, and the cache belongs to the masterdata rows those names point at.
  duplicate: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)));
    if (!row) throw new ORPCError("NOT_FOUND");
    const taken = await db
      .select({ name: configModel.name })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId));
    const name = copyName(row.name, taken.map((t) => t.name));
    const [ins] = await db
      .insert(configModel)
      .values({
        tenantId: context.tenantId, name,
        definition: { ...row.definition, name },
      })
      .returning();
    return ins!;
  }),

  // One delete path for the object page (one id) and the list report (many). All-or-nothing: if
  // any model in the batch is in use the whole batch is refused, so there is no half-deleted
  // selection to explain — and the message names which ones, which a per-id loop could not.
  remove: adminProcedure.input(z.object({ ids: z.array(z.uuid()).min(1) })).handler(async ({ input, context }) => {
    const inUse = await db
      .selectDistinct({ name: configModel.name })
      .from(configProject)
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .where(and(eq(configProject.tenantId, context.tenantId), inArray(configProject.modelId, input.ids)));
    if (inUse.length)
      throw new ORPCError("BAD_REQUEST", {
        message: `${inUse.map((m) => m.name).join(", ")} ${inUse.length === 1 ? "is" : "are"} used by existing configurations`,
      });
    await db.delete(configModel).where(and(inArray(configModel.id, input.ids), eq(configModel.tenantId, context.tenantId)));
    return { ok: true };
  }),


  // Live preview for the (possibly unsaved) builder draft: same resolver as configs.lookups, keyed
  // by the posted definition instead of a saved model id. Client sends a stripped-down "lookup
  // skeleton" so typing in expression fields doesn't refetch.
  //
  // No try/catch any more: the resolve reads the cache, so the only errors left are the model's
  // own (an unknown table, a missing column) and those are the builder's to show as issues rather
  // than a gateway failure.
  previewLookups: adminProcedure
    .input(z.object({ definition: ModelDefZ }))
    .handler(async ({ input, context }) => {
      const rows = await masterdataRows(context.tenantId);
      ensureFresh(context.tenantId, rows.filter((r) => syncTables(input.definition).has(r.name)));
      return resolveLookups(input.definition, rows, rowCache(context.tenantId));
    }),
};
