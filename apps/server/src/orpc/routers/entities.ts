import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { ListQueryZ } from "@confire/db";
import { coerceKey, rowsOf, type Key } from "@confire/b1";
import { adminProcedure, userProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { assertEntity, entitySchema, toConstraints } from "../../entity-meta.ts";
import { compileList } from "../../entity-list.ts";
import { missingRequired, pickEditable, profileOf, PRINTABLE } from "../../entity-profiles.ts";
import { buildCopy, COPY_SELECT, findFlow, flowsFrom } from "../../doc-copy.ts";
import { printDocument } from "../../print.ts";
import { bad, readOne, readRows } from "../../entity-read.ts";
import { DEFAULT_PAGE } from "../../lookups.ts";

// The B1 entity surface: read an entity's constraints, page rows, open one row — for any entity
// set. Which entities a user can *browse* is the web's declared feature registry; this router does
// not enumerate B1 for them any more. Writing is different: update/create/copy work only on the
// curated entities in entity-profiles.ts, and only on the fields those profiles name. That rule
// lives in `curated()` below, not in whether a page happened to draw a button.
//
// adminProcedure: row reads and every write are admin/owner only. `rows` and `metadata` are the
// exceptions — see the notes on them. What they have in common is that neither reaches SAP for
// business data on its own behalf.

const EntityZ = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an entity set name");
const KeyZ = z.union([z.string(), z.number(), z.record(z.string(), z.union([z.string(), z.number()]))]);

const b1Of = async (tenantId: string) => (await tenantConnector(tenantId)).b1;

/** Writes are curated-only, and the rule lives here rather than in whether the UI drew a button. */
const curated = (entity: string) => {
  const p = profileOf(entity);
  if (!p) throw new ORPCError("FORBIDDEN", { message: `${entity} is read-only in Confire` });
  return p;
};

export const entitiesRouter = {
  /** One entity's field constraints (Beas' /api/metadata/{Entity}), the write rule folded in as
   *  Editable/Required. Cached with the schema; `refresh` re-reads $metadata.
   *
   *  userProcedure, not adminProcedure: this is field *shape* read from entity_meta in Postgres.
   *  The configurator's quote page renders a Quotations draft with it, and every value-help dialog
   *  over a B1 entity adds that entity's undeclared fields as hidden columns from it. No row ever
   *  comes back through here — `one` is still admin. */
  metadata: userProcedure
    .input(z.object({ entity: EntityZ, refresh: z.boolean().optional() }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity, input.refresh)).catch(bad);
      return {
        ...toConstraints(schema, profileOf(input.entity)),
        printable: PRINTABLE.has(input.entity),
        flows: flowsFrom(input.entity).map((f) => ({ target: f.target, label: f.label })),
      };
    }),

  /** One page of rows for a list query. The query is compiled to OData here — the browser never
   *  sends a filter string.
   *
   *  userProcedure, not adminProcedure: the configurator's customer value help (BusinessPartners,
   *  in ConfigProcessPage) is used by every internal member, not just admins. EntityZ is any
   *  entity set name, so this is a read over everything B1 exposes — still tenant-scoped through
   *  b1Of(context.tenantId), and `one`/`update` stay admin.
   *  ponytail: one open reader; narrow to an entity allowlist if the read surface matters. */
  rows: userProcedure
    .input(z.object({
      entity: EntityZ,
      query: ListQueryZ,
      /** sealed @odata.nextLink from the previous page; absent = first page. There is no
       *  page-size input: B1_PAGE_SIZE is the one knob, so a client cannot ask for a page the
       *  Service Layer would silently truncate. */
      cursor: z.string().optional(),
      /** ask B1 for the total in the same read; only worth it on the first page */
      count: z.boolean().optional(),
    }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      return readRows(b1, schema, input.entity, { ...input, pageSize: DEFAULT_PAGE },
        { tenantId: context.tenantId, key: "internal" });
    }),

  /** One row, with its ETag — which is what makes a curated edit safe. */
  one: adminProcedure
    .input(z.object({ entity: EntityZ, key: KeyZ }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      return readOne(b1, schema, input.entity, input.key);
    }),

  /** First/previous/next/last record, walking the single key field the way Beas' record navigation
   *  does: `gt`/`lt` the current key, ordered by it, one row. A composite-key entity has no single
   *  order to walk, so it answers null. `key` is absent for first/last. */
  neighbor: adminProcedure
    .input(z.object({ entity: EntityZ, key: KeyZ.optional(), dir: z.enum(["first", "prev", "next", "last"]) }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      const [field] = schema.keys;
      if (!field || schema.keys.length !== 1) return { key: null };
      const back = input.dir === "prev" || input.dir === "last";
      const from = input.dir === "prev" || input.dir === "next";
      if (from && (input.key === undefined || typeof input.key === "object"))
        throw new ORPCError("BAD_REQUEST", { message: "prev/next needs the current key" });
      let q;
      try {
        q = compileList(schema, {
          select: [field],
          filter: from ? [{ field, op: back ? "lt" : "gt", value: input.key as string | number }] : [],
          orderby: [{ field, dir: back ? "desc" : "asc" }],
        }, { pageSize: 1 });
      } catch (e) {
        return bad(e);
      }
      const res = await viaB1(() => b1.readEntitySet(input.entity, { ...q, top: 1 }));
      const hit = rowsOf(res.data)[0]?.[field];
      return { key: hit === undefined || hit === null ? null : (hit as string | number) };
    }),

  /** Curated update. Requires the ETag read back with the row: without If-Match a concurrent
   *  edit is a silent overwrite, and B1 answers a stale one with 412 -> CONFLICT. */
  update: adminProcedure
    .input(z.object({
      entity: EntityZ,
      key: KeyZ,
      etag: z.string().min(1),
      data: z.record(z.string(), z.unknown()),
    }))
    .handler(async ({ input, context }) => {
      const profile = curated(input.entity);
      const { payload, rejected } = pickEditable(profile, input.data, { create: false });
      if (rejected.length)
        throw new ORPCError("BAD_REQUEST", { message: `Not editable on ${input.entity}: ${rejected.join(", ")}` });
      if (!Object.keys(payload).length)
        throw new ORPCError("BAD_REQUEST", { message: "Nothing to update" });

      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      let key: Key;
      try { key = coerceKey(schema, input.key); } catch (e) { return bad(e); }
      await viaB1(() => b1.updateEntity(input.entity, key, payload, { etag: input.etag }));
      // B1's PATCH answers 204; re-read so the caller gets the new ETag rather than a stale one.
      const fresh = await viaB1(() => b1.readEntity(input.entity, key));
      return { row: fresh.data as Record<string, unknown>, etag: fresh.etag ?? null };
    }),

  /** Curated create. `prefer: representation` means the created document comes back in one call. */
  create: adminProcedure
    .input(z.object({ entity: EntityZ, data: z.record(z.string(), z.unknown()) }))
    .handler(async ({ input, context }) => {
      const profile = curated(input.entity);
      const missing = missingRequired(profile, input.data);
      if (missing.length)
        throw new ORPCError("BAD_REQUEST", { message: `${input.entity} needs ${missing.join(", ")}` });
      const { payload, rejected } = pickEditable(profile, input.data, { create: true });
      if (rejected.length)
        throw new ORPCError("BAD_REQUEST", { message: `Not settable on ${input.entity}: ${rejected.join(", ")}` });

      const b1 = await b1Of(context.tenantId);
      await viaB1(() => assertEntity(context.tenantId, b1, input.entity)).catch(bad);
      const res = await viaB1(() => b1.createEntity(input.entity, payload, { prefer: "representation" }));
      return { row: res.data as Record<string, unknown>, etag: res.etag ?? null };
    }),

  /** Order -> Delivery -> Invoice and friends. The target lines carry BaseType/BaseEntry/BaseLine,
   *  which is what makes B1 close the source lines instead of creating an unlinked document. */
  copy: adminProcedure
    .input(z.object({
      sourceEntity: EntityZ,
      targetEntity: EntityZ,
      docEntry: z.number().int(),
      /** source line indexes; omitted copies every line */
      lines: z.array(z.number().int().min(0)).optional(),
      comments: z.string().max(2000).optional(),
    }))
    .handler(async ({ input, context }) => {
      const flow = findFlow(input.sourceEntity, input.targetEntity);
      if (!flow)
        throw new ORPCError("BAD_REQUEST", { message: `No document flow from ${input.sourceEntity} to ${input.targetEntity}` });

      const b1 = await b1Of(context.tenantId);
      const source = await viaB1(() => b1.readEntity(flow.source, input.docEntry, { select: COPY_SELECT }));
      let payload;
      try {
        payload = buildCopy(flow, source.data as Record<string, unknown>, { lines: input.lines, comments: input.comments });
      } catch (e) {
        return bad(e);
      }
      const res = await viaB1(() => b1.createEntity(flow.target, payload, { prefer: "representation" }));
      const row = res.data as Record<string, unknown>;
      return { entity: flow.target, docEntry: Number(row.DocEntry), docNum: row.DocNum ?? null, row };
    }),

  /** The document's own SAP print layout, rendered by the API Gateway on-prem and returned as
   *  base64. `/b1` is admin-only already; PRINTABLE is the second gate and the one that travels. */
  print: adminProcedure
    .input(z.object({ entity: EntityZ, docEntry: z.number().int() }))
    .handler(({ input, context }) => printDocument(context.tenantId, input.entity, input.docEntry)),
};
