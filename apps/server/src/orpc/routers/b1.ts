import { ORPCError } from "@orpc/server";
import { openapi } from "@orpc/openapi";
import { z } from "zod";
import { ListQueryZ, type ListQuery } from "@confire/db";
import { CATEGORY_NAMES, categoriesOf, type B1EntitySchema, type B1Field, type Key } from "@confire/b1";
import { userProcedure } from "../base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entityList, entitySchema } from "../../entity-meta.ts";
import { scalarFields } from "../../entity-list.ts";
import { assertReadable, profileOf, readableBy } from "../../entity-profiles.ts";
import { bad, LIST_CAP, readOne, readRows } from "../../entity-read.ts";
import {
  collectionOf, CopyInputZ, EntityZ, KeyZ, postWrite, prepareWrite, unknownNames,
  type CopyInput, type Posted, type Prepared, type WriteCtx,
} from "../../entity-write.ts";
import { flowsFrom } from "../../doc-copy.ts";
import { autoWrite } from "../../assistant/auto.ts";
import { t } from "../../i18n/index.ts";

// The SAP tools (b1-tools spec §5.1): one implementation for the in-app assistant (tools.ts makes each
// procedure a tool, `b1.read` → `b1_read`) and, in phase 3, MCP (`@orpc/mcp`). MCP gets the bare
// procedures, so every tool behaviour lives in the handlers — the caps, the strict names, the
// proposals; the chat adds nothing. `b1.post` is the user's click and is never a tool.
//
// Reads go over every entity set the Service Layer exposes, but for ADMIN_ONLY_READS (admins only).
// Writes are the curated entities with every field of their schema — the `schema` field rule — and
// answer a proposal unless auto mode is on (assistant/auto.ts).

const MAX_FOUND = 30;

const ctxOf = async (tenantId: string): Promise<WriteCtx> => ({ tenantId, b1: (await tenantConnector(tenantId)).b1 });
const schemaOf = (c: WriteCtx, entity: string) => viaB1(() => entitySchema(c.tenantId, c.b1, entity)).catch(bad);

// --- schema, compact -------------------------------------------------------------------------------

type CompactField = { name: string; type: string; label?: string; values?: string[]; required?: true; ref?: string };

function compact(f: B1Field, required: Set<string>): CompactField {
  return {
    name: f.name,
    type: f.kind,
    ...(f.label && f.label !== f.name ? { label: f.label } : {}),
    // B1's member names are what the Service Layer sends and filters on (bost_Open, cCustomer).
    ...(f.options?.length ? { values: f.options.map((o) => o.label) } : {}),
    ...(required.has(f.name) ? { required: true as const } : {}),
    ...(f.lookup ? { ref: `${f.lookup.entitySet}.${f.lookup.keyField}` } : {}),
  };
}

// --- strict names ------------------------------------------------------------------------------------

/** Every name a list query uses must be the schema's — checked before compileList, which drops an
 *  unknown select/orderby on purpose (a saved view outliving a UDF). A select may name a collection;
 *  a filter, a sort or a search field only a scalar. */
function checkQueryNames(schema: B1EntitySchema, q: ListQuery): void {
  const all = schema.fields.map((f) => f.name);
  const scalars = scalarFields(schema).map((f) => f.name);
  const allSet = new Set(all);
  const scalarSet = new Set(scalars);
  const wrong = [
    ...q.select.filter((n) => !allSet.has(n)).map((name) => ({ name, among: all })),
    ...[...q.filter.map((c) => c.field), ...q.orderby.map((o) => o.field), ...(q.searchFields ?? [])]
      .filter((n) => !scalarSet.has(n)).map((name) => ({ name, among: scalars })),
  ];
  const seen = new Set<string>();
  const unique = wrong.filter((w) => !seen.has(w.name) && !!seen.add(w.name));
  if (unique.length) throw unknownNames(schema.name, unique);
}

const QueryZ = ListQueryZ.partial();
const normal = (q: z.infer<typeof QueryZ> | undefined): ListQuery =>
  ({ ...q, select: q?.select ?? [], filter: q?.filter ?? [], orderby: q?.orderby ?? [] });

// --- proposals -----------------------------------------------------------------------------------

export type Change = { before: unknown; after: unknown };
export const ProposalZ = z.object({
  op: z.enum(["create", "update", "copy"]),
  entity: EntityZ,
  key: KeyZ.optional(),
  etag: z.string().optional(),
  /** the exact data a create/update posts; a copy's input */
  payload: z.record(z.string(), z.unknown()),
  changes: z.record(z.string(), z.object({ before: z.unknown(), after: z.unknown() })).optional(),
  title: z.string().optional(),
});
export type Proposal = z.infer<typeof ProposalZ>;

