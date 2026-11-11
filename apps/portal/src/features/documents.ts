import type { EntityConstraints } from "@confire/ui/metadata.ts";
import { DOCUMENT_STATUS } from "@confire/ui/documentStatus.ts";
import type { EntityFeature, ListColumn } from "@confire/ui/types.ts";
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

const WIDTH: Record<string, number> = { DocNum: 110, DocDate: 120, DocDueDate: 120, DocumentStatus: 120, DocTotal: 150 };
/** SAP's labels are the supplier's side of the document: to the client, DocNum is the supplier's
 *  reference ("Reference <supplier>", the key's {0}) and NumAtCard ("Customer Ref. No.") its own. */
const CLIENT_LABEL: Record<string, string> = { DocNum: "PORTAL_DOC_NUMBER", NumAtCard: "PORTAL_DOC_YOUR_REF" };
/** Drawn after the total (`unitField`), not a field of its own. */
const UNIT = "DocCurrency";
/** Newest first — DocEntry, not DocNum, which restarts per series. */
const NEWEST = [{ field: "DocEntry", direction: "desc" as const }];
const LINES = "DocumentLines";
/** Named on the row by docs.rows/one, not SAP fields: SAP can neither sort nor filter on them. */
const NAMED = { sortable: false, filterable: false } as const;

/** `supplier`: the tenant's name, in DocNum's label. */
export function docFeature(entity: DocEntity, c: EntityConstraints, t: TextFn, supplier = ""): EntityFeature {
  const page = DOC_PAGES[entity];
  const label = t(page.labelKey);
  const scalars = Object.entries(c.fields).filter(([k, m]) => k !== "DocEntry" && k !== UNIT && m.Type !== "collection").map(([k]) => k);
  const lines = Object.keys(c.fields[LINES]?.Fields ?? {});
  // A sales employee is a number in SAP: the page shows the name the server puts beside it.
  const shown = (key: string) => key === "SalesPersonCode"
    ? { key: "SalesPersonName", label: c.fields.SalesPersonCode?.Label ?? key }
    : { key, ...(CLIENT_LABEL[key] ? { label: t(CLIENT_LABEL[key], supplier).trim() } : {}) };
  const columns: ListColumn[] = scalars.map((key) => ({
    ...shown(key), ...(key === "SalesPersonCode" ? NAMED : {}), ...(WIDTH[key] ? { width: WIDTH[key] } : {}),
    ...(key === "DocTotal" ? { unitField: UNIT } : {}),
  }));
  // A quotation's project, when it is one of the company's own: after the number, a link to it.
  if (entity === "Quotations")
    columns.splice(1, 0, { key: "ConfigName", label: t("PORTAL_PROJECT"), ...NAMED, linkConfig: { route: "/projects", idField: "ConfigId" } });
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
      columns,
      filterFields: [{ ...shown("DocNum"), exact: true }, { key: "DocDate" }, { key: "DocumentStatus" }],
      systemViews: [
        { key: "default", name: t("PORTAL_VIEW_ALL"), isDefault: true, state: { sortBy: NEWEST } },
        { key: "open", name: t("PORTAL_VIEW_OPEN"), state: { sortBy: NEWEST, filterValues: { DocumentStatus: ["bost_Open"] } } },
      ],
    },
    detail: {
      header: {
        titleField: "DocNum",
        subtitleFields: ["DocDate"],
        facets: [
          { field: "DocumentStatus", type: "status", statusMapping },
          { field: "DocTotal", type: "numeric", unitField: UNIT },
        ],
      },
      sections: [
        { id: "general", label: t("PORTAL_GENERAL"), groups: [{ id: "document", label: t("PORTAL_DOCUMENT"), fields: scalars.map(shown) }] },
        ...(lines.length ? [{ id: "lines", label: t("PORTAL_LINES"), table: { key: LINES, columns: lines.map((key) => ({ key })) } }] : []),
      ],
    },
  };
}
