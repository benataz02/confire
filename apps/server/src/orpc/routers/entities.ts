import { ORPCError } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import { z } from "zod";
import { ListQueryZ } from "@confire/db";
import { rowsOf } from "@confire/b1";
import { userProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema, toConstraints } from "../../entity-meta.ts";
import { compileList } from "../../entity-list.ts";
import { assertReadable, profileOf, PRINTABLE } from "../../entity-profiles.ts";
import { buildCopy, draftConstraints, flowsFrom } from "../../doc-copy.ts";
import { CopyInputZ, CopyZ, EntityZ, KeyZ, planCopy, postWrite, prepareWrite } from "../../entity-write.ts";
import { printDocument } from "../../print.ts";
import { quotationsBehind } from "../../doc-chain.ts";
import { afterPost, configsOfQuotations, projectsOfQuotations } from "../../document-mail.ts";
import type { DocumentMailType } from "@confire/db";
import { bad, readOne, readRows } from "../../entity-read.ts";
import { DEFAULT_PAGE } from "../../lookups.ts";
import { t } from "../../i18n/index.ts";
import { salesPersonOf, withMine } from "../../ui-views.ts";

// The B1 entity surface: read an entity's constraints, page rows, open one row — for any entity
// set. Which entities a user can *browse* is the web's declared feature registry; this router does
// not enumerate B1 for them any more. Writing is different: update/create/copy work only on the
// curated entities in entity-profiles.ts, and only on the fields those profiles name (the `profile`
// field rule). That rule lives in entity-write.ts, shared with the assistant's b1.* tools, not in
// whether a page happened to draw a button. Row reads of ADMIN_ONLY_READS are admins' (assertReadable).
//
// userProcedure throughout: any staff member may open these pages. A portal customer never reaches
// them — userProcedure refuses an external role. What may be written is still curated(), below.

const b1Of = async (tenantId: string) => (await tenantConnector(tenantId)).b1;
const writeCtx = async (tenantId: string, userId: string) => ({ tenantId, userId, ...(await tenantConnector(tenantId)) });