/** An update's lines: each line sent as it is now (by LineNum, the fields it changes) and as it will
 *  be. B1 merges a PATCHed collection by LineNum: a line without one is added, an unsent one kept. */
function linesBefore(now: unknown, sent: unknown): unknown {
  if (!Array.isArray(sent) || !Array.isArray(now)) return null;
  return sent.map((l: Record<string, unknown>) => {
    const cur = now.find((x: Record<string, unknown>) => l.LineNum !== undefined && x.LineNum === l.LineNum) as Record<string, unknown> | undefined;
    return cur ? Object.fromEntries(Object.keys(l).map((k) => [k, cur[k] ?? null])) : null;
  });
}

function proposalOf(p: Prepared): Proposal {
  const changes: Record<string, Change> = {};
  for (const [k, after] of Object.entries(p.payload)) {
    const before = p.op === "update" && p.before ? (Array.isArray(after) ? linesBefore(p.before[k], after) : p.before[k] ?? null) : null;
    changes[k] = { before, after };
  }
  if (p.op === "copy") {
    const src = p.input;
    return {
      op: "copy", entity: p.entity, payload: src as unknown as Record<string, unknown>, changes,
      title: t("B1_TITLE_COPY", src.sourceEntity, src.docEntries.join(", "), p.entity),
    };
  }
  if (p.op === "create") return { op: "create", entity: p.entity, payload: p.payload, changes, title: t("B1_TITLE_CREATE", p.entity) };
  const num = p.before?.DocNum ?? (typeof p.key === "object" ? JSON.stringify(p.key) : p.key);
  return { op: "update", entity: p.entity, key: p.key, etag: p.etag, payload: p.payload, changes, title: t("B1_TITLE_UPDATE", p.entity, String(num)) };
}

const linkOf = (entity: string, key: Key | null) =>
  key === null ? null : `/b1/${entity}/${encodeURIComponent(typeof key === "object" ? JSON.stringify(key) : String(key))}`;

function written(p: Posted) {
  const docNum = p.row.DocNum;
  return {
    written: { entity: p.entity, key: p.key, ...(typeof docNum === "number" || typeof docNum === "string" ? { docNum } : {}) },
    row: p.row,
    link: linkOf(p.entity, p.key),
  };
}

type Ctx = { tenantId: string; userId: string; assistantThreadId?: string; mcpUserId?: string };

/** Post it, or answer it as a proposal: auto mode decides (§5.3). */
async function postOrPropose(c: Ctx, w: WriteCtx, p: Prepared) {
  return (await autoWrite(c, { target: p.entity })) ? written(await postWrite(w, p)) : { proposal: proposalOf(p) };
}

const WRITE_NOTE = "Unless auto mode is on, this writes nothing: it answers a `proposal` that the user posts or discards with a click. In Confire's chat your turn ends on that answer, so say in one short sentence what you propose before you call it. Never say a record was written unless the answer has `written`.";

