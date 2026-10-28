import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { account, db, invitation, portalCompany, portalCompanyDomain, user } from "@confire/db";
import { auth, isWorkAccount, microsoftEmailVerified } from "../src/auth.ts";
import { devOutbox, mailDomain } from "../src/mail/mailer.ts";
import { router } from "../src/orpc/router.ts";
import { portalBuyerProcedure, portalMemberProcedure, portalOwnerProcedure, portalSessionProcedure } from "../src/portal/orpc/base.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { sendInvitation } from "../src/portal/members.ts";
import { appTenantUrl, authUrl } from "../src/tenant.ts";
import {
  call, insertSeat, makePortalSeat, makePortalUser, makeTenant, makeUser, portalSignIn, seatRole, seatsOf, tenantHeaders,
} from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The customer portal's own process (spec §3–§4): the one Better Auth instance it shares with the
// internal app, and builders whose boundary is the path's tenant → seat (spec
// 2026-10-19-path-tenancy-design.md).

const ctx = (slug: string, cookie?: string) => ({ context: { headers: tenantHeaders(slug, cookie) } });
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);

describe("one sign-in for staff and customers", () => {
  test("one session reaches both processes; each one's membership join still decides", async () => {
    const { tenantId, slug } = await makeTenant();
    const customer = await makePortalUser();
    await makePortalSeat(tenantId, customer.userId, "buyer");
    const staff = await makeUser("member", tenantId);
    const probe = portalMemberProcedure.handler(({ context }) => context.role);
    expect(await call(probe, undefined, ctx(slug, customer.cookie))).toBe("buyer");
    expect(await codeOf(call(router.me, undefined, { context: { headers: tenantHeaders(slug, customer.cookie) } }))).toBe("FORBIDDEN");
    expect((await call(router.me, undefined, { context: { headers: tenantHeaders(slug, staff.cookie) } })).role).toBe("member");
    expect(await codeOf(call(probe, undefined, ctx(slug, staff.cookie)))).toBe("FORBIDDEN");
  });

  test("a password reset ends every session of that user", async () => {
    const u = await makeUser();
    const second = await portalSignIn(u.email);
    await auth.api.requestPasswordReset({ body: { email: u.email, redirectTo: "/reset-password" } });
    let token: string | undefined;
    for (let i = 0; i < 100 && !token; i++) {
      const mail = devOutbox.findLast((m) => m.to === u.email && m.subject === "Reset your password");
      token = mail?.text.match(/\/api\/auth\/reset-password\/([^?\s]+)/)?.[1];
      if (!token) await Bun.sleep(20);
    }
    await auth.api.resetPassword({ body: { newPassword: "new-pass-1234", token: token! } });
    expect(await auth.api.getSession({ headers: new Headers({ cookie: u.cookie }) })).toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: second }) })).toBeNull();
  });

  test("account mail is always Confire's, whatever the page asked to come back to", async () => {
    const { slug } = await makeTenant();
    const email = `b${crypto.randomUUID().slice(0, 8)}@test.local`;
    await auth.api.signUpEmail({
      body: { email, password: "test1234", name: "Bea", callbackURL: `${authUrl}/login?redirect=${encodeURIComponent(`${authUrl}/${slug}/`)}` },
    });
    let mail;
    for (let i = 0; i < 100 && !mail; i++) {
      mail = devOutbox.find((m) => m.to === email);
      if (!mail) await Bun.sleep(20);
    }
    expect(mail?.from).toBe(`"Confire" <notify@${mailDomain}>`);
    expect(mail?.html).toContain("/api/auth/verify-email?token=");
  });

  test("Microsoft counts an email as verified only on the xms_edov claim", () => {
    expect(microsoftEmailVerified({ xms_edov: true })).toBe(true);
    expect(microsoftEmailVerified({ xms_edov: "1" })).toBe(true);
    expect(microsoftEmailVerified({ xms_edov: false })).toBe(false);
    expect(microsoftEmailVerified({ email_verified: true })).toBe(false); // not the claim we trust
    expect(microsoftEmailVerified({})).toBe(false);
  });

  test("a work account is Google Workspace or a Microsoft work tenant, never a personal one", () => {
    expect(isWorkAccount("google", { hd: "kunde.de", email_verified: true })).toBe(true);
    expect(isWorkAccount("google", { email_verified: true })).toBe(false); // a Google account on any address
    expect(isWorkAccount("google", { hd: "kunde.de", email_verified: false })).toBe(false);
    expect(isWorkAccount("microsoft", { tid: "a1b2c3", xms_edov: true })).toBe(true);
    expect(isWorkAccount("microsoft", { tid: "9188040d-6c67-4c5b-b112-36a304b66dad", xms_edov: true })).toBe(false);
    expect(isWorkAccount("microsoft", { tid: "a1b2c3" })).toBe(false); // the tenant never verified the domain
    expect(isWorkAccount("credential", { hd: "kunde.de", email_verified: true })).toBe(false);
  });
});

