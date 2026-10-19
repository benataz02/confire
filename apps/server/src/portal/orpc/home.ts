import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db, configProject, type ProjectStatus } from "@confire/db";
import { escapeLiteral, rowsOf } from "@confire/b1";
import { portalMemberProcedure } from "./base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { ALWAYS, type DocEntity } from "../doc-fields.ts";

// The portal home (spec §9): two calls on purpose — Postgres and live SAP — so an agent that is
// down costs the two document cards, not the page.

const doc = (entity: DocEntity, r: Record<string, unknown>) => ({
  entity, docEntry: Number(r.DocEntry), docNum: Number(r.DocNum ?? 0), docDate: String(r.DocDate ?? ""),
  docTotal: Number(r.DocTotal ?? 0), currency: String(r.DocCurrency ?? ""), status: String(r.DocumentStatus ?? ""),
});

export const homeRouter = {
  /** The company's projects by status, and the quotations waiting for its answer. */
  overview: portalMemberProcedure.handler(async ({ context }) => {
    const mine = and(eq(configProject.tenantId, context.tenantId), eq(configProject.portalCardCode, context.cardCode));
    const [byStatus, awaiting] = await Promise.all([
      db.select({ status: configProject.status, n: count() }).from(configProject).where(mine).groupBy(configProject.status),
      db.select({ id: configProject.id, name: configProject.name, quotedAt: configProject.quotedAt })
        .from(configProject)
        .where(and(mine, eq(configProject.status, "quoted"), isNull(configProject.quoteResponse)))
        .orderBy(desc(configProject.quotedAt))
        .limit(5),
    ]);
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])) as Partial<Record<ProjectStatus, number>>,
      awaiting,
    };
  }),

  /** The five newest quotations, orders and deliveries together, and the oldest open invoices with
   *  how many there are. ALWAYS fields only — every portal schema shows those — and the same
   *  CardCode fence as docs.rows. */
  documents: portalMemberProcedure.handler(async ({ context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    const fence = `CardCode eq '${escapeLiteral(context.cardCode)}'`;
    const read = (entity: DocEntity, filter: string, orderby: string, extra?: { count: true }) =>
      viaB1(() => b1.readEntitySet(entity, { filter, select: ALWAYS, orderby, top: 5, ...extra }));
    const [q, o, d, inv] = await Promise.all([
      read("Quotations", fence, "DocDate desc,DocEntry desc"),
      read("Orders", fence, "DocDate desc,DocEntry desc"),
      read("DeliveryNotes", fence, "DocDate desc,DocEntry desc"),
      read("Invoices", `${fence} and DocumentStatus eq 'bost_Open'`, "DocDate asc,DocEntry asc", { count: true }),
    ]);
    const recent = [
      ...rowsOf(q.data).map((r) => doc("Quotations", r)),
      ...rowsOf(o.data).map((r) => doc("Orders", r)),
      ...rowsOf(d.data).map((r) => doc("DeliveryNotes", r)),
    ].sort((a, b) => b.docDate.localeCompare(a.docDate) || b.docEntry - a.docEntry).slice(0, 5);
    const invoices = rowsOf(inv.data).map((r) => doc("Invoices", r));
    const total = (inv.data as { "@odata.count"?: unknown } | null)?.["@odata.count"];
    return { recent, openInvoices: { rows: invoices, count: typeof total === "number" ? total : invoices.length } };
  }),
};