export const b1Router = {
  find: userProcedure
    .meta(openapi({
      summary: "Find SAP record types",
      description: `Find SAP Business One entity sets by name, label or table (\`query\`, e.g. "invoice", "OINV", "warehouse") or by \`category\` (${CATEGORY_NAMES.join(", ")}). Answers each set's name, label, categories, whether Confire can write it (\`writable\`) and the documents it copies to (\`copyTo\`); at most ${MAX_FOUND}. Called with neither, it lists the categories. Skip it when you know the set's name: b1_read takes SAP's own names directly.`,
    }))
    .input(z.object({
      query: z.string().trim().max(100).optional().describe("Text to look for in the set's name, label or table"),
      category: z.enum(CATEGORY_NAMES as [string, ...string[]]).optional().describe("A business area"),
    }))
    .handler(async ({ input, context }) => {
      if (!input.query && !input.category) return { categories: CATEGORY_NAMES, entities: [], total: 0 };
      const c = await ctxOf(context.tenantId);
      const list = (await viaB1(() => entityList(c.tenantId, c.b1)).catch(bad)).filter((e) => readableBy(context.role)(e.name));
      const q = input.query?.toLowerCase();
      const hits = list
        .map((e) => ({ e, cats: categoriesOf(e) }))
        .filter(({ e, cats }) => (!input.category || cats.includes(input.category))
          && (!q || [e.name, e.label, e.table].some((s) => s.toLowerCase().includes(q))))
        // The name itself first, then names that start with it, then the rest.
        .sort((a, b) => rank(a.e.name, q) - rank(b.e.name, q) || a.e.name.localeCompare(b.e.name));
      return {
        entities: hits.slice(0, MAX_FOUND).map(({ e, cats }) => ({
          name: e.name,
          ...(e.label !== e.name ? { label: e.label } : {}),
          categories: cats,
          writable: !!profileOf(e.name),
          copyTo: flowsFrom(e.name).map((f) => f.target),
        })),
        total: hits.length,
      };
    }),

  schema: userProcedure
    .meta(openapi({
      summary: "An SAP record type's fields",
      description: "The fields of one SAP entity set, compact: its keys, then each field's name, type, label, enum `values` (SAP's member names, which filters and writes use), `required` on create, and `ref` (the set and key a code field points to). Collections (a document's DocumentLines) are listed by name; pass `collection` for a collection's own fields. Only when you need it: a misspelled name in b1_read or b1_write is refused with the closest real names.",
    }))
    .input(z.object({ entity: EntityZ.describe("SAP's entity set name, e.g. Orders"), collection: z.string().optional().describe("A collection of it, e.g. DocumentLines") }))
    .handler(async ({ input, context }) => {
      const c = await ctxOf(context.tenantId);
      const schema = await schemaOf(c, input.entity);
      const profile = profileOf(input.entity);
      const required = new Set(profile?.requiredOnCreate ?? []);
      if (input.collection) {
        const col = collectionOf(schema, input.collection);
        if (!col) throw unknownNames(input.entity, [{ name: input.collection, among: schema.fields.filter((f) => f.kind === "collection").map((f) => f.name) }]);
        return { entity: schema.name, collection: col.name, fields: (col.fields ?? []).map((f) => compact(f, new Set())) };
      }
      return {
        entity: schema.name,
        ...(schema.label !== schema.name ? { label: schema.label } : {}),
        keys: schema.keys,
        writable: !!profile,
        copyTo: flowsFrom(schema.name).map((f) => f.target),
        fields: scalarFields(schema).map((f) => compact(f, required)),
        collections: schema.fields.filter((f) => f.kind === "collection").map((f) => ({
          name: f.name, fields: f.fields?.length ?? 0, ...(required.has(f.name) ? { required: true } : {}),
        })),
      };
    }),

  read: userProcedure
    .meta(openapi({
      summary: "Read SAP records",
      description: `Read SAP Business One records live, by SAP's own names: Quotations, Orders, DeliveryNotes, Invoices (key DocEntry; DocNum is the number people say), BusinessPartners (CardCode), Items (ItemCode), or any other set b1_find finds. With \`key\`: that one record, whole, with its \`etag\`. Else a list: \`query.select\` names fields (empty = every scalar field; a collection such as DocumentLines only when named), \`query.filter\` narrows (eq, ne, gt, ge, lt, le, contains, startswith, in), \`query.orderby\` sorts, \`query.search\` is free text over string fields. Enum values are SAP's member names (bost_Open, cCustomer). At most ${LIST_CAP} rows; \`total\` says how many match and \`nextCursor\` reads the next page. A wrong field name is refused with the closest real ones.`,
    }))
    .input(z.object({
      entity: EntityZ.describe("SAP's entity set name"),
      key: KeyZ.optional().describe("One record's key: a number (DocEntry), a code (CardCode, ItemCode), or an object for a composite key"),
      query: QueryZ.optional().describe("A list's fields, filters, sort and search"),
      cursor: z.string().optional().describe("The previous answer's nextCursor"),
    }))
    .handler(async ({ input, context }) => {
      assertReadable(input.entity, context.role);
      const c = await ctxOf(context.tenantId);
      const schema = await schemaOf(c, input.entity);
      if (input.key !== undefined) return readOne(c.b1, schema, input.entity, input.key);
      const query = normal(input.query);
      checkQueryNames(schema, query);
      const collections = new Set(schema.fields.filter((f) => f.kind === "collection").map((f) => f.name));
      const wholeRows = query.select.some((n) => collections.has(n));
      const page = await readRows(c.b1, schema, input.entity, { query, pageSize: LIST_CAP, cursor: input.cursor, count: !input.cursor, wholeRows },
        { tenantId: context.tenantId, key: "b1-tool" });
      const keep = new Set([...schema.keys, ...query.select]);
      const rows = page.rows.slice(0, LIST_CAP).map((r) => (wholeRows ? Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))) : r));
      return { rows, keys: page.keys, total: page.total, nextCursor: page.nextCursor };
    }),

  write: userProcedure
    .meta(openapi({
      summary: "Create or change an SAP record",
      description: `Create a record (no \`key\`) or change one (\`key\`, and the \`etag\` from your b1_read if you read it) of Quotations, Orders, BusinessPartners or Items, with SAP's field names — any field of the record, a document's DocumentLines included (on a change, a line with its LineNum changes that line; one without is added). \`data\` holds only what to set. Required on create: Quotations/Orders CardCode and DocumentLines; BusinessPartners CardCode, CardName, CardType; Items ItemCode, ItemName. A wrong field name is refused with the closest real ones. ${WRITE_NOTE}`,
    }))
    .input(z.object({
      entity: EntityZ.describe("Quotations, Orders, BusinessPartners or Items"),
      key: KeyZ.optional().describe("The record to change; absent = create"),
      etag: z.string().optional().describe("The etag b1_read answered with the record; a record changed since is refused"),
      data: z.record(z.string(), z.unknown()).describe("Field → value, SAP's names"),
    }))
    .handler(async ({ input, context }) => {
      const c = await ctxOf(context.tenantId);
      const p = await prepareWrite(c, "schema", input.key === undefined
        ? { op: "create", entity: input.entity, data: input.data }
        : { op: "update", entity: input.entity, key: input.key, etag: input.etag, data: input.data }, { readBefore: true });
      return postOrPropose(context, c, p);
    }),

  copy: userProcedure
    .meta(openapi({
      summary: "Copy SAP documents along their flow",
      description: `Make the next document from one or more of a business partner's documents, linked so SAP closes the source lines: Quotations→Orders, Orders→DeliveryNotes, Orders→Invoices, DeliveryNotes→Invoices. \`docEntries\` are the sources' DocEntry. \`header\` may set DocDate, DocDueDate, NumAtCard, Comments; \`lines\` (by the source's DocEntry and LineNum) keeps only those lines with their quantities — a partial delivery or invoice. A copy to Invoices is always a proposal. ${WRITE_NOTE}`,
    }))
    .input(CopyInputZ)
    .handler(async ({ input, context }) => {
      const c = await ctxOf(context.tenantId);
      return postOrPropose(context, c, await prepareWrite(c, "schema", { op: "copy", input }));
    }),

  /** The user's click on a proposal (the spec's `b1.apply`: oRPC's client reserves `apply`, `call` and
   *  `bind` as proxy keys, so a procedure named `apply` cannot be called from a browser). The same
   *  checks again on what the card showed, then the post,
   *  with the proposal's ETag — a record changed since answers CONFLICT, and the card says to ask
   *  again. Never a tool and never in the MCP filter: the model cannot approve its own proposal.
   *  ponytail: a lost response followed by a retry can post twice; add a command id (`U_CF_Key`, as
   *  quotations do) to the curated tables if that shows up. */
  post: userProcedure
    .input(z.object({ proposal: ProposalZ }))
    .handler(async ({ input, context }) => {
      const { proposal: pr } = input;
      const c = await ctxOf(context.tenantId);
      let p: Prepared;
      if (pr.op === "copy") {
        const parsed = CopyInputZ.safeParse(pr.payload);
        if (!parsed.success) throw new ORPCError("BAD_REQUEST", { message: t("B1_APPLY_CHANGED") });
        const copy: CopyInput = parsed.data;
        if (copy.targetEntity !== pr.entity) throw new ORPCError("BAD_REQUEST", { message: t("B1_APPLY_CHANGED") });
        p = await prepareWrite(c, "schema", { op: "copy", input: copy });
      } else if (pr.op === "create") {
        p = await prepareWrite(c, "schema", { op: "create", entity: pr.entity, data: pr.payload });
      } else {
        if (pr.key === undefined || !pr.etag) throw new ORPCError("BAD_REQUEST", { message: t("B1_APPLY_CHANGED") });
        p = await prepareWrite(c, "schema", { op: "update", entity: pr.entity, key: pr.key, etag: pr.etag, data: pr.payload }, { readBefore: true });
      }
      return written(await postWrite(c, p));
    }),
};

function rank(name: string, q: string | undefined): number {
  if (!q) return 0;
  const l = name.toLowerCase();
  return l === q ? 0 : l.startsWith(q) ? 1 : 2;
}