describe("portal procedure builders", () => {
  const probe = {
    session: portalSessionProcedure.handler(({ context }) => context.tenantId),
    member: portalMemberProcedure.handler(({ context }) => context.cardCode),
    buyer: portalBuyerProcedure.handler(({ context }) => context.role),
    owner: portalOwnerProcedure.handler(({ context }) => context.role),
  };

  test("signed out is UNAUTHORIZED; an unknown supplier is NOT_FOUND", async () => {
    const { slug } = await makeTenant();
    const { cookie } = await makePortalUser();
    expect(await codeOf(call(probe.session, undefined, ctx(slug)))).toBe("UNAUTHORIZED");
    expect(await codeOf(call(probe.session, undefined, ctx("nosuchsupplier", cookie)))).toBe("NOT_FOUND");
  });

  test("an internal member of the request's tenant is refused by every builder", async () => {
    const { tenantId, slug } = await makeTenant();
    const staff = await makeUser("member", tenantId);
    const cookie = await portalSignIn(staff.email);
    for (const p of Object.values(probe)) expect(await codeOf(call(p, undefined, ctx(slug, cookie)))).toBe("FORBIDDEN");
  });

  test("no tenant in the request is BAD_REQUEST, a reserved name too", async () => {
    const { cookie } = await makePortalUser();
    expect(await codeOf(call(probe.session, undefined, { context: { headers: new Headers({ cookie }) } }))).toBe("BAD_REQUEST");
    expect(await codeOf(call(probe.session, undefined, ctx("login", cookie)))).toBe("BAD_REQUEST");
  });

  test("no seat here: the session builder passes, the member builders refuse", async () => {
    const { tenantId, slug } = await makeTenant();
    const { cookie } = await makePortalUser();
    expect(await call(probe.session, undefined, ctx(slug, cookie))).toBe(tenantId);
    expect(await codeOf(call(probe.member, undefined, ctx(slug, cookie)))).toBe("FORBIDDEN");
  });

  test("a seat at another supplier does not open this one", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { userId, cookie } = await makePortalUser();
    await makePortalSeat(a.tenantId, userId, "owner");
    expect(await codeOf(call(probe.member, undefined, ctx(b.slug, cookie)))).toBe("FORBIDDEN");
  });

  test("roles: viewer reads, buyer writes, owner administers", async () => {
    const { tenantId, slug } = await makeTenant();
    const seat = async (role: "viewer" | "buyer" | "owner") => {
      const u = await makePortalUser();
      const company = await makePortalSeat(tenantId, u.userId, role);
      return { ...u, company };
    };
    const viewer = await seat("viewer");
    const buyer = await seat("buyer");
    const owner = await seat("owner");
    expect(await call(probe.member, undefined, ctx(slug, viewer.cookie))).toBe(viewer.company.cardCode);
    expect(await codeOf(call(probe.buyer, undefined, ctx(slug, viewer.cookie)))).toBe("FORBIDDEN");
    expect(await call(probe.buyer, undefined, ctx(slug, buyer.cookie))).toBe("buyer");
    expect(await codeOf(call(probe.owner, undefined, ctx(slug, buyer.cookie)))).toBe("FORBIDDEN");
    expect(await call(probe.buyer, undefined, ctx(slug, owner.cookie))).toBe("owner");
    expect(await call(probe.owner, undefined, ctx(slug, owner.cookie))).toBe("owner");
  });
});

