import { createHash } from "node:crypto";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import type { PortalExtraField } from "@confire/db";

// The new-client onboarding form (spec §5.3, §5.4): which BusinessPartners fields a prospect fills
// in, and how that form becomes a B1 lead. One rule for the settings picker, the form the portal
// draws (`onboarding.formSchema`) and the submit that validates it, so the three cannot disagree.
// Pure: both processes import it.
//
// Addresses and the contact are flat prefixed keys (`BillTo.Street`, `Contact.LastName`) on purpose:
// ObjectPage validates and sends only fields its section tree declares, so declaring them as ordinary
// fields keeps required, MaxLength and save validation as they are. leadPayload folds them back into
// BPAddresses and ContactEmployees.

/** No setting can put these on the form: the server's own (CardCode, CardType, Series, the dedup
 *  key) and the commercial terms a supplier sets, never its prospect. */
export const ONBOARDING_DENYLIST = new Set([
  "CardCode", "CardType", "Series", "U_CF_Key", "CreditLimit", "MaxCommitment", "PriceListNum", "DiscountPercent",
  "PayTermsGrpCode", "SalesPersonCode",
]);

/** The Company section's code defaults, always first. The admin's extras follow in settings order. */
export const COMPANY_DEFAULTS = ["CardName", "FederalTaxID", "Phone1", "EmailAddress"];
const ADDRESS = ["Street", "ZipCode", "City", "Country"];
const CONTACT = ["FirstName", "LastName", "Phone1", "E_Mail"];
export const SHIP_TO_SAME = "ShipToSame";
/** Required by code. A hidden Ship-to (ShipToSame) is not validated, on the page or here. */
const REQUIRED = ["CardName", "BillTo.Street", "BillTo.City", "BillTo.Country", "ShipTo.Street", "ShipTo.City", "ShipTo.Country", "Contact.LastName"];
export const COUNTRY_FIELDS = ["BillTo.Country", "ShipTo.Country"];

const scalar = (f: B1Field) => f.kind !== "collection";

/** What the settings picker offers as extras: scalar header fields, minus the denylist and the code
 *  defaults (already on the form). */
export const extraPickable = (schema: B1EntitySchema): B1Field[] =>
  schema.fields.filter((f) => scalar(f) && !ONBOARDING_DENYLIST.has(f.name) && !COMPANY_DEFAULTS.includes(f.name));

export type OnboardingSchema = {
  /** the form's fields under their form keys, in form order */
  fields: B1Field[];
  required: string[];
  /** the extras that made it onto the form, in settings order — the Company section draws them */
  extras: string[];
};

/** The form for this tenant's BP schema and extras setting. Applied on every read, not only on save:
 *  a stored extra the picker no longer offers (a UDF since removed, a field since denied) is dropped. */
export function onboardingSchema(schema: B1EntitySchema, extraFields: PortalExtraField[] | undefined): OnboardingSchema {
  const byName = new Map(schema.fields.map((f) => [f.name, f]));
  const offered = new Set(extraPickable(schema).map((f) => f.name));
  const extras = (extraFields ?? []).filter((x, i, all) => offered.has(x.key) && all.findIndex((y) => y.key === x.key) === i);
  const sub = (coll: string, names: string[], prefix: string): B1Field[] => {
    const own = new Map((byName.get(coll)?.fields ?? []).map((f) => [f.name, f]));
    return names.flatMap((n) => (own.has(n) ? [{ ...own.get(n)!, name: `${prefix}.${n}` }] : []));
  };
  const fields: B1Field[] = [
    ...COMPANY_DEFAULTS.flatMap((n) => (byName.has(n) ? [byName.get(n)!] : [])),
    ...extras.map((x) => byName.get(x.key)!),
    ...sub("BPAddresses", ADDRESS, "BillTo"),
    { name: SHIP_TO_SAME, kind: "boolean", edmType: "Edm.Boolean", label: "Ship to the bill-to address" },
    ...sub("BPAddresses", ADDRESS, "ShipTo"),
    ...sub("ContactEmployees", CONTACT, "Contact"),
  ];
  return {
    fields,
    required: [...REQUIRED, ...extras.filter((x) => x.required).map((x) => x.key)].filter((k) => fields.some((f) => f.name === k)),
    extras: extras.map((x) => x.key),
  };
}

/** What the page starts with: the user as the contact, shipping to the bill-to address. The page
 *  sends only what differs from it (ObjectPage's diff), so submit lays the form over this same seed. */
