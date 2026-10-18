import { describe, expect, test } from "bun:test";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import {
  extraPickable, formProblems, leadKey, leadPayload, onboardingSchema, onboardingSeed,
} from "../src/portal/onboarding-form.ts";

// The new-client onboarding form (spec §5.3, §5.4): what a prospect fills in and the lead it becomes.
// Pure: no database, no agent.

const f = (name: string, kind: B1Field["kind"] = "string", extra: Partial<B1Field> = {}): B1Field =>
  ({ name, kind, edmType: kind === "number" ? "Edm.Int32" : "Edm.String", label: name, ...extra });

const bp: B1EntitySchema = {
  name: "BusinessPartners", label: "Business partners", keys: ["CardCode"], table: "OCRD", entityType: "BusinessPartner", entityClass: "standard",
  fields: [
    f("CardCode"), f("CardName", "string", { maxLength: 100 }), f("CardType", "enum"), f("FederalTaxID"), f("Phone1"), f("EmailAddress"),
    f("Website"), f("GroupCode", "number"), f("CreditLimit", "number"), f("SalesPersonCode", "number"), f("U_Branch"), f("U_CF_Key"),
    f("Industry", "enum", { options: [{ value: "1", label: "ind_Metal" }] }),
    { ...f("BPAddresses", "collection"), fields: ["AddressName", "Street", "ZipCode", "City", "Country", "State", "AddressType"].map((n) => f(n)) },
    { ...f("ContactEmployees", "collection"), fields: ["Name", "FirstName", "LastName", "Phone1", "E_Mail", "Position"].map((n) => f(n)) },
  ],
};

const names = (fs: B1Field[]) => fs.map((x) => x.name);
const countries = new Set(["DE", "AT"]);
const valid = {
  ShipToSame: true, CardName: "Neu GmbH", "BillTo.Street": "Hauptstr. 1", "BillTo.City": "Ulm", "BillTo.Country": "DE",
  "Contact.LastName": "Schmidt",
};

describe("extraPickable", () => {
  test("scalar header fields, minus the denylist and the code defaults", () => {
    const n = names(extraPickable(bp));
    expect(n).toEqual(["Website", "GroupCode", "U_Branch", "Industry"]);
  });
});

describe("onboardingSchema", () => {
  test("defaults, extras in setting order, bill-to, ShipToSame, ship-to, contact", () => {
    const s = onboardingSchema(bp, [{ key: "U_Branch", required: true }, { key: "Website", required: false }]);
    expect(names(s.fields)).toEqual([
      "CardName", "FederalTaxID", "Phone1", "EmailAddress", "U_Branch", "Website",
      "BillTo.Street", "BillTo.ZipCode", "BillTo.City", "BillTo.Country", "ShipToSame",
      "ShipTo.Street", "ShipTo.ZipCode", "ShipTo.City", "ShipTo.Country",
      "Contact.FirstName", "Contact.LastName", "Contact.Phone1", "Contact.E_Mail",
    ]);
    expect(s.extras).toEqual(["U_Branch", "Website"]);
    expect(s.required).toContain("U_Branch");
    expect(s.required).not.toContain("Website");
    expect(s.required).toContain("Contact.LastName");
  });

  test("a stored extra the picker no longer offers is dropped on read", () => {
    const s = onboardingSchema(bp, [{ key: "CreditLimit", required: true }, { key: "U_Gone", required: false }, { key: "CardName", required: true }]);
    expect(s.extras).toEqual([]);
    expect(names(s.fields).filter((n) => n === "CardName")).toHaveLength(1);
  });
});

describe("onboardingSeed", () => {
  test("the user as the contact; the last word is the last name", () => {
    expect(onboardingSeed({ name: "Anna Maria Schmidt", email: "a@neu.de" })).toEqual({
      ShipToSame: true, "Contact.E_Mail": "a@neu.de", "Contact.FirstName": "Anna Maria", "Contact.LastName": "Schmidt",
    });
    expect(onboardingSeed({ name: "Anna", email: "a@neu.de" })).toEqual({ ShipToSame: true, "Contact.E_Mail": "a@neu.de", "Contact.LastName": "Anna" });
  });
});

