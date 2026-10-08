// The curated set: the handful of B1 entities Confire lets a user change, and exactly which fields.
// Everything else B1 exposes stays read-only, enforced in the router (see orpc/routers/entities.ts).
//
// Hand-written on purpose. Inferring "which fields are safe to edit" from $metadata is a rules
// engine nobody asked for, and it would guess wrong on precisely the fields (posting dates,
// account codes, calculated totals) where guessing wrong costs money.
//
// Only the WRITE rule lives here. How a page looks — title, sections, columns — is the declared
// feature config in apps/web/src/features; entities.metadata hands this rule to the browser as
// `Editable`/`Required`, so the form and the allowlist read one rule and cannot drift.
// DeliveryNotes and Invoices are deliberately absent: they are read-only copy targets, and
// absence here is what makes them so.

export type EntityProfile = {
  /** header fields a user may change. NOT a display list — this is the write allowlist. */
  editable: string[];
  /** must be present in a create payload */
  requiredOnCreate: string[];
  /** collections whose lines may be edited/added */
  editableCollections: string[];
};

export const ENTITY_PROFILES: Record<string, EntityProfile> = {
  Quotations: {
    editable: ["CardCode", "DocDate", "DocDueDate", "Comments", "SalesPersonCode", "DocCurrency", "NumAtCard"],
    requiredOnCreate: ["CardCode", "DocumentLines"],
    editableCollections: ["DocumentLines"],
  },
  Orders: {
    editable: ["CardCode", "DocDate", "DocDueDate", "Comments", "SalesPersonCode", "DocCurrency", "NumAtCard"],
    requiredOnCreate: ["CardCode", "DocumentLines"],
    editableCollections: ["DocumentLines"],
  },
  BusinessPartners: {
    editable: ["CardName", "Phone1", "Cellular", "EmailAddress", "Notes", "FreeText", "SalesPersonCode", "Currency"],
    requiredOnCreate: ["CardCode", "CardName", "CardType"],
    editableCollections: [],
  },
  Items: {
    editable: ["ItemName", "ForeignName", "BarCode", "User_Text", "SalesUnit", "InventoryUOM", "PurchaseUnit"],
    requiredOnCreate: ["ItemCode", "ItemName"],
    editableCollections: [],
  },
};

export const profileOf = (entity: string): EntityProfile | undefined => ENTITY_PROFILES[entity];

/** Keep only fields the profile allows, plus U_ UDFs (a tenant's own columns are theirs to set).
 *  Returns the filtered payload and what it dropped, so the caller can refuse rather than
 *  silently write less than the user asked for. */
export function pickEditable(
  profile: EntityProfile,
  data: Record<string, unknown>,
  opts: { create: boolean },
): { payload: Record<string, unknown>; rejected: string[] } {
  const allowed = new Set([...profile.editable, ...profile.editableCollections]);
  if (opts.create) for (const f of profile.requiredOnCreate) allowed.add(f);

  const payload: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (allowed.has(k) || k.startsWith("U_")) payload[k] = v;
    else rejected.push(k);
  }
  return { payload, rejected };
}

export function missingRequired(profile: EntityProfile, data: Record<string, unknown>): string[] {
  return profile.requiredOnCreate.filter((f) => {
    const v = data[f];
    return v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  });
}

/** Documents Confire can ask SAP to render as a PDF. Same shape of rule as ENTITY_PROFILES: the
 *  list is the boundary, enforced in the routers, not by which page drew a button. An entry
 *  here also needs a matching layout code in the agent's `apiGateway.layouts`. */
export const PRINTABLE = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);