describe("portal router", () => {
  test("me: no company yet, a seat, or an internal member", async () => {
    const { tenantId, slug } = await makeTenant();
    const fresh = await makePortalUser();
    const none = await call(portalRouter.me, undefined, ctx(slug, fresh.cookie));
    expect(none).toMatchObject({ tenant: { slug, name: slug }, internal: false, company: null });

    await makePortalSeat(tenantId, fresh.userId, "buyer", "Müller AG");
    const seated = await call(portalRouter.me, undefined, ctx(slug, fresh.cookie));
    expect(seated.company).toMatchObject({ cardName: "Müller AG", cardType: "cCustomer", role: "buyer" });

    const staff = await makeUser("admin", tenantId);
    const internal = await call(portalRouter.me, undefined, ctx(slug, await portalSignIn(staff.email)));
    expect(internal).toMatchObject({ internal: true, company: null, internalAppUrl: appTenantUrl(slug) });
  });

  test("me with a seat makes the supplier the session's active organization; without one it does not", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const u = await makePortalUser();
    await makePortalSeat(a.tenantId, u.userId, "viewer");
    const active = async () => (await auth.api.getSession({ headers: new Headers({ cookie: u.cookie }) }))?.session.activeOrganizationId;
    await call(portalRouter.me, undefined, ctx(b.slug, u.cookie));
    expect(await active()).toBeFalsy();
    await call(portalRouter.me, undefined, ctx(a.slug, u.cookie));
    expect(await active()).toBe(a.tenantId);
  });

  test("lobby lists the user's companies across suppliers", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { userId, cookie } = await makePortalUser();
    await makePortalSeat(a.tenantId, userId, "owner", "A-Kunde");
    await makePortalSeat(b.tenantId, userId, "viewer", "B-Kunde");
    const lobby = await call(portalRouter.lobby, undefined, { context: { headers: new Headers({ cookie }) } });
    expect(lobby.map((r) => r.slug).sort()).toEqual([a.slug, b.slug].sort());
    expect(lobby.find((r) => r.slug === b.slug)).toMatchObject({ cardName: "B-Kunde", role: "viewer" });
  });
});

// --- P3: invitations, auto-join, the company page (spec §4.4, §5.2, §9, §11) ---------------------

const uid = () => crypto.randomUUID().slice(0, 8);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

/** A tenant with a company and an internal admin to invite from. */
async function invitingTenant(cardName = "Kunde AG") {
  const t = await makeTenant();
  const [company] = await db.insert(portalCompany)
    .values({ tenantId: t.tenantId, cardCode: `C${uid()}`, cardName, cardType: "cCustomer" }).returning();
  const admin = await makeUser("admin", t.tenantId);
  const invite = (email: string, role: "owner" | "buyer" | "viewer" = "buyer") =>
    sendInvitation({
      tenantId: t.tenantId, cardCode: company!.cardCode, email, role,
      inviter: { id: admin.userId, name: "Ines Inviter", email: admin.email },
    });
  return { ...t, company: company!, admin, invite };
}

