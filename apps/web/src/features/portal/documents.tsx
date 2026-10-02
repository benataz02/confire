import { documentFeature } from "../b1/documents.tsx";
import type { EntityFeature, FormField, Section } from "../../shared/types.ts";

// The client's four document pages: the internal document feature, narrowed to what a client may
// see and stripped of the value helps and links that reach internal pages. Read-only.
//
// The narrowing is presentation. The boundary is the server's PORTAL_DOC/PORTAL_LINE allowlist and
// CardCode fence (orpc/routers/portal.ts): a field named here that the allowlist does not carry is
// simply absent from every row.

const PORTAL_DOC = new Set([
  "DocEntry", "DocNum", "DocDate", "DocDueDate", "DocumentStatus", "DocTotal", "DocCurrency", "NumAtCard", "Comments", "DocumentLines",
]);
const PORTAL_LINE = new Set(["LineNum", "ItemCode", "ItemDescription", "Quantity", "UnitPrice", "LineTotal"]);

const plain = (f: FormField): FormField => {
  const { cfl: _cfl, link: _link, onRowSelect: _sel, ...rest } = f;
  return rest;
};
const fields = (fs: FormField[] | undefined) => fs?.filter((f) => PORTAL_DOC.has(f.key)).map(plain);

const narrow = (s: Section): Section => ({
  ...s,
  ...(s.fields ? { fields: fields(s.fields) } : {}),
  ...(s.groups ? { groups: s.groups.map((g) => ({ ...g, fields: fields(g.fields)! })) } : {}),
  ...(s.table ? {
    table: {
      ...s.table,
      columns: s.table.columns
        .filter((c) => PORTAL_LINE.has(c.key))
        .map(({ cflConfig: _c, linkConfig: _l, onRowSelect: _s, ...c }) => c),
    },
  } : {}),
});

export function portalDocumentFeature(entity: string, o: { label: string; one: string }): EntityFeature {
  const f = documentFeature(entity, { ...o, icon: "document", scope: "portal" });
  return {
    ...f,
    list: {
      ...f.list,
      tableId: `portal:${entity}`,
      // The client IS the card: no CardCode/CardName column, filter or link.
      columns: f.list.columns.filter((c) => PORTAL_DOC.has(c.key)).map(({ linkConfig: _l, ...c }) => c),
      filterFields: (f.list.filterFields ?? []).filter((x) => PORTAL_DOC.has(x.key)),
    },
    detail: {
      ...f.detail,
      header: { ...f.detail.header, subtitleFields: ["DocDate"] },
      sections: f.detail.sections.map(narrow),
    },
  };
}

export const PORTAL_FEATURES: Record<string, EntityFeature> = Object.fromEntries(
  [
    portalDocumentFeature("Quotations", { label: "Quotations", one: "quotation" }),
    portalDocumentFeature("Orders", { label: "Sales orders", one: "sales order" }),
    portalDocumentFeature("DeliveryNotes", { label: "Deliveries", one: "delivery" }),
    portalDocumentFeature("Invoices", { label: "Invoices", one: "invoice" }),
  ].map((f) => [f.entity, f]),
);
