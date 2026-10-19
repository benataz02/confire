import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, EXTERNAL_ROLE, member, portalCompany, invitation } from "@confire/db";
import { auth } from "../src/auth.ts";
import { devOutbox } from "../src/mail/mailer.ts";
import { router } from "../src/orpc/router.ts";
import { authUrl, portalTenantUrl } from "../src/tenant.ts";
import { call, insertSeat, makePortalSeat, makePortalUser, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The internal app's side of the portal (spec §5.1, §10, §11): an admin invites a business partner's
// people from its Object Page, sees and edits who is on the portal, and lists every invitation.

const uid = () => crypto.randomUUID().slice(0, 8);
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
const ctx = (slug: string, cookie: string) => ({ context: { headers: tenantHeaders(slug, cookie) } });
const NO_QUERY = { select: [], filter: [], orderby: [] };

let agent: MockAgent;
beforeAll(() => {
  agent = startMockAgent({
    BusinessPartners: [
      { CardCode: "C1", CardName: "Kunde AG", CardType: "cCustomer" },
      { CardCode: "L1", CardName: "Lead GmbH", CardType: "cLid" },
      { CardCode: "S1", CardName: "Lieferant KG", CardType: "cSupplier" },
    ],
  });
});
afterAll(() => agent.stop());

/** A tenant on the mock agent with an admin who can invite. */
async function setup() {
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  const admin = await makeUser("admin", t.tenantId);
  return { ...t, admin, as: ctx(t.slug, admin.cookie) };
}

describe("portalInvitations.inviteExisting", () => {
  test("re-reads the BP from SAP, creates its company and a pending invitation, and mails the link", async () => {
    const { tenantId, slug, as } = await setup();
    const email = `k${uid()}@kunde.de`;
    const { id } = await call(router.portalInvitations.inviteExisting, { cardCode: "C1", email, role: "owner", registerDomain: true }, as);
    expect(agent.calls.some((c) => c.route === "/entity" && c.body.entitySet === "BusinessPartners" && c.body.key === "C1")).toBe(true);
    const [company] = await db.select().from(portalCompany).where(eq(portalCompany.tenantId, tenantId));
    expect(company).toMatchObject({ cardCode: "C1", cardName: "Kunde AG", cardType: "cCustomer" });
    const [inv] = await db.select().from(invitation).where(eq(invitation.id, id));
    expect(inv).toMatchObject({ cardCode: company!.cardCode, email, role: EXTERNAL_ROLE, portalRole: "owner", status: "pending", registerDomain: true });
    let mail;
    for (let i = 0; i < 100 && !mail; i++) {
      mail = devOutbox.find((m) => m.to === email);
      if (!mail) await Bun.sleep(20);
    }
    expect(mail?.text).toContain(portalTenantUrl(slug, `/accept/${id}`));
  });

  test("leads qualify, suppliers do not, and an unknown CardCode is NOT_FOUND", async () => {
    const { as } = await setup();
    const invite = (cardCode: string) =>
      call(router.portalInvitations.inviteExisting, { cardCode, email: `x${uid()}@kunde.de`, role: "buyer", registerDomain: false }, as);
    expect(await codeOf(invite("L1"))).toBe("OK");
    expect(await codeOf(invite("S1"))).toBe("BAD_REQUEST");
    expect(await codeOf(invite("NOPE"))).toBe("NOT_FOUND");
  });

  test("admins only", async () => {
    const { tenantId, slug } = await setup();
    const plain = await makeUser("member", tenantId);
    expect(await codeOf(call(router.portalInvitations.inviteExisting,
      { cardCode: "C1", email: `x${uid()}@kunde.de`, role: "buyer", registerDomain: false }, ctx(slug, plain.cookie)))).toBe("FORBIDDEN");
  });
});

describe("portalInvitations.rows / cancel", () => {
  test("an expired pending invitation reads as `expired` and filters as one; cancel skips settled rows", async () => {
    const { tenantId, as } = await setup();
    const live = await call(router.portalInvitations.inviteExisting, { cardCode: "C1", email: `l${uid()}@kunde.de`, role: "buyer", registerDomain: false }, as);
    const old = await call(router.portalInvitations.inviteExisting, { cardCode: "C1", email: `o${uid()}@kunde.de`, role: "buyer", registerDomain: false }, as);
    await db.update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, old.id));

    const all = await call(router.portalInvitations.rows, { query: NO_QUERY, top: 100 }, as);
    expect(all.total).toBe(2);
    expect(all.rows.find((r) => r.id === old.id)).toMatchObject({ state: "expired", cardCode: "C1", cardName: "Kunde AG" });
    expect(all.rows.find((r) => r.id === live.id)).toMatchObject({ state: "pending" });
    expect(all.rows[0]!.inviter).toBeTruthy();

    const expired = await call(router.portalInvitations.rows,
      { query: { ...NO_QUERY, filter: [{ field: "state", op: "eq", value: "expired" }] }, top: 100 }, as);
    expect(expired.rows.map((r) => r.id)).toEqual([old.id]);

    await db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, old.id));
    expect(await call(router.portalInvitations.cancel, { ids: [live.id, old.id] }, as)).toEqual({ canceled: 1 });
    // Another tenant's admin sees none of it.
    const other = await setup();
    expect((await call(router.portalInvitations.rows, { query: NO_QUERY, top: 100 }, other.as)).total).toBe(0);
    void tenantId;
  });
});