export const entitiesRouter = {
  /** One entity's field constraints (Beas' /api/metadata/{Entity}), the write rule folded in as
   *  Editable/Required. Cached with the schema; `refresh` re-reads $metadata.
   *
   *  Field *shape* read from sap_cache in Postgres. The configurator's quote page renders a
   *  Quotations draft with it, and every value-help dialog over a B1 entity adds that entity's
   *  undeclared fields as hidden columns from it. No row comes back through here. */
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
   *  The configurator's customer value help (BusinessPartners, in ConfigProcessPage) and the B1
   *  lists both read through here. EntityZ is any entity set name, so this is a read over
   *  everything B1 exposes — still tenant-scoped through b1Of(context.tenantId).
   *  ponytail: one open reader; narrow to an entity allowlist if the read surface matters. */
  rows: userProcedure
    .meta(openapi({
      summary: "Read SAP records",
      description: "One page of an SAP Business One entity set, read live through the workspace's agent: Quotations, Orders, BusinessPartners and the rest. `query.select` names the fields (SAP's own names: DocNum, CardCode, CardName, DocDate, DocTotal, DocumentStatus…), `query.filter` narrows (eq, ne, in, contains, ge/le on dates), `query.search` is free text over string fields. Enum values are SAP's member names (bost_Open, cCustomer). Fails when SAP is unreachable.",
    }))
    .input(z.object({
      entity: EntityZ,
      query: ListQueryZ,
      /** sealed @odata.nextLink from the previous page; absent = first page. There is no
       *  page-size input: B1_PAGE_SIZE (DEFAULT_PAGE) is the one knob, so a client cannot ask for a page the
       *  Service Layer would silently truncate. */
      cursor: z.string().optional(),
      /** ask B1 for the total in the same read; only worth it on the first page */
      count: z.boolean().optional(),
    }))
    .handler(async ({ input, context }) => {
      assertReadable(input.entity, context.role);
      const { b1, companyDb } = await tenantConnector(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      // A list's "Assigned to me": `mine` is the caller's sales employee, read only when asked for.
      const query = input.query.filter.some((c) => c.field === "mine")
        ? withMine(input.query, await salesPersonOf(context.tenantId, context.userId))
        : input.query;
      const page = await readRows(b1, schema, input.entity, { ...input, query, pageSize: DEFAULT_PAGE },
        { tenantId: context.tenantId, key: "internal" });
      // A quotation's configuration is Confire's, not SAP's: `ConfigName`/`ConfigId` ride on the row.
      // ponytail: quotations only — an order or invoice would walk its chain per row
      // (quotationsBehind); add it when a later document's list needs it.
      if (input.entity !== "Quotations" || !page.rows.length) return page;
      const configs = await configsOfQuotations(context.tenantId, companyDb, page.rows.map((r) => Number(r.DocEntry)));
      return { ...page, rows: page.rows.map((r) => {
        const c = configs.get(Number(r.DocEntry));
        return c ? { ...r, ConfigName: c.name, ConfigId: c.id } : r;
      }) };
    }),

  /** One row, with its ETag — which is what makes a curated edit safe. */
  one: userProcedure
    .input(z.object({ entity: EntityZ, key: KeyZ }))
    .handler(async ({ input, context }) => {
      assertReadable(input.entity, context.role);
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      return readOne(b1, schema, input.entity, input.key);
    }),

  /** First/previous/next/last record, walking the single key field the way Beas' record navigation
   *  does: `gt`/`lt` the current key, ordered by it, one row. A composite-key entity has no single
   *  order to walk, so it answers null. `key` is absent for first/last. */
  neighbor: userProcedure
    .input(z.object({ entity: EntityZ, key: KeyZ.optional(), dir: z.enum(["first", "prev", "next", "last"]) }))
    .handler(async ({ input, context }) => {
      assertReadable(input.entity, context.role);
      const b1 = await b1Of(context.tenantId);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, input.entity)).catch(bad);
      const [field] = schema.keys;
      if (!field || schema.keys.length !== 1) return { key: null };
      const back = input.dir === "prev" || input.dir === "last";
      const from = input.dir === "prev" || input.dir === "next";
      if (from && (input.key === undefined || typeof input.key === "object"))
        throw new ORPCError("BAD_REQUEST", { message: t("ENTITY_NEIGHBOUR_NEEDS_KEY") });
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
  update: userProcedure
    .input(z.object({
      entity: EntityZ,
      key: KeyZ,
      etag: z.string().min(1),
      data: z.record(z.string(), z.unknown()),
    }))
    .handler(async ({ input, context }) => {
      const ctx = await writeCtx(context.tenantId, context.userId);
      const { row, etag } = await postWrite(ctx, await prepareWrite(ctx, "profile", { op: "update", ...input }));
      return { row, etag };
    }),

  /** Curated create. `prefer: representation` means the created document comes back in one call.
   *  `notify`: email the document to the customer (document-mail spec §5.3) — a sales document only;
   *  absent is no. A created document belongs to no project. */
  create: userProcedure
    .input(z.object({ entity: EntityZ, data: z.record(z.string(), z.unknown()), notify: z.boolean().optional() }))
    .handler(async ({ input, context }) => {
      if (input.notify && !PRINTABLE.has(input.entity))
        throw new ORPCError("BAD_REQUEST", { message: t("DOCUMENT_MAIL_NOT_PRINTABLE", input.entity) });
      const { b1, companyDb } = await tenantConnector(context.tenantId);
      const ctx = { tenantId: context.tenantId, b1, companyDb, userId: context.userId };
      const { row, etag } = await postWrite(ctx, await prepareWrite(ctx, "profile", { op: "create", entity: input.entity, data: input.data }));
      const mail = input.notify ? await afterPost({
        tenantId: context.tenantId, userId: context.userId, b1, companyDb, entity: input.entity as DocumentMailType, doc: row,
        projects: async () => [],
      }) : null;
      return { row, etag, mail };
    }),

  /** The copy's draft page: the target document `copy` would post, unposted, and the form it is
   *  drawn with — the target's fields, editable only where `copy` takes a change (CopyHeaderZ, a
   *  line's quantity). DeliveryNotes and Invoices stay read-only targets: this is their only form.
   *  `newItems`: the configured parts posting it makes items of first (planCopy). */
  copyDraft: userProcedure
    .input(CopyZ)
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      const { flow, sources, make } = await planCopy(b1, input);
      const schema = await viaB1(() => entitySchema(context.tenantId, b1, flow.target)).catch(bad);
      let draft;
      try {
        draft = buildCopy(flow, sources);
      } catch (e) {
        return bad(e);
      }
      return {
        draft,
        newItems: make.map((m) => m.code),
        constraints: { ...draftConstraints(toConstraints(schema, undefined)), printable: false, flows: [] as { target: string; label: string }[] },
      };
    }),

  /** Order -> Delivery -> Invoice and friends. The target lines carry BaseType/BaseEntry/BaseLine,
   *  which is what makes B1 close the source lines instead of creating an unlinked document.
   *  Several sources of one business partner merge into one target. The draft page's changes ride
   *  along: the header allowlist, and `lines` — the kept lines with their quantities. */
  copy: userProcedure
    .input(CopyInputZ.extend({ notify: z.boolean().optional() }))
    .handler(async ({ input: { notify, ...input }, context }) => {
      const { b1, companyDb } = await tenantConnector(context.tenantId);
      const ctx = { tenantId: context.tenantId, b1, companyDb, userId: context.userId };
      const { entity, row } = await postWrite(ctx, await prepareWrite(ctx, "profile", { op: "copy", input }));
      // Every copy target is a sales document. Its projects: those whose quotations its sources
      // descend from, in this company (document-mail spec §5.6).
      const mail = notify ? await afterPost({
        tenantId: context.tenantId, userId: context.userId, b1, companyDb, entity: entity as DocumentMailType, doc: row,
        projects: async () => projectsOfQuotations(context.tenantId, companyDb, await viaB1(() =>
          quotationsBehind(b1, input.docEntries.map((docEntry) => ({ entity: input.sourceEntity as DocumentMailType, docEntry }))))),
      }) : null;
      return { entity, docEntry: Number(row.DocEntry), docNum: row.DocNum ?? null, row, mail };
    }),

  /** Close a quotation (spec §7.3): `POST Quotations(n)/Close`. Quotations only — the one document
   *  Confire writes — and the agent allowlists the action name again on its side. A re-quote of a
   *  closed quotation posts a new one, so closing is how staff say "start over in SAP".
   *  ponytail: unverified (spec §16) — what B1 answers a Close on a quotation already closed. */
  close: userProcedure
    .input(z.object({ entity: z.literal("Quotations"), key: z.number().int() }))
    .handler(async ({ input, context }) => {
      const b1 = await b1Of(context.tenantId);
      await viaB1(() => b1.action(input.entity, input.key, "Close"));
      const fresh = await viaB1(() => b1.readEntity(input.entity, input.key));
      return { row: fresh.data as Record<string, unknown>, etag: fresh.etag ?? null };
    }),

  /** The document's own SAP print layout, rendered by the API Gateway on-prem and returned as
   *  base64. PRINTABLE is the gate, and the agent allowlists the route again on its side. */
  print: userProcedure
    .input(z.object({ entity: EntityZ, docEntry: z.number().int() }))
    .handler(({ input, context }) => printDocument(context.tenantId, input.entity, input.docEntry)),
};
