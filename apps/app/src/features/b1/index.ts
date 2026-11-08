import { businessPartners } from "./business-partners.tsx";
import { documentFeature } from "./documents.tsx";
import { items } from "./items.tsx";
import type { EntityFeature } from "@confire/ui/types.ts";

// The declared set of B1 entities. This IS the B1 surface of the app: the /b1 routes accept only
// these, and the side nav and the shellbar search list them. Adding an entity (or a Beas one — the
// transport is the same) is one more feature here. Every copy target (doc-copy.ts' DOCUMENT_FLOWS)
// and every document a project's timeline links is one of these documents, so Copy to and Open never
// lead to a page that is not here.

// Problems stay on the fields. The title's messages button is for pages whose problems are not a
// field (the model builder, the configurator).
const DOCUMENTS = [
  documentFeature("Quotations", { label: "Sales quotations", one: "sales quotation", icon: "sales-quote" }),
  documentFeature("Orders", { label: "Sales orders", one: "sales order", icon: "sales-order" }),
  documentFeature("DeliveryNotes", { label: "Deliveries", one: "delivery", icon: "shipping-status" }),
  documentFeature("Invoices", { label: "A/R invoices", one: "A/R invoice", icon: "monitor-payments" }),
];
/** The marketing documents (a DocumentStatus to be open), as opposed to master data. */
export const B1_DOCUMENTS = new Set(DOCUMENTS.map((f) => f.entity));

export const B1_FEATURES: Record<string, EntityFeature> = Object.fromEntries(
  [
    ...DOCUMENTS,
    businessPartners,
    items,
  ].map((f) => [f.entity, { ...f, detail: { ...f.detail, noMessages: true } }]),
);

export const b1Feature = (entity: string): EntityFeature | undefined => B1_FEATURES[entity];