describe("onboarding.invitation / accept", () => {
  test("names the company, role and inviter; accept seats the user and registers the domain", async () => {
    const t = await invitingTenant("Müller AG");
    const invitee = await makePortalUser();
    const { id } = await t.invite(invitee.email, "buyer");
    expect(await call(portalRouter.onboarding.invitation, { id }, ctx(t.slug, invitee.cookie))).toMatchObject({
      // the inviter as the user table names them (the harness names users by their email)
      id, type: "existing", companyName: "Müller AG", role: "buyer", inviterName: t.admin.email, tenant: { slug: t.slug, name: t.slug },
    });
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, invitee.cookie));
    expect(await seatRole(t.company, invitee.userId)).toBe("buyer");
    expect((await call(portalRouter.me, undefined, ctx(t.slug, invitee.cookie))).company).toMatchObject({ cardName: "Müller AG", role: "buyer" });
    const [inv] = await db.select().from(invitation).where(eq(invitation.id, id));
    expect(inv!.status).toBe("accepted");
    const domains = await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.cardCode, t.company.cardCode));
    expect(domains.map((d) => d.domain)).toEqual(["test.local"]);
  });

  test("another supplier's invitation is NOT_FOUND; the wrong account is told which address; case is ignored", async () => {
    const t = await invitingTenant();
    const other = await makeTenant();
    const invitee = await makePortalUser();
    const { id } = await t.invite(invitee.email.toUpperCase());
    expect(await codeOf(call(portalRouter.onboarding.invitation, { id }, ctx(other.slug, invitee.cookie)))).toBe("NOT_FOUND");
    const stranger = await makePortalUser();
    const wrong = call(portalRouter.onboarding.accept, { id }, ctx(t.slug, stranger.cookie));
    expect(await messageOf(wrong)).toContain(`${invitee.email[0]}…@test.local`);
    expect(await seatRole(t.company, stranger.userId)).toBeUndefined();
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, invitee.cookie));
    expect(await seatRole(t.company, invitee.userId)).toBe("buyer");
  });

  test("invitee, signed out: the address and whether it has an account; null for another supplier's or a closed one", async () => {
    const t = await invitingTenant();
    const fresh = `n${uid()}@test.local`;
    const { id } = await t.invite(fresh.toUpperCase());
    expect(await call(portalRouter.onboarding.invitee, { id }, ctx(t.slug))).toEqual({ email: fresh, hasAccount: false });
    const known = await makePortalUser();
    const { id: knownId } = await t.invite(known.email);
    expect(await call(portalRouter.onboarding.invitee, { id: knownId }, ctx(t.slug))).toEqual({ email: known.email, hasAccount: true });
    expect(await call(portalRouter.onboarding.invitee, { id }, ctx((await makeTenant()).slug))).toBeNull();
    await db.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, id));
    expect(await call(portalRouter.onboarding.invitee, { id }, ctx(t.slug))).toBeNull();
  });

  test("expired, cancelled or already accepted is CONFLICT; an unverified account is FORBIDDEN", async () => {
    const t = await invitingTenant();
    const a = await makePortalUser();
    const expired = await t.invite(a.email);
    await db.update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, expired.id));
    expect(await codeOf(call(portalRouter.onboarding.accept, { id: expired.id }, ctx(t.slug, a.cookie)))).toBe("CONFLICT");

    const b = await makePortalUser();
    const cancelled = await t.invite(b.email);
    await db.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, cancelled.id));
    expect(await codeOf(call(portalRouter.onboarding.invitation, { id: cancelled.id }, ctx(t.slug, b.cookie)))).toBe("CONFLICT");

    const c = await makePortalUser();
    const once = await t.invite(c.email);
    await call(portalRouter.onboarding.accept, { id: once.id }, ctx(t.slug, c.cookie));
    expect(await codeOf(call(portalRouter.onboarding.accept, { id: once.id }, ctx(t.slug, c.cookie)))).toBe("CONFLICT");

    const d = await makePortalUser();
    const unverified = await t.invite(d.email);
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, d.userId));
    expect(await codeOf(call(portalRouter.onboarding.accept, { id: unverified.id }, ctx(t.slug, d.cookie)))).toBe("FORBIDDEN");
  });

  test("two accepts at once: one seat, one CONFLICT", async () => {
    const t = await invitingTenant();
    const u = await makePortalUser();
    const { id } = await t.invite(u.email);
    const results = await Promise.all([
      codeOf(call(portalRouter.onboarding.accept, { id }, ctx(t.slug, u.cookie))),
      codeOf(call(portalRouter.onboarding.accept, { id }, ctx(t.slug, u.cookie))),
    ]);
    expect(results.sort()).toEqual(["CONFLICT", "OK"]);
    expect(await seatsOf(u.userId)).toHaveLength(1);
  });

  test("a free-mail invitation registers nothing", async () => {
    const t = await invitingTenant();
    const u = await makePortalUser(`f${uid()}@gmail.com`);
    const { id } = await t.invite(u.email, "owner");
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, u.cookie));
    expect(await seatRole(t.company, u.userId)).toBe("owner");
    expect(await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.cardCode, t.company.cardCode))).toHaveLength(0);
  });
});

