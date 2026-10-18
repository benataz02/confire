import type { FormField, HeaderConfig, Section } from "@confire/ui/types.ts";

// The new-client onboarding form (spec §5.3), declared like apps/web's features/b1/business-partners:
// a section tree the BP-create ObjectPage draws unchanged. Metadata (`onboarding.formSchema`) only
// says what each field is — label, required, the country options. Addresses and the contact are flat
// prefixed keys on purpose, so ObjectPage validates and sends them like any field; the server folds
// them back into BPAddresses and ContactEmployees.

const fields = (keys: string[]): FormField[] => keys.map((key) => ({ key }));
const address = (prefix: string) => fields(["Street", "ZipCode", "City", "Country"].map((k) => `${prefix}.${k}`));

export const ONBOARDING_HEADER: HeaderConfig = { titleField: "CardName", createTitle: "Your company" };

/** Never typed, never sent: the contact's email is the signed-in user's verified address. */
export const ONBOARDING_LOCKED = ["Contact.E_Mail"];

/** The Company section is the code defaults, then the admin's extras in settings order. */
export const onboardingSections = (extras: string[]): Section[] => [
  { id: "company", label: "Company", fields: fields(["CardName", "FederalTaxID", "Phone1", "EmailAddress", ...extras]) },
  { id: "billTo", label: "Bill-to address", fields: [...address("BillTo"), { key: "ShipToSame" }] },
  // Hidden while shipping to the bill-to address — and a hidden section is not validated.
  { id: "shipTo", label: "Ship-to address", visible: (d) => !d.ShipToSame, fields: address("ShipTo") },
  { id: "contact", label: "Contact person", fields: fields(["Contact.FirstName", "Contact.LastName", "Contact.Phone1", "Contact.E_Mail"]) },
];