export function onboardingSeed(user: { name: string; email: string }): Record<string, unknown> {
  const words = user.name.trim().split(/\s+/).filter(Boolean);
  return {
    [SHIP_TO_SAME]: true,
    "Contact.E_Mail": user.email,
    ...(words.length > 1 ? { "Contact.FirstName": words.slice(0, -1).join(" ") } : {}),
    ...(words.length ? { "Contact.LastName": words.at(-1) } : {}),
  };
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "";
const INTEGER = /^Edm\.(Int\d+|S?Byte)$/;

/** Everything wrong with a submitted form, as messages naming the field; empty = valid. A key the
 *  form does not have is refused rather than dropped — the page never sends one. */
export function formProblems(s: OnboardingSchema, countries: Set<string>, form: Record<string, unknown>): string[] {
  const byName = new Map(s.fields.map((f) => [f.name, f]));
  const required = new Set(s.required);
  const problems = Object.keys(form).filter((k) => !byName.has(k)).map((k) => `${k} is not on this form`);
  const shipToSame = form[SHIP_TO_SAME] !== false;
  for (const f of s.fields) {
    if (shipToSame && f.name.startsWith("ShipTo.")) continue;
    const v = form[f.name];
    const label = f.label ?? f.name;
    if (isEmpty(v)) {
      if (required.has(f.name)) problems.push(`${label} (${f.name}) is required`);
      continue;
    }
    const ok =
      COUNTRY_FIELDS.includes(f.name) ? typeof v === "string" && countries.has(v)
      : f.kind === "boolean" ? typeof v === "boolean"
      : f.kind === "number" ? typeof v === "number" && Number.isFinite(v) && (!INTEGER.test(f.edmType) || Number.isInteger(v))
      // B1 sends and accepts an enum's member NAME, which is what the page's select carries.
      : f.kind === "enum" ? (f.options ?? []).some((o) => o.label === v)
      : typeof v === "string";
    if (!ok) problems.push(`${label} (${f.name}) has an invalid value`);
    else if (typeof v === "string" && f.maxLength && v.length > f.maxLength) problems.push(`${label} (${f.name}) is longer than ${f.maxLength}`);
  }
  return problems;
}

/** The dedup key on OCRD's U_CF_Key: the invitation, not the form, so a retry with corrected data
 *  binds to the lead B1 already created rather than posting a second one. */
export const leadKey = (tenantId: string, invitationId: string) =>
  createHash("sha256").update(`${tenantId}|${invitationId}`).digest("hex");

// ponytail: unverified (spec §16) — that B1 needs AddressName + AddressType per BPAddresses row and
// Name per ContactEmployees row, and accepts both inline in the same POST. Fixed names, English: a
// lead has one address of each type, and staff rename them in B1 if they care.
const BILL_TO = "Bill to";
const SHIP_TO = "Ship to";
/** OCPR.Name, the contact's key on its BP. */
const CONTACT_NAME_MAX = 50;

/**
 * The BusinessPartners create body for a validated form (seed included). The contact's email is the
 * session's verified address, never the form's. CardType, Series and no CardCode are the server's:
 * B1 numbers the lead from the series (D16), or from its default lead series when none is set.
 * The dedup key is added by the caller, which owns the UDF's name.
 */
export function leadPayload(s: OnboardingSchema, form: Record<string, unknown>, o: { email: string; series?: number }): Record<string, unknown> {
  const pick = (prefix: string) => Object.fromEntries(s.fields
    .filter((f) => f.name.startsWith(`${prefix}.`) && !isEmpty(form[f.name]))
    .map((f) => [f.name.slice(prefix.length + 1), form[f.name]]));
  const header = Object.fromEntries(s.fields
    .filter((f) => !f.name.includes(".") && f.name !== SHIP_TO_SAME && !isEmpty(form[f.name]))
    .map((f) => [f.name, form[f.name]]));
  const billTo = pick("BillTo");
  const shipTo = form[SHIP_TO_SAME] === false ? pick("ShipTo") : billTo;
  const contact = pick("Contact");
  const name = [contact.FirstName, contact.LastName].filter((x) => !isEmpty(x)).join(" ").slice(0, CONTACT_NAME_MAX);
  return {
    ...header,
    CardType: "cLid",
    ...(o.series === undefined ? {} : { Series: o.series }),
    BPAddresses: [
      { ...billTo, AddressName: BILL_TO, AddressType: "bo_BillTo" },
      { ...shipTo, AddressName: SHIP_TO, AddressType: "bo_ShipTo" },
    ],
    ContactEmployees: [{ ...contact, Name: name, E_Mail: o.email }],
  };
}
