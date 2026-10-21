import type { EntityConstraints } from "@confire/ui/metadata.ts";
import { DOCUMENT_STATUS } from "@confire/ui/documentStatus.ts";
import type { EntityFeature } from "@confire/ui/types.ts";

// A client's SAP documents (spec §13.1). Unlike apps/app's declared features, these pages are built
// from the field list the server sends: the tenant admin's D19 pick (or the code defaults), already
// cut by the denylist. That list — not B1 metadata — decides the page, so "metadata never generates
// a page" still holds. Labels, types and options still merge from the same constraints.

/** The four entities the portal shows; the server refuses any other (restated: the portal imports
 *  only types from the server). */
export type DocEntity = "Quotations" | "Orders" | "DeliveryNotes" | "Invoices";

export const DOC_PAGES: Record<DocEntity, { label: string; one: string; icon: string }> = {
  Quotations: { label: "Quotations", one: "quotation", icon: "sales-quote" },
  Orders: { label: "Sales orders", one: "sales order", icon: "sales-order" },
  DeliveryNotes: { label: "Deliveries", one: "delivery", icon: "shipping-status" },
  Invoices: { label: "Invoices", one: "invoice", icon: "receipt" },
};

export const isDocEntity = (e: string): e is DocEntity => Object.hasOwn(DOC_PAGES, e);

const WIDTH: Record<string, number> = { DocNum: 110, DocDate: 120, DocDueDate: 120, DocumentStatus: 120, DocTotal: 130, DocCurrency: 90 };
/** Newest first — DocEntry, not DocNum, which restarts per series. */
const NEWEST = [{ field: "DocEntry", direction: "desc" as const }];
const LINES = "DocumentLines";

export function docFeature(entity: DocEntity, c: EntityConstraints): EntityFeature {
  const page = DOC_PAGES[entity];
  const scalars = Object.entries(c.fields).filter(([k, m]) => k !== "DocEntry" && m.Type !== "collection").map(([k]) => k);
  const lines = Object.keys(c.fields[LINES]?.Fields ?? {});
  return {
    entity,
    label: page.label,
    icon: page.icon,
    keyField: "DocEntry",
    list: {
      tableId: `portal:docs:${entity}`,
      title: page.label,
      columns: scalars.map((key) => ({ key, ...(WIDTH[key] ? { width: WIDTH[key] } : {}) })),
      filterFields: [{ key: "DocNum", exact: true }, { key: "DocDate" }, { key: "DocumentStatus" }],
      systemViews: [
        { key: "default", name: "Standard", isDefault: true, state: { sortBy: NEWEST } },
        { key: "open", name: "Open", state: { sortBy: NEWEST, filterValues: { DocumentStatus: ["bost_Open"] } } },
      ],
    },
    detail: {
      header: {
        titleField: "DocNum",
        subtitleFields: ["DocDate"],
        facets: [
          { field: "DocumentStatus", type: "status", statusMapping: DOCUMENT_STATUS },
          { field: "DocTotal", type: "numeric", unitField: "DocCurrency" },
        ],
      },
      sections: [
        { id: "general", label: "General", groups: [{ id: "document", label: "Document", fields: scalars.map((key) => ({ key })) }] },
        ...(lines.length ? [{ id: "lines", label: "Lines", table: { key: LINES, columns: lines.map((key) => ({ key })) } }] : []),
      ],
    },
  };
}