describe("onboarding.join (auto-join, spec §4.4)", () => {
  const registered = async (domain = "test.local") => {
    const t = await invitingTenant("Domain AG");
    await db.insert(portalCompanyDomain).values({ tenantId: t.tenantId, domain, cardCode: t.company.cardCode });
    return t;
  };

  /** The user also signs in with `providerId`: an account row with the ID token it would have sent. */
  const signsInWith = (u: { userId: string; email: string }, providerId: string, claims: Record<string, unknown>) =>
    db.insert(account).values({
      id: crypto.randomUUID(), accountId: uid(), providerId, userId: u.userId, updatedAt: new Date(),
      idToken: `e30.${Buffer.from(JSON.stringify({ email: u.email, ...claims })).toString("base64url")}.sig`,
    });

  test("a Google Workspace or Microsoft work account on a registered domain joins as viewer", async () => {
    const t = await registered();
    const u = await makePortalUser();
    await signsInWith(u, "google", { hd: "test.local", email_verified: true });
    expect(await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie))).toEqual({ cardName: "Domain AG" });
    expect((await call(portalRouter.me, undefined, ctx(t.slug, u.cookie))).company).toMatchObject({ role: "viewer" });
    const m = await makePortalUser();
    await signsInWith(m, "microsoft", { tid: "a1b2c3", xms_edov: true });
    expect(await call(portalRouter.onboarding.join, undefined, ctx(t.slug, m.cookie))).toEqual({ cardName: "Domain AG" });
  });

  test("a verified address alone, or a personal Google/Microsoft account on the domain, does not join", async () => {
    const t = await registered();
    const password = await makePortalUser();
    const google = await makePortalUser();
    await signsInWith(google, "google", { email_verified: true });
    const msa = await makePortalUser();
    await signsInWith(msa, "microsoft", { tid: "9188040d-6c67-4c5b-b112-36a304b66dad", xms_edov: true });
    for (const u of [password, google, msa]) {
      expect(await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie))).toBeNull();
      expect(await seatsOf(u.userId)).toHaveLength(0);
    }
  });

  test("free mail, an unverified address, or no registered domain: nobody joins", async () => {
    const free = await registered("gmail.com"); // not reachable through claimDomain; join must refuse anyway
    const g = await makePortalUser(`g${uid()}@gmail.com`);
    expect(await call(portalRouter.onboarding.join, undefined, ctx(free.slug, g.cookie))).toBeNull();

    const t = await registered();
    const u = await makePortalUser();
    await signsInWith(u, "google", { hd: "test.local", email_verified: true });
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, u.userId));
    expect(await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie))).toBeNull();

    const none = await invitingTenant();
    const v = await makePortalUser();
    await signsInWith(v, "google", { hd: "test.local", email_verified: true });
    expect(await call(portalRouter.onboarding.join, undefined, ctx(none.slug, v.cookie))).toBeNull();
    expect(await seatsOf(v.userId)).toHaveLength(0);
  });

  test("an auto-joined viewer who then accepts a buyer invitation becomes buyer", async () => {
    const t = await registered();
    const u = await makePortalUser();
    await signsInWith(u, "google", { hd: "test.local", email_verified: true });
    const { id } = await t.invite(u.email, "buyer");
    await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie));
    expect(await seatRole(t.company, u.userId)).toBe("viewer");
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, u.cookie));
    expect(await seatRole(t.company, u.userId)).toBe("buyer");
  });
});

