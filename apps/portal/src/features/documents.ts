import type { EntityConstraints } from "@confire/ui/metadata.ts";
import { DOCUMENT_STATUS } from "@confire/ui/documentStatus.ts";
import type { EntityFeature } from "@confire/ui/types.ts";
import type { TextFn } from "./labels.ts";

// A client's SAP documents (spec §13.1). Unlike apps/app's declared features, these pages are built
// from the field list the server sends: the tenant admin's D19 pick (or the code defaults), already
// cut by the denylist. That list — not B1 metadata — decides the page, so "metadata never generates
// a page" still holds. Labels, types and options still merge from the same constraints.

/** The four entities the portal shows; the server refuses any other (restated: the portal imports
 *  only types from the server). */
export type DocEntity = "Quotations" | "Orders" | "DeliveryNotes" | "Invoices";

/** `labelKey` is the list title and the shell item. `numKey` is "{type} {docNum}" on the home page. */
export const DOC_PAGES: Record<DocEntity, { labelKey: string; numKey: string; icon: string }> = {
  Quotations: { labelKey: "PORTAL_DOC_QUOTATIONS", numKey: "PORTAL_DOC_QUOTATION_NUM", icon: "sales-quote" },
  Orders: { labelKey: "PORTAL_DOC_ORDERS", numKey: "PORTAL_DOC_ORDER_NUM", icon: "sales-order" },
  DeliveryNotes: { labelKey: "PORTAL_DOC_DELIVERIES", numKey: "PORTAL_DOC_DELIVERY_NUM", icon: "shipping-status" },
  Invoices: { labelKey: "PORTAL_DOC_INVOICES", numKey: "PORTAL_DOC_INVOICE_NUM", icon: "receipt" },
};

const DOC_STATUS_KEY: Record<string, string> = {
  bost_Open: "PORTAL_DOC_STATUS_OPEN",
  bost_Close: "PORTAL_DOC_STATUS_CLOSED",
  bost_Paid: "PORTAL_DOC_STATUS_PAID",
  bost_Delivered: "PORTAL_DOC_STATUS_DELIVERED",
};

export const isDocEntity = (e: string): e is DocEntity => Object.hasOwn(DOC_PAGES, e);

const WIDTH: Record<string, number> = { DocNum: 110, DocDate: 120, DocDueDate: 120, DocumentStatus: 120, DocTotal: 130, DocCurrency: 90 };
/** Newest first — DocEntry, not DocNum, which restarts per series. */
const NEWEST = [{ field: "DocEntry", direction: "desc" as const }];
const LINES = "DocumentLines";

export function docFeature(entity: DocEntity, c: EntityConstraints, t: TextFn): EntityFeature {
  const page = DOC_PAGES[entity];
  const label = t(page.labelKey);
  const scalars = Object.entries(c.fields).filter(([k, m]) => k !== "DocEntry" && m.Type !== "collection").map(([k]) => k);
  const lines = Object.keys(c.fields[LINES]?.Fields ?? {});
  const statusMapping = Object.fromEntries(
    Object.entries(DOCUMENT_STATUS ?? {}).flatMap(([k, v]) => (v ? [[k, { ...v, text: t(DOC_STATUS_KEY[k] ?? k) }]] : [])),
  );
  return {
    entity,
    label,
    icon: page.icon,
    keyField: "DocEntry",
    list: {
      tableId: `portal:docs:${entity}`,
      title: label,
      columns: scalars.map((key) => ({ key, ...(WIDTH[key] ? { width: WIDTH[key] } : {}) })),
      filterFields: [{ key: "DocNum", exact: true }, { key: "DocDate" }, { key: "DocumentStatus" }],
      systemViews: [
        { key: "default", name: t("PORTAL_VIEW_STANDARD"), isDefault: true, state: { sortBy: NEWEST } },
        { key: "open", name: t("PORTAL_VIEW_OPEN"), state: { sortBy: NEWEST, filterValues: { DocumentStatus: ["bost_Open"] } } },
      ],
    },
    detail: {
      header: {
        titleField: "DocNum",
        subtitleFields: ["DocDate"],
        facets: [
          { field: "DocumentStatus", type: "status", statusMapping },
          { field: "DocTotal", type: "numeric", unitField: "DocCurrency" },
        ],
      },
      sections: [
        { id: "general", label: t("PORTAL_GENERAL"), groups: [{ id: "document", label: t("PORTAL_DOCUMENT"), fields: scalars.map((key) => ({ key })) }] },
        ...(lines.length ? [{ id: "lines", label: t("PORTAL_LINES"), table: { key: LINES, columns: lines.map((key) => ({ key })) } }] : []),
      ],
    },
  };
}
