import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, configProject, configProjectEvent, ListQueryZ } from "@confire/db";
import { escapeLiteral, rowsOf, type B1Transport } from "@confire/b1";
import { portalMemberProcedure } from "./base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { entitySchema, toConstraints } from "../../entity-meta.ts";
import { bad, readRows } from "../../entity-read.ts";
import { printDocument } from "../../print.ts";
import { quotationsBehind } from "../../doc-chain.ts";
import { configsOfQuotations } from "../../document-mail.ts";
import { DEFAULT_PAGE } from "../../lookups.ts";
import { DocEntityZ, portalSchema, projectRow, type DocEntity } from "../doc-fields.ts";
import { loadPortalSettings } from "../settings.ts";

// A client's own SAP documents (spec §13.1): quotations, orders, deliveries, invoices. Every read
// goes through portalSchema — the tenant's field list minus the denylist — and the CardCode fence:
// a list appends `CardCode eq …` after compiling, a cursor is sealed to the company, and a single
// document is read before anything of it is returned. The shapes mirror entities.* so the portal
// plugs these into @confire/ui's source and the shells run unchanged.

type Seat = { tenantId: string; cardCode: string };

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

/** Names for what a row only carries as a code or a key, read for these rows alone: the sales
 *  employee (`SalesPersonName`, when the admin shows SalesPersonCode — never the supplier's whole
 *  staff list) and, on a quotation, the company's own project (`ConfigName`/`ConfigId`). -1 is B1's
 *  "no sales employee". A failed name read leaves the names off, never the page. */
async function withNames(b1: B1Transport, companyDb: string | null, seat: Seat, entity: DocEntity, rows: Record<string, unknown>[]) {
  const codes = [...new Set(rows.map((r) => r.SalesPersonCode).filter((c): c is number => typeof c === "number" && c >= 0))];
  const [sales, configs] = await Promise.all([
    codes.length
      ? b1.readEntitySet("SalesPersons", {
        filter: codes.map((c) => `SalesEmployeeCode eq ${c}`).join(" or "),
        select: ["SalesEmployeeCode", "SalesEmployeeName"], maxPageSize: codes.length,
      }).then((res) => new Map(rowsOf(res.data).map((s) => [Number(s.SalesEmployeeCode), String(s.SalesEmployeeName ?? "")])), () => new Map<number, string>())
      : new Map<number, string>(),
    entity === "Quotations"
      ? configsOfQuotations(seat.tenantId, companyDb, rows.map((r) => Number(r.DocEntry)), seat.cardCode)
      : new Map<number, { id: string; name: string }>(),
  ]);
  if (!sales.size && !configs.size) return rows;
  return rows.map((r) => {
    const s = sales.get(r.SalesPersonCode as number);
    const c = configs.get(Number(r.DocEntry));
    return { ...r, ...(s !== undefined ? { SalesPersonName: s } : {}), ...(c ? { ConfigName: c.name, ConfigId: c.id } : {}) };
  });
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
      const { b1, companyDb } = await tenantConnector(context.tenantId);
      const schema = await docSchema(context.tenantId, b1, input.entity);
      // The page's sales employee column is the name (docFeature), so read the code it is named by.
      const query = input.query.select.includes("SalesPersonName")
        ? { ...input.query, select: [...input.query.select, "SalesPersonCode"] }
        : input.query;
      const page = await readRows(b1, schema, input.entity, { ...input, query, pageSize: DEFAULT_PAGE },
        { tenantId: context.tenantId, key: `portal:${context.cardCode}` },
        `CardCode eq '${escapeLiteral(context.cardCode)}'`);
      const rows = page.rows.map((r) => projectRow(schema, r as Record<string, unknown>));
      return { ...page, rows: await withNames(b1, companyDb, context, input.entity, rows) };
    }),

  /** One document, cut to the schema. No ETag: nothing on the portal writes one back. */
  one: portalMemberProcedure
    .input(z.object({ entity: DocEntityZ, key: z.number().int() }))
    .handler(async ({ input, context }) => {
      const { b1, companyDb } = await tenantConnector(context.tenantId);
      const [schema, row] = await Promise.all([
        docSchema(context.tenantId, b1, input.entity),
        ownDoc(b1, context, input.entity, input.key),
      ]);
      const [named] = await withNames(b1, companyDb, context, input.entity, [projectRow(schema, row)]);
      return { row: named!, etag: null };
    }),

  /** The document's SAP print layout, after the CardCode check (§8). */
  print: portalMemberProcedure.input(DocInputZ).handler(async ({ input, context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    const row = await ownDoc(b1, context, input.entity, input.docEntry, ["CardCode", "DocType"]);
    return printDocument(context.tenantId, input.entity, input.docEntry, row);
  }),

  /** The company's project this document came from, or null: the newest `quoted` event naming one of
   *  the quotations behind it. Its own call, so a slow walk never holds up the document page. */
  project: portalMemberProcedure.input(DocInputZ).handler(async ({ input, context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    // The seat check is on the first document; the project lookup below is fenced on the company anyway.
    const quotations = await viaB1(() => quotationsBehind(b1, [{ entity: input.entity, docEntry: input.docEntry }],
      (d) => ownDoc(b1, context, d.entity as DocEntity, d.docEntry, ["CardCode", "DocumentLines"])));
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
        eq(configProject.portalCardCode, context.cardCode),
      ))
      .orderBy(desc(configProjectEvent.at))
      .limit(1);
    return hit ?? null;
  }),
};
