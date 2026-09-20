import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, configModel, configProject } from "@confire/db";
import { checkModel, ModelDefZ, syncTables } from "@confire/config-engine";
import { adminProcedure } from "../base.ts";
import { resolveLookups } from "../../lookups.ts";
import { knownTables, masterdataRows } from "./masterdata.ts";
import { ensureFresh, rowCache } from "../../masterdata-sync.ts";
import { compileSpec, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { copyName } from "../../copy-name.ts";

// Admin-only configurator model builder API. save is the gate: a model that passes
// ModelDefZ + checkModel here can never produce a parse/unknown-ref error at runtime.

const MODEL_FIELDS: SqlFields = {
  name: { col: configModel.name, kind: "string" },
  updatedAt: { col: configModel.updatedAt, kind: "date" },
};

export const modelsRouter = {
  /** One page of the models list for a saved view. `list` stays: GlobalSearch still needs the
   *  whole array to search it in the browser. */
  rows: adminProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileSpec(MODEL_FIELDS, input.spec);
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

  list: adminProcedure.handler(({ context }) =>
    db
      .select({ id: configModel.id, name: configModel.name, updatedAt: configModel.updatedAt })
      .from(configModel)
      .where(eq(configModel.tenantId, context.tenantId))
      .orderBy(configModel.name),
  ),

  get: adminProcedure.input(z.object({ id: z.uuid() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select()
      .from(configModel)
      .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND");
    return row;
  }),

  save: adminProcedure
    .input(z.object({
      id: z.uuid().optional(),
      definition: ModelDefZ,
      portal: z.boolean().optional(),
      portalDescription: z.string().nullable().optional(),
    }))
    .handler(async ({ input, context }) => {
      const issues = checkModel(input.definition, knownTables(await masterdataRows(context.tenantId)));
      if (issues.length) throw new ORPCError("BAD_REQUEST", { message: "Model has errors", data: { issues } });
      const fields = {
        name: input.definition.name, definition: input.definition, updatedAt: new Date(),
        ...(input.portal !== undefined ? { portal: input.portal } : {}),
        ...(input.portalDescription !== undefined ? { portalDescription: input.portalDescription } : {}),
      };
      // RETURNING the whole row (not just the id) so the client can seed its models.get cache
      // from the save response instead of refetching.
      if (input.id) {
        const [updated] = await db
          .update(configModel)
          .set(fields)
          .where(and(eq(configModel.id, input.id), eq(configModel.tenantId, context.tenantId)))
          .returning();
        if (!updated) throw new ORPCError("NOT_FOUND");
        return updated;
      }
      const [ins] = await db
        .insert(configModel)
        .values({ tenantId: context.tenantId, ...fields })
        .returning();
      return ins!;
    }),

  // Copy under the first free name. Server-side because `save` only accepts a definition, so a
  // client-side copy would silently drop portalDescription (a column, not part of the jsonb).
  // No checkModel: a byte-identical copy of a stored definition either already passed on save, or
  // now fails only because masterdata was deleted since — an unhelpful error on an unedited copy.
  // Nothing cached is copied: the definition keeps its table names, and the cache belongs to the
  // masterdata rows those names point at, not to the model.
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
    // `portal` is deliberately left at its false default: a copy of a published model must not
    // publish itself to the client portal before anyone has looked at it.
    const [ins] = await db
      .insert(configModel)
      .values({
        tenantId: context.tenantId, name,
        definition: { ...row.definition, name },
        portalDescription: row.portalDescription,
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