describe("formProblems", () => {
  const s = onboardingSchema(bp, [{ key: "Industry", required: false }, { key: "GroupCode", required: false }]);

  test("a complete form passes", () => {
    expect(formProblems(s, countries, valid)).toEqual([]);
  });

  test("a key outside the form is refused, not dropped", () => {
    expect(formProblems(s, countries, { ...valid, CreditLimit: 1e6 })).toEqual(["CreditLimit is not on this form"]);
    expect(formProblems(s, countries, { ...valid, CardCode: "C1" })).toHaveLength(1);
  });

  test("required fields; ship-to only when it is not the bill-to address", () => {
    const { CardName: _, ...noName } = valid;
    expect(formProblems(s, countries, noName)).toEqual(["CardName (CardName) is required"]);
    expect(formProblems(s, countries, { ...valid, ShipToSame: false })).toHaveLength(3);
    expect(formProblems(s, countries, { ...valid, ShipToSame: false, "ShipTo.Street": "Lager 2", "ShipTo.City": "Linz", "ShipTo.Country": "AT" })).toEqual([]);
  });

  test("types, enum members, countries and MaxLength", () => {
    expect(formProblems(s, countries, { ...valid, "BillTo.Country": "XX" })).toHaveLength(1);
    expect(formProblems(s, countries, { ...valid, Industry: "ind_Metal", GroupCode: 100 })).toEqual([]);
    expect(formProblems(s, countries, { ...valid, Industry: "1" })).toHaveLength(1);
    expect(formProblems(s, countries, { ...valid, GroupCode: 1.5 })).toHaveLength(1);
    expect(formProblems(s, countries, { ...valid, ShipToSame: "yes" })).toHaveLength(1);
    expect(formProblems(s, countries, { ...valid, CardName: "x".repeat(101) })).toEqual(["CardName (CardName) is longer than 100"]);
  });
});

describe("leadPayload", () => {
  const s = onboardingSchema(bp, [{ key: "Website", required: false }]);

  test("a lead with the series, both addresses and the contact; the email is the session's", () => {
    const body = leadPayload(s, { ...valid, Website: "neu.de", "Contact.FirstName": "Anna", "Contact.E_Mail": "forged@x.de" },
      { email: "anna@neu.de", series: 77 });
    expect(body).toEqual({
      CardName: "Neu GmbH", Website: "neu.de", CardType: "cLid", Series: 77,
      BPAddresses: [
        { Street: "Hauptstr. 1", City: "Ulm", Country: "DE", AddressName: "Bill to", AddressType: "bo_BillTo" },
        { Street: "Hauptstr. 1", City: "Ulm", Country: "DE", AddressName: "Ship to", AddressType: "bo_ShipTo" },
      ],
      ContactEmployees: [{ FirstName: "Anna", LastName: "Schmidt", Name: "Anna Schmidt", E_Mail: "anna@neu.de" }],
    });
    expect("CardCode" in body).toBe(false);
  });

  test("its own ship-to address; no series = B1's default", () => {
    const body = leadPayload(s, { ...valid, ShipToSame: false, "ShipTo.Street": "Lager 2", "ShipTo.City": "Linz", "ShipTo.Country": "AT" },
      { email: "anna@neu.de" });
    expect("Series" in body).toBe(false);
    expect((body.BPAddresses as unknown[])[1]).toEqual({ Street: "Lager 2", City: "Linz", Country: "AT", AddressName: "Ship to", AddressType: "bo_ShipTo" });
  });
});

test("leadKey is per invitation, 64 hex characters (U_CF_Key's length)", () => {
  expect(leadKey("t1", "i1")).toMatch(/^[0-9a-f]{64}$/);
  expect(leadKey("t1", "i1")).toBe(leadKey("t1", "i1"));
  expect(leadKey("t1", "i2")).not.toBe(leadKey("t1", "i1"));
});
