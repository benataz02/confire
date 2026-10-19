import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, entityMeta, portalCompany, portalCompanyDomain, portalInvitation } from "@confire/db";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import { devOutbox } from "../src/mail/mailer.ts";
import { notificationsSettled } from "../src/notify.ts";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { leadKey } from "../src/portal/onboarding-form.ts";
import { savePortalSettings } from "../src/portal/settings.ts";
import { call, makePortalSeat, makePortalUser, makeTenant, makeUser, portalHeaders, tenantHeaders } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// New-client onboarding (spec §5.1, §5.3, §5.4): an admin invites someone with no CardCode yet, the
// invitee fills the BP form on the portal, and its submit creates a B1 lead, its company and their seat.

const uid = () => crypto.randomUUID().slice(0, 8);
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const NO_QUERY = { select: [], filter: [], orderby: [] };

const f = (name: string, kind: B1Field["kind"] = "string"): B1Field => ({ name, kind, edmType: kind === "number" ? "Edm.Int32" : "Edm.String", label: name });
const BP_SCHEMA: B1EntitySchema = {
  name: "BusinessPartners", label: "Business partners", keys: ["CardCode"], table: "OCRD", entityType: "BusinessPartner", entityClass: "standard",
  fields: [
    f("CardCode"), f("CardName"), f("CardType", "enum"), f("FederalTaxID"), f("Phone1"), f("EmailAddress"), f("Website"),
    f("CreditLimit", "number"), f("U_Branch"),
    { ...f("BPAddresses", "collection"), fields: ["AddressName", "Street", "ZipCode", "City", "Country", "AddressType"].map((n) => f(n)) },
    { ...f("ContactEmployees", "collection"), fields: ["Name", "FirstName", "LastName", "Phone1", "E_Mail"].map((n) => f(n)) },
  ],
};

let agent: MockAgent;
beforeAll(() => {
  agent = startMockAgent({
    Countries: [{ Code: "AT", Name: "Austria" }, { Code: "DE", Name: "Germany" }],
    SeriesService_GetDocumentSeries: [
      { Series: 77, Name: "Leads", Locked: "tNO" },
      { Series: 78, Name: "Old leads", Locked: "tYES" },
    ],
    BusinessPartners: [],
  });
});
afterAll(() => agent.stop());

async function setup() {
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  await db.insert(entityMeta).values({ tenantId: t.tenantId, entityName: "BusinessPartners", json: BP_SCHEMA, fetchedAt: new Date() });
  const admin = await makeUser("admin", t.tenantId);
  const as = { context: { headers: tenantHeaders(t.slug, admin.cookie) } };
  return { ...t, admin, as };
}

/** A new-client invitation and its invitee, signed in on the portal. */
async function invited(registerDomain = false) {
  const s = await setup();
  const email = `n${uid()}@neu${uid()}.de`;
  const { id } = await call(router.portalInvitations.inviteNew, { email, registerDomain }, s.as);
  const invitee = await makePortalUser(email);
  const on = { context: { headers: portalHeaders(s.slug, invitee.cookie) } };
  return { ...s, id, email, invitee, on };
}

const FORM = { CardName: "Neu GmbH", "BillTo.Street": "Hauptstr. 1", "BillTo.City": "Ulm", "BillTo.Country": "DE" };

describe("portalInvitations.inviteNew", () => {
  test("a pending owner invitation with no company, listed without a CardCode, mailed as a new client", async () => {
    const { as, slug } = await setup();
    const email = `n${uid()}@neu.de`;
    const { id } = await call(router.portalInvitations.inviteNew, { email, registerDomain: true }, as);
    const [inv] = await db.select().from(portalInvitation).where(eq(portalInvitation.id, id));
    expect(inv).toMatchObject({ companyId: null, role: "owner", status: "pending", registerDomain: true });
    const page = await call(router.portalInvitations.rows, { query: { ...NO_QUERY, filter: [{ field: "email", op: "eq", value: email }] }, top: 10 }, as);
    expect(page.rows[0]).toMatchObject({ email, cardCode: null });
    let mail;
    for (let i = 0; i < 100 && !mail; i++) {
      mail = devOutbox.find((m) => m.to === email);
      if (!mail) await Bun.sleep(20);
    }
    expect(mail?.text).toContain("Set up your company");
    expect(mail?.text).toContain(`${slug}.portal.`);
  });

  test("refused for an address already in a company here, naming its CardCode, and for one already invited", async () => {
    const { tenantId, as } = await setup();
    const client = await makePortalUser(`c${uid()}@kunde.de`);
    const company = await makePortalSeat(tenantId, client.userId, "buyer");
    const taken = call(router.portalInvitations.inviteNew, { email: client.email.toUpperCase(), registerDomain: false }, as);
    expect(await messageOf(taken)).toContain(company.cardCode);
    const email = `n${uid()}@neu.de`;
    await call(router.portalInvitations.inviteNew, { email, registerDomain: false }, as);
    expect(await codeOf(call(router.portalInvitations.inviteNew, { email, registerDomain: false }, as))).toBe("CONFLICT");
  });

  test("refused for the supplier's staff; admins only", async () => {
    const { tenantId, slug, as } = await setup();
    const staff = await makeUser("member", tenantId);
    expect(await codeOf(call(router.portalInvitations.inviteNew, { email: staff.email, registerDomain: false }, as))).toBe("FORBIDDEN");
    expect(await codeOf(call(router.portalInvitations.inviteNew, { email: `x${uid()}@neu.de`, registerDomain: false },
      { context: { headers: tenantHeaders(slug, staff.cookie) } }))).toBe("FORBIDDEN");
  });
});

