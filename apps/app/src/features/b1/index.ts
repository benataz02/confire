import { businessPartners } from "./business-partners.tsx";
import { documentFeature } from "./documents.tsx";
import { items } from "./items.tsx";
import type { EntityFeature } from "@confire/ui/types.ts";

// The declared set of B1 entities. This IS the B1 surface of the app: the /b1 routes accept only
// these, and the side nav and the shellbar search list them. Adding an entity (or a Beas one — the
// transport is the same) is one more feature here.

// Read at render, once the registry below exists: Copy to offers only the documents declared here.
const hasPage = (entity: string) => entity in B1_FEATURES;

export const B1_FEATURES: Record<string, EntityFeature> = Object.fromEntries(
  [
    documentFeature("Quotations", { label: "Sales quotations", one: "sales quotation", icon: "sales-quote", hasPage }),
    documentFeature("Orders", { label: "Sales orders", one: "sales order", icon: "sales-order", hasPage }),
    documentFeature("DeliveryNotes", { label: "Deliveries", one: "delivery", icon: "shipping-status", hasPage }),
    //documentFeature("Invoices", { label: "A/R invoices", one: "A/R invoice", icon: "monitor-payments", hasPage }),
    businessPartners,
    items,
  ].map((f) => [f.entity, f]),
);

export const b1Feature = (entity: string): EntityFeature | undefined => B1_FEATURES[entity];