describe("company (the owner's page, spec §9)", () => {
  let agent: MockAgent;
  beforeAll(() => { agent = startMockAgent({ BusinessPartners: [] }); });
  afterAll(() => agent.stop());

  /** An owner and a buyer in a company with one registered domain. */
  async function ownedCompany() {
    const t = await invitingTenant("Alt-Name GmbH");
    const domain = `${uid()}.de`;
    await db.insert(portalCompanyDomain).values({ tenantId: t.tenantId, domain, cardCode: t.company.cardCode });
    const owner = await makePortalUser();
    const buyer = await makePortalUser();
    await insertSeat(t.tenantId, t.company.cardCode, owner.userId, "owner");
    await insertSeat(t.tenantId, t.company.cardCode, buyer.userId, "buyer");
    return { ...t, domain, owner, buyer, as: (u: { cookie: string }) => ctx(t.slug, u.cookie) };
  }

  test("D24: an owner invites only on the company's domains; buyers and viewers not at all", async () => {
    const c = await ownedCompany();
    const outside = call(portalRouter.company.members.invite, { email: `x${uid()}@elsewhere.de`, role: "buyer" }, c.as(c.owner));
    expect(await codeOf(outside)).toBe("FORBIDDEN");
    expect(await messageOf(call(portalRouter.company.members.invite, { email: `x${uid()}@elsewhere.de`, role: "buyer" }, c.as(c.owner))))
      .toContain(c.domain);
    const inside = `y${uid()}@${c.domain.toUpperCase()}`;
    const { id } = await call(portalRouter.company.members.invite, { email: inside, role: "viewer" }, c.as(c.owner));
    const [inv] = await db.select().from(invitation).where(eq(invitation.id, id));
    expect(inv).toMatchObject({
      cardCode: c.company.cardCode, role: "portal_viewer", inviterId: c.owner.userId,
    });
    expect(await codeOf(call(portalRouter.company.members.invite, { email: `z${uid()}@${c.domain}`, role: "viewer" }, c.as(c.buyer))))
      .toBe("FORBIDDEN");
  });

  test("members.list: everyone sees colleagues, only owners see pending invitations; owners cancel their own", async () => {
    const c = await ownedCompany();
    const { id } = await call(portalRouter.company.members.invite, { email: `p${uid()}@${c.domain}`, role: "buyer" }, c.as(c.owner));
    const forOwner = await call(portalRouter.company.members.list, undefined, c.as(c.owner));
    expect(forOwner.members.map((m) => m.role).sort()).toEqual(["buyer", "owner"]);
    expect(forOwner.invitations.map((i) => i.id)).toEqual([id]);
    const forBuyer = await call(portalRouter.company.members.list, undefined, c.as(c.buyer));
    expect(forBuyer.members).toHaveLength(2);
    expect(forBuyer.invitations).toEqual([]);

    const elsewhere = await ownedCompany();
    const foreign = await elsewhere.invite(`q${uid()}@x.de`);
    expect(await codeOf(call(portalRouter.company.members.cancelInvite, { id: foreign.id }, c.as(c.owner)))).toBe("NOT_FOUND");
    await call(portalRouter.company.members.cancelInvite, { id }, c.as(c.owner));
    expect((await call(portalRouter.company.members.list, undefined, c.as(c.owner))).invitations).toEqual([]);
  });

  test("roles and removal, but never the last owner", async () => {
    const c = await ownedCompany();
    expect(await codeOf(call(portalRouter.company.members.setRole, { userId: c.owner.userId, role: "buyer" }, c.as(c.owner)))).toBe("CONFLICT");
    await call(portalRouter.company.members.setRole, { userId: c.buyer.userId, role: "viewer" }, c.as(c.owner));
    expect(await seatRole(c.company, c.buyer.userId)).toBe("viewer");
    await call(portalRouter.company.members.remove, { userId: c.buyer.userId }, c.as(c.owner));
    expect(await seatRole(c.company, c.buyer.userId)).toBeUndefined();
    // A member of another company is not this owner's to touch.
    const other = await ownedCompany();
    expect(await codeOf(call(portalRouter.company.members.remove, { userId: other.buyer.userId }, c.as(c.owner)))).toBe("NOT_FOUND");
  });

  test("get reads the BP live and refreshes name and type (§5.5); with SAP down the page still loads", async () => {
    const c = await ownedCompany();
    const down = await call(portalRouter.company.get, undefined, c.as(c.buyer));
    expect(down).toMatchObject({ cardCode: c.company.cardCode, cardName: "Alt-Name GmbH", role: "buyer", summary: null });
    expect(down.summaryError).toBeTruthy();

    await connectTenant(c.tenantId, agent);
    agent.store.BusinessPartners!.push({
      CardCode: c.company.cardCode, CardName: "Neu-Name GmbH", CardType: "cLid", Phone1: "+49 1", City: "Ulm",
    });
    const up = await call(portalRouter.company.get, undefined, c.as(c.buyer));
    expect(up).toMatchObject({ cardName: "Neu-Name GmbH", cardType: "cLid", summary: { Phone1: "+49 1", City: "Ulm" }, summaryError: null });
    const [row] = await db.select().from(portalCompany)
      .where(and(eq(portalCompany.tenantId, c.company.tenantId), eq(portalCompany.cardCode, c.company.cardCode)));
    expect(row).toMatchObject({ cardName: "Neu-Name GmbH", cardType: "cLid" });
    expect((await call(portalRouter.company.domains.list, undefined, c.as(c.buyer))).map((d) => d.domain)).toEqual([c.domain]);
  });
});