describe("onboarding.formSchema", () => {
  test("the form as constraints: defaults, extras, addresses with country options, contact; the user as seed", async () => {
    const { tenantId, id, on, email } = await invited();
    // A stale setting naming a denied field is dropped on read.
    await savePortalSettings(tenantId, { onboarding: { extraFields: [{ key: "U_Branch", required: true }, { key: "CreditLimit", required: true }] } });
    const s = await call(portalRouter.onboarding.formSchema, { id }, on);
    expect(s.extras).toEqual(["U_Branch"]);
    expect(Object.keys(s.fields)).toContain("BillTo.Street");
    expect(s.fields.CreditLimit).toBeUndefined();
    expect(s.fields.U_Branch).toMatchObject({ Editable: true, Required: true });
    expect(s.fields["BillTo.Country"]!.Options).toEqual([{ value: "AT", label: "Austria" }, { value: "DE", label: "Germany" }]);
    expect(s.fields.ShipToSame!.Type).toBe("boolean");
    expect(s.seed).toMatchObject({ ShipToSame: true, "Contact.E_Mail": email });
  });

  test("only for its invitee, only a new-client invitation, only without a seat", async () => {
    const { tenantId, slug, id, on, invitee } = await invited();
    const other = await makePortalUser(`o${uid()}@neu.de`);
    expect(await codeOf(call(portalRouter.onboarding.formSchema, { id }, { context: { headers: portalHeaders(slug, other.cookie) } }))).toBe("FORBIDDEN");
    await makePortalSeat(tenantId, invitee.userId, "viewer");
    expect(await codeOf(call(portalRouter.onboarding.formSchema, { id }, on))).toBe("CONFLICT");
  });

  test("an existing-BP invitation is accepted, not filled in", async () => {
    const { slug, as } = await setup();
    const cardCode = `C${uid()}`;
    agent.store.BusinessPartners!.push({ CardCode: cardCode, CardName: "Kunde AG", CardType: "cCustomer" });
    const email = `e${uid()}@kunde.de`;
    const { id } = await call(router.portalInvitations.inviteExisting, { cardCode, email, role: "buyer", registerDomain: false }, as);
    const u = await makePortalUser(email);
    expect(await codeOf(call(portalRouter.onboarding.formSchema, { id }, { context: { headers: portalHeaders(slug, u.cookie) } }))).toBe("BAD_REQUEST");
  });
});

