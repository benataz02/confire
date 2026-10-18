import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, configProject, configProjectEvent, ListQueryZ } from "@confire/db";
import { escapeLiteral, type B1Transport } from "@confire/b1";
import { portalMemberProcedure } from "./base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema, toConstraints } from "../../entity-meta.ts";
import { bad, readRows } from "../../entity-read.ts";
import { printDocument } from "../../print.ts";
import { DEFAULT_PAGE } from "../../lookups.ts";
import { DocEntityZ, portalSchema, projectRow, type DocEntity } from "../doc-fields.ts";
import { loadPortalSettings } from "../settings.ts";

// A client's own SAP documents (spec §13.1): quotations, orders, deliveries, invoices. Every read
// goes through portalSchema — the tenant's field list minus the denylist — and the CardCode fence:
// a list appends `CardCode eq …` after compiling, a cursor is sealed to the company, and a single
// document is read before anything of it is returned. The shapes mirror entities.* so the portal
// plugs these into @confire/ui's source and the shells run unchanged.

type Seat = { tenantId: string; companyId: string; cardCode: string };

async function docSchema(tenantId: string, b1: B1Transport, entity: DocEntity) {
  const [schema, settings] = await Promise.all([
    viaB1(() => entitySchema(tenantId, b1, entity)).catch(bad),
    loadPortalSettings(tenantId),
  ]);
  return portalSchema(schema, settings.docFields?.[entity]);
}

/** One document, after its CardCode is the seat's: a guessed DocEntry of another company is
 *  NOT_FOUND, never a "forbidden" that would confirm it exists. */
async function ownDoc(b1: B1Transport, seat: Seat, entity: DocEntity, docEntry: number, select?: string[]) {
  const row = (await viaB1(() => b1.readEntity(entity, docEntry, select ? { select } : undefined))).data as Record<string, unknown>;
  if (row.CardCode !== seat.cardCode) throw new ORPCError("NOT_FOUND");
  return row;
}

// Base document type → the entity it names (DOCUMENT_FLOWS' codes, the ones doc-chain.ts walks forward).
const BASE: Record<number, DocEntity> = { 23: "Quotations", 17: "Orders", 15: "DeliveryNotes" };

/** The quotations a document descends from, walking back through its lines' BaseType/BaseEntry —
 *  invoice → delivery → order → quotation at most. Only the first document is CardCode-checked: the
 *  project lookup it feeds is fenced on the company anyway.
 *  ponytail: at most 10 documents per hop — raise it if one invoice ever gathers more base documents. */
async function quotationsBehind(b1: B1Transport, seat: Seat, entity: DocEntity, docEntry: number): Promise<number[]> {
  const found = new Set<number>();
  let frontier: { entity: DocEntity; docEntry: number }[] = [{ entity, docEntry }];
  for (let hop = 0; hop < 4 && frontier.length; hop++) {
    const next = new Map<string, { entity: DocEntity; docEntry: number }>();
    for (const d of frontier.slice(0, 10)) {
      if (hop > 0 && d.entity === "Quotations") { found.add(d.docEntry); continue; }
      const row = hop === 0
        ? await ownDoc(b1, seat, d.entity, d.docEntry, ["CardCode", "DocumentLines"])
        : (await viaB1(() => b1.readEntity(d.entity, d.docEntry, { select: ["DocumentLines"] }))).data as Record<string, unknown>;
      if (d.entity === "Quotations") { found.add(d.docEntry); continue; }
      for (const l of (row.DocumentLines as Record<string, unknown>[] | undefined) ?? []) {
        const base = BASE[Number(l.BaseType)];
        const entry = Number(l.BaseEntry);
        if (base && Number.isInteger(entry) && entry > 0) next.set(`${base}:${entry}`, { entity: base, docEntry: entry });
      }
    }
    frontier = [...next.values()];
  }
  return [...found];
}

const EntityInputZ = z.object({ entity: DocEntityZ });
const DocInputZ = z.object({ entity: DocEntityZ, docEntry: z.number().int() });

export const docsRouter = {
  /** The cut schema as constraints: read-only (no profile), printable — all four are. */
  metadata: portalMemberProcedure.input(EntityInputZ).handler(async ({ input, context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    const schema = await docSchema(context.tenantId, b1, input.entity);
    return { ...toConstraints(schema, undefined), printable: true, flows: [] as { target: string; label: string }[] };
  }),

  /** One page of the company's documents. The fence is ANDed onto the compiled filter, so no saved
   *  view can widen it; the cursor key is the company, so a page link is no use to another one. */
  rows: portalMemberProcedure
    .input(z.object({ entity: DocEntityZ, query: ListQueryZ, cursor: z.string().optional(), count: z.boolean().optional() }))
    .handler(async ({ input, context }) => {
      const { b1 } = await tenantConnector(context.tenantId);
      const schema = await docSchema(context.tenantId, b1, input.entity);
      const page = await readRows(b1, schema, input.entity, { ...input, pageSize: DEFAULT_PAGE },
        { tenantId: context.tenantId, key: `portal:${context.companyId}` },
        `CardCode eq '${escapeLiteral(context.cardCode)}'`);
      return { ...page, rows: page.rows.map((r) => projectRow(schema, r as Record<string, unknown>)) };
    }),

  /** One document, cut to the schema. No ETag: nothing on the portal writes one back. */
  one: portalMemberProcedure
    .input(z.object({ entity: DocEntityZ, key: z.number().int() }))
    .handler(async ({ input, context }) => {
      const { b1 } = await tenantConnector(context.tenantId);
      const [schema, row] = await Promise.all([
        docSchema(context.tenantId, b1, input.entity),
        ownDoc(b1, context, input.entity, input.key),
      ]);
      return { row: projectRow(schema, row), etag: null };
    }),

  /** The document's SAP print layout, after the CardCode check (§8). */
  print: portalMemberProcedure.input(DocInputZ).handler(async ({ input, context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    await ownDoc(b1, context, input.entity, input.docEntry, ["CardCode"]);
    return printDocument(context.tenantId, input.entity, input.docEntry);
  }),

  /** The company's project this document came from, or null: the newest `quoted` event naming one of
   *  the quotations behind it. Its own call, so a slow walk never holds up the document page. */
  project: portalMemberProcedure.input(DocInputZ).handler(async ({ input, context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    const quotations = await quotationsBehind(b1, context, input.entity, input.docEntry);
    if (!quotations.length) return null;
    const [hit] = await db
      .select({ id: configProject.id, name: configProject.name })
      .from(configProjectEvent)
      .innerJoin(configProject, eq(configProject.id, configProjectEvent.projectId))
      .where(and(
        eq(configProjectEvent.tenantId, context.tenantId),
        eq(configProjectEvent.kind, "quoted"),
        inArray(sql<number>`(${configProjectEvent.payload}->>'docEntry')::int`, quotations),
        eq(configProject.tenantId, context.tenantId),
        eq(configProject.portalCompanyId, context.companyId),
      ))
      .orderBy(desc(configProjectEvent.at))
      .limit(1);
    return hit ?? null;
  }),
};