describe("portalCompanies", () => {
  test("get: members, pending invitations and domains of this tenant's company for a CardCode", async () => {
    const { tenantId, as } = await setup();
    expect((await call(router.portalCompanies.get, { cardCode: "C1" }, as)).company).toBeNull();
    const email = `g${uid()}@kunde.de`;
    await call(router.portalInvitations.inviteExisting, { cardCode: "C1", email, role: "buyer", registerDomain: false }, as);
    const [company] = await db.select().from(portalCompany).where(eq(portalCompany.tenantId, tenantId));
    const u = await makePortalUser();
    await insertSeat(tenantId, company!.cardCode, u.userId, "owner");
    await call(router.portalCompanies.addDomain, { cardCode: "C1", domain: "Kunde-AG.de" }, as);

    const got = await call(router.portalCompanies.get, { cardCode: "C1" }, as);
    expect(got.company).toMatchObject({ cardName: "Kunde AG", cardType: "cCustomer" });
    expect(got.members).toEqual([expect.objectContaining({ userId: u.userId, email: u.email, role: "owner" })]);
    expect(got.invitations).toEqual([expect.objectContaining({ email, role: "buyer", expired: false })]);
    expect(got.domains.map((d) => d.domain)).toEqual(["kunde-ag.de"]);

    // The same CardCode on another tenant is another company: nothing of this one shows there.
    const other = await setup();
    expect((await call(router.portalCompanies.get, { cardCode: "C1" }, other.as)).company).toBeNull();
  });

  test("domains: free mail refused, no company is NOT_FOUND, a taken one names its CardCode, remove frees it", async () => {
    const { tenantId, as } = await setup();
    const a = await makePortalSeat(tenantId, (await makePortalUser()).userId, "owner", "A");
    const b = await makePortalSeat(tenantId, (await makePortalUser()).userId, "owner", "B");
    const domain = `${uid()}.de`;
    expect(await codeOf(call(router.portalCompanies.addDomain, { cardCode: a.cardCode, domain: "gmail.com" }, as))).toBe("BAD_REQUEST");
    expect(await codeOf(call(router.portalCompanies.addDomain, { cardCode: "NOPE", domain }, as))).toBe("NOT_FOUND");
    expect(await codeOf(call(router.portalCompanies.addDomain, { cardCode: a.cardCode, domain: "not a domain" }, as))).toBe("BAD_REQUEST");
    await call(router.portalCompanies.addDomain, { cardCode: a.cardCode, domain }, as);
    expect(await messageOf(call(router.portalCompanies.addDomain, { cardCode: b.cardCode, domain }, as))).toContain(a.cardCode);
    await call(router.portalCompanies.removeDomain, { cardCode: a.cardCode, domain }, as);
    await call(router.portalCompanies.addDomain, { cardCode: b.cardCode, domain }, as);
  });

  test("setRole / removeMember keep the last owner", async () => {
    const { tenantId, as } = await setup();
    const owner = await makePortalUser();
    const c = await makePortalSeat(tenantId, owner.userId, "owner");
    expect(await codeOf(call(router.portalCompanies.removeMember, { cardCode: c.cardCode, userId: owner.userId }, as))).toBe("CONFLICT");
    const buyer = await makePortalUser();
    await insertSeat(tenantId, c.cardCode, buyer.userId, "buyer");
    await call(router.portalCompanies.setRole, { cardCode: c.cardCode, userId: buyer.userId, role: "owner" }, as);
    await call(router.portalCompanies.removeMember, { cardCode: c.cardCode, userId: owner.userId }, as);
    const left = await db.select().from(member).where(and(eq(member.role, EXTERNAL_ROLE), eq(member.cardCode, c.cardCode)));
    expect(left).toEqual([expect.objectContaining({ userId: buyer.userId, portalRole: "owner" })]);
  });
});

describe("a customer is a member of the supplier's organization (spec 2026-10-19)", () => {
  test("refused by every internal procedure", async () => {
    const { tenantId, slug } = await makeTenant();
    const customer = await makePortalUser();
    await makePortalSeat(tenantId, customer.userId, "owner");
    expect(await codeOf(call(router.me, undefined, ctx(slug, customer.cookie)))).toBe("FORBIDDEN");
    expect(await codeOf(call(router.portalInvitations.rows, { query: NO_QUERY, top: 1 }, ctx(slug, customer.cookie)))).toBe("FORBIDDEN");
  });

  test("Better Auth's member endpoints are off: a customer cannot list the supplier's people", async () => {
    const { tenantId } = await makeTenant();
    const customer = await makePortalUser();
    await makePortalSeat(tenantId, customer.userId, "owner");
    const get = (path: string) =>
      auth.handler(new Request(`${authUrl}/api/auth/organization/${path}`, { headers: { cookie: customer.cookie } }));
    expect((await get(`list-members?organizationId=${tenantId}`)).status).toBe(404);
    expect((await get(`get-full-organization?organizationId=${tenantId}`)).status).toBe(404);
    expect((await get("list")).status).toBe(404);
  });

  test("a seat does not count toward the one-workspace limit; a workspace does", async () => {
    const customer = await makePortalUser();
    await makePortalSeat((await makeTenant()).tenantId, customer.userId, "buyer");
    const slug = `w${uid()}`;
    await auth.api.createOrganization({ body: { name: slug, slug, userId: customer.userId } });
    const second = `w${uid()}`;
    await expect(auth.api.createOrganization({ body: { name: second, slug: second, userId: customer.userId } }))
      .rejects.toMatchObject({ status: "FORBIDDEN" });
  });
});