describe("onboarding.submit", () => {
  test("creates the lead in B1, then its company, the seat as owner, the invitation accepted and the domain", async () => {
    const { tenantId, id, email, on, as, admin } = await invited(true);
    await call(router.portalSettings.save, { extraFields: [{ key: "Website", required: false }], leadSeries: 77 }, as);
    const before = agent.calls.length;
    const res = await call(portalRouter.onboarding.submit, {
      id, form: { ...FORM, Website: "neu.de", ShipToSame: false, "ShipTo.Street": "Lager 2", "ShipTo.City": "Linz", "ShipTo.Country": "AT", "Contact.FirstName": "Anna" },
    }, on);
    const post = agent.calls.slice(before).find((c) => c.route === "/create" && c.body.entitySet === "BusinessPartners")!;
    const body = post.body.data as Record<string, unknown>;
    expect(body).toMatchObject({ CardName: "Neu GmbH", Website: "neu.de", CardType: "cLid", Series: 77, U_CF_Key: leadKey(tenantId, id) });
    expect("CardCode" in body).toBe(false);
    expect(body.BPAddresses).toEqual([
      { Street: "Hauptstr. 1", City: "Ulm", Country: "DE", AddressName: "Bill to", AddressType: "bo_BillTo" },
      { Street: "Lager 2", City: "Linz", Country: "AT", AddressName: "Ship to", AddressType: "bo_ShipTo" },
    ]);
    // The session's verified address, never the form's; the last name from the seed.
    expect(body.ContactEmployees).toEqual([{ FirstName: "Anna", LastName: email, E_Mail: email, Name: `Anna ${email}` }]);

    const [company] = await db.select().from(portalCompany).where(and(eq(portalCompany.tenantId, tenantId), eq(portalCompany.cardCode, res.cardCode)));
    expect(company).toMatchObject({ cardName: "Neu GmbH", cardType: "cLid" });
    const [inv] = await db.select().from(portalInvitation).where(eq(portalInvitation.id, id));
    expect(inv).toMatchObject({ status: "accepted", companyId: company!.id });
    const me = await call(portalRouter.me, undefined, on);
    expect(me.company).toMatchObject({ cardCode: res.cardCode, role: "owner", cardType: "cLid" });
    const domains = await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.companyId, company!.id));
    expect(domains.map((d) => d.domain)).toEqual([email.split("@")[1]!]);
    // Used up: a second submit of the same link is refused before SAP.
    expect(await codeOf(call(portalRouter.onboarding.submit, { id, form: FORM }, on))).toBe("CONFLICT");
    // The inviter hears of it (§5.4 step 6), and a reply reaches the new client.
    await notificationsSettled();
    const told = devOutbox.filter((m) => m.to === admin.email && m.subject.includes("joined your customer portal"));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ replyTo: email, subject: `Neu GmbH joined your customer portal (${res.cardCode})` });
  });

  test("no series set: B1's default lead series; the seed ships to the bill-to address", async () => {
    const { id, on } = await invited();
    const before = agent.calls.length;
    await call(portalRouter.onboarding.submit, { id, form: FORM }, on);
    const body = agent.calls.slice(before).find((c) => c.route === "/create" && c.body.entitySet === "BusinessPartners")!.body.data as Record<string, unknown>;
    expect("Series" in body).toBe(false);
    expect((body.BPAddresses as Record<string, unknown>[])[1]).toMatchObject({ Street: "Hauptstr. 1", AddressType: "bo_ShipTo" });
  });

  test("a lead B1 already holds for this invitation is bound, not posted again (the lost-response retry)", async () => {
    const { tenantId, id, on } = await invited();
    agent.store.BusinessPartners!.push({ CardCode: `L${uid()}`, CardName: "Neu GmbH", CardType: "cLid", U_CF_Key: leadKey(tenantId, id) });
    const before = agent.calls.length;
    const res = await call(portalRouter.onboarding.submit, { id, form: FORM }, on);
    expect(res.cardCode).toBe(agent.store.BusinessPartners!.at(-1)!.CardCode as string);
    expect(agent.calls.slice(before).some((c) => c.route === "/create" && c.body.entitySet === "BusinessPartners")).toBe(false);
  });

  test("refused before any create: a key outside the form, a missing required field, a bad country", async () => {
    const { id, on } = await invited();
    const before = agent.calls.length;
    for (const form of [{ ...FORM, CreditLimit: 1e6 }, { ...FORM, CardName: "" }, { ...FORM, "BillTo.Country": "XX" }])
      expect(await codeOf(call(portalRouter.onboarding.submit, { id, form }, on))).toBe("BAD_REQUEST");
    expect(agent.calls.slice(before).some((c) => c.route === "/create")).toBe(false);
  });

  test("U_CF_Key missing on OCRD: refuses to run rather than risk a second lead", async () => {
    const { id, on } = await invited();
    agent.missingUdf.add("BusinessPartners");
    try {
      const before = agent.calls.length;
      expect(await messageOf(call(portalRouter.onboarding.submit, { id, form: FORM }, on))).toContain("U_CF_Key is missing from Business Partners");
      expect(agent.calls.slice(before).some((c) => c.route === "/create")).toBe(false);
    } finally {
      agent.missingUdf.delete("BusinessPartners");
    }
  });
});

describe("portalSettings: onboarding", () => {
  test("extras offered minus the denylist and defaults; a denied extra is refused; the lead series", async () => {
    const { tenantId, as } = await setup();
    // The tab reads the four document schemas as well.
    for (const name of ["Quotations", "Orders", "DeliveryNotes", "Invoices"])
      await db.insert(entityMeta).values({ tenantId, entityName: name, json: { ...BP_SCHEMA, name, fields: [] }, fetchedAt: new Date() });
    await savePortalSettings(tenantId, { onboarding: { extraFields: [{ key: "SalesPersonCode", required: true }, { key: "U_Branch", required: false }] } });
    const got = await call(router.portalSettings.get, undefined, as);
    expect(got.extraOptions.map((o) => o.key)).toEqual(["Website", "U_Branch"]);
    expect(got.extraFields).toEqual([{ key: "U_Branch", required: false }]);
    expect(got.leadSeries).toBeNull();
    expect(await codeOf(call(router.portalSettings.save, { extraFields: [{ key: "CreditLimit", required: false }] }, as))).toBe("BAD_REQUEST");
    expect(await codeOf(call(router.portalSettings.save, { extraFields: [{ key: "CardName", required: false }] }, as))).toBe("BAD_REQUEST");
    expect(await codeOf(call(router.portalSettings.save, { extraFields: [{ key: "Website", required: false }, { key: "Website", required: true }] }, as))).toBe("BAD_REQUEST");
    expect(await codeOf(call(router.portalSettings.save, { extraFields: [{ key: "Website", required: true }], leadSeries: 77 }, as))).toBe("OK");
    expect((await call(router.portalSettings.get, undefined, as)).leadSeries).toBe(77);
    await call(router.portalSettings.save, { leadSeries: null }, as);
    const after = await call(router.portalSettings.get, undefined, as);
    expect(after.leadSeries).toBeNull();
    expect(after.extraFields).toEqual([{ key: "Website", required: true }]);
    // Locked series are not offered.
    expect(await call(router.portalSettings.leadSeries, undefined, as)).toEqual([{ series: 77, name: "Leads" }]);
  });
});
