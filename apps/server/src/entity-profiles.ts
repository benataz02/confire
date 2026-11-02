// The curated set: the handful of B1 entities Confire lets a user change, and exactly which fields.
// Everything else B1 exposes stays read-only, enforced in the router (see orpc/routers/entities.ts).
//
// Hand-written on purpose. Inferring "which fields are safe to edit" from $metadata is a rules
// engine nobody asked for, and it would guess wrong on precisely the fields (posting dates,
// account codes, calculated totals) where guessing wrong costs money.
//
// Only the WRITE rule lives here. How a page looks — title, sections, columns — is the declared
// feature config in apps/app/src/features; entities.metadata hands this rule to the browser as
// `Editable`/`Required`, so the form and the allowlist read one rule and cannot drift.
// DeliveryNotes and Invoices are deliberately absent: they are read-only copy targets, and
// absence here is what makes them so.

import { ORPCError } from "@orpc/server";
import { t } from "./i18n/index.ts";

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
    editable: ["CardName", "Phone1", "Cellular", "EmailAddress", "Notes", "FreeText", "SalesPersonCode", "Currency", "LanguageCode"],
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

/** Entity sets only an admin reads row by row (b1-tools spec §5.1). Every SAP call is the agent's one
 *  service login, which sees everything, so SAP's own permissions never apply: this list is the
 *  only fence. One criterion — personal/HR data, or user and security setup. A schema stays
 *  readable (field names are not the data); `b1.find` leaves these out for a non-admin.
 *  Built against SAP's FP2608 entity list (b1-mcp-server's category map). */
export const ADMIN_ONLY_READS: ReadonlySet<string> = new Set([
  "EmployeesInfo", // employees' personal records: addresses, ID numbers, salary, bank details
  "EmployeeImages", // employees' photos
  "EmployeeTransfers", // a named employee's moves between branches and departments
  "ProjectManagementTimeSheet", // named people's working hours
  "Users", // SAP user accounts: who may sign in, superuser flags
  "UserPermissionTree", // what each user may do in SAP
  "UserGroups", // security groups and who is in them
  "QueryAuthGroups", // which users may run which saved queries
  "SingleUserConnections", // who is signed in to SAP, and from where
  "B1Sessions", // live SAP sessions
  "DataPrivacyProtection", // the personal-data protection setup and its access log
  "DataSensitiveStatus", // which fields are classed as personal data
]);

const isAdminRole = (role: string) => role === "admin" || role === "owner";

/** The read scope, for every staff row read (entities.rows/one/neighbor, b1.read). */
export function assertReadable(entity: string, role: string): void {
  if (ADMIN_ONLY_READS.has(entity) && !isAdminRole(role))
    throw new ORPCError("FORBIDDEN", { message: t("ENTITY_ADMIN_ONLY", entity) });
}

export const readableBy = (role: string) => (entity: string): boolean => isAdminRole(role) || !ADMIN_ONLY_READS.has(entity);

/** Documents Confire can ask SAP to render as a PDF. Same shape of rule as ENTITY_PROFILES: the
 *  list is the boundary, enforced in the routers, not by which page drew a button. An entry
 *  here also needs a matching layout code in the agent's `apiGateway.layouts`. */
export const PRINTABLE = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);
