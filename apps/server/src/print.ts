import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db, sapConnection } from "@confire/db";
import { agentPost, agentRequester, DirectTransport } from "@confire/b1";
import { agentTarget, viaB1 } from "./b1.ts";
import { PRINTABLE } from "./entity-profiles.ts";
import { t } from "./i18n/index.ts";

// Printing (print spec §5.1). Confire decides what to print and the agent only renders it, so a
// change here ships without an agent update:
//   - the layout is B1's own default for the document — GetDefaultReport for its report code (the
//     entity's prefix + "1" for a service document, "2" for an items one) and its customer, which
//     answers that customer's default when B1 has one, else the general one; GetReportLayout checks
//     it is a Crystal layout, the only kind either engine renders;
//   - the engine is the workspace's (`sap_connection.print_engine`): the SAP API Gateway, or Direct
//     (the agent's confire-print.exe);
//   - then one agentPost on the agent's own `/print` route, not a transport method.
// entities.print and docs.print are the callers; the PRINTABLE allowlist is the fence, and the
// agent checks the layout against the entity again on its side.

export type PrintedDocument = { pdf: string; fileName: string };

export const REPORT_PREFIX: Record<string, string> = { Quotations: "QUT", Orders: "RDR", DeliveryNotes: "DLN", Invoices: "INV" };

/** B1's report code for a document: QUT2 prints an items quotation, QUT1 a service one. */
export const reportCode = (entity: string, docType: unknown): string =>
  REPORT_PREFIX[entity] + (docType === "dDocument_Service" ? "1" : "2");

const LAYOUT_TTL_MS = 2 * 60 * 60 * 1000;
// Keyed by the company the call itself carries, so a company switch never serves the old one's.
// ponytail: per-process Map, never pruned — a few keys per customer; prune if a tenant ever has thousands of customers printing.
const layouts = new Map<string, { layout: string; until: number }>();

/** `doc` is the document when the caller has already read it (CardCode, DocType): one read less. */
export async function printDocument(
  tenantId: string, entity: string, docEntry: number, doc?: { CardCode?: unknown; DocType?: unknown },
): Promise<PrintedDocument> {
  if (!PRINTABLE.has(entity)) throw new ORPCError("FORBIDDEN", { message: t("PRINT_NOT_PRINTABLE", entity) });
  const target = await agentTarget(tenantId);
  const b1 = new DirectTransport(agentRequester(target, "b1"), target.companyDb ?? null);
  const row = doc ?? (await viaB1(() => b1.readEntity(entity, docEntry, { select: ["CardCode", "DocType"] }))).data as
    { CardCode?: unknown; DocType?: unknown };
  const code = reportCode(entity, row.DocType);
  const cardCode = typeof row.CardCode === "string" ? row.CardCode : undefined;
  const key = `${tenantId}|${target.companyDb}|${code}|${cardCode}`;
  const hit = layouts.get(key);
  let layout = hit && hit.until > Date.now() ? hit.layout : undefined;
  if (!layout) {
    const found = (await viaB1(() => b1.createEntity("ReportLayoutsService_GetDefaultReport", { ReportParams: { ReportCode: code, CardCode: cardCode } })))
      .data as { LayoutCode: string };
    const kind = (await viaB1(() => b1.createEntity("ReportLayoutsService_GetReportLayout", { ReportLayoutParams: { LayoutCode: found.LayoutCode } })))
      .data as { Category?: string };
    if (kind.Category !== "rlcCrystal") throw new ORPCError("PRECONDITION_FAILED", { message: t("PRINT_NOT_CRYSTAL", found.LayoutCode) });
    layout = found.LayoutCode;
    layouts.set(key, { layout, until: Date.now() + LAYOUT_TTL_MS });
  }
  const [conn] = await db.select({ engine: sapConnection.printEngine }).from(sapConnection)
    .where(eq(sapConnection.tenantId, tenantId)).limit(1);
  return viaB1(async () => (await agentPost(target, "/print", { entity, docEntry, layout, engine: conn?.engine ?? "gateway" })) as PrintedDocument);
}
