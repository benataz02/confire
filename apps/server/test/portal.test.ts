import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, portalCompany, portalCompanyDomain, portalInvitation, portalMember, portalSession, session, user } from "@confire/db";
import { auth } from "../src/auth.ts";
import { devOutbox } from "../src/mail/mailer.ts";
import { microsoftEmailVerified, portalAuth } from "../src/portal/auth.ts";
import { portalBuyerProcedure, portalMemberProcedure, portalOwnerProcedure, portalSessionProcedure } from "../src/portal/orpc/base.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { sendInvitation } from "../src/portal/members.ts";
import { call, makePortalSeat, makePortalUser, makeTenant, makeUser, portalHeaders, portalSignIn } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// The customer portal's own process (spec §3–§4): a second Better Auth instance over the shared
// user table with its own session table, and builders whose boundary is host → tenant → seat.

const ctx = (slug: string, cookie?: string) => ({ context: { headers: portalHeaders(slug, cookie) } });
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);

// Spec §16 P2: a second instance with session.modelName "portalSession" over the hand-written
// table; sign-in on one zone creates a row only in its own session table.
describe("portal Better Auth instance", () => {
  test("a portal sign-in writes portal_session and nothing to session", async () => {
    const { userId, cookie } = await makePortalUser();
    expect(cookie).toStartWith("confire-portal.session_token=");
    expect(await db.select().from(portalSession).where(eq(portalSession.userId, userId))).toHaveLength(1);
    expect(await db.select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
  });

  test("neither zone's session authenticates the other, even replayed under the other's cookie name", async () => {
    const internal = await makeUser();
    const portal = await makePortalUser();
    const portalToken = portal.cookie.split("=").slice(1).join("=");
    const internalToken = internal.cookie.split("=").slice(1).join("=");
    expect(await auth.api.getSession({ headers: new Headers({ cookie: portal.cookie }) })).toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: `better-auth.session_token=${portalToken}` }) })).toBeNull();
    expect(await portalAuth.api.getSession({ headers: new Headers({ cookie: internal.cookie }) })).toBeNull();
    expect(await portalAuth.api.getSession({ headers: new Headers({ cookie: `confire-portal.session_token=${internalToken}` }) })).toBeNull();
    expect((await portalAuth.api.getSession({ headers: new Headers({ cookie: portal.cookie }) }))?.user.id).toBe(portal.userId);
  });

  test("the same password signs in on both zones (one identity, spec D3)", async () => {
    const internal = await makeUser();
    const cookie = await portalSignIn(internal.email);
    expect((await portalAuth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id).toBe(internal.userId);
  });

  test("a password reset on either zone ends the sessions of both (the password is shared)", async () => {
    const resetToken = async (email: string) => {
      for (let i = 0; i < 100; i++) {
        const mail = devOutbox.findLast((m) => m.to === email && m.subject === "Reset your password");
        const token = mail?.text.match(/\/api\/auth\/reset-password\/([^?\s]+)/)?.[1];
        if (token) return token;
        await Bun.sleep(20);
      }
      throw new Error(`no reset mail to ${email}`);
    };
    for (const [resetter, label] of [[portalAuth, "portal"], [auth, "internal"]] as const) {
      const u = await makeUser();
      const portalCookie = await portalSignIn(u.email);
      await resetter.api.requestPasswordReset({ body: { email: u.email, redirectTo: "/reset-password" } });
      await resetter.api.resetPassword({ body: { newPassword: `new-${label}-1234`, token: await resetToken(u.email) } });
      expect(await auth.api.getSession({ headers: new Headers({ cookie: u.cookie }) })).toBeNull();
      expect(await portalAuth.api.getSession({ headers: new Headers({ cookie: portalCookie }) })).toBeNull();
    }
  });

  test("sign-up through the HTTP endpoint needs a captcha token", async () => {
    const res = await portalAuth.handler(new Request("http://portal.lvh.me:5180/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://portal.lvh.me:5180" },
      body: JSON.stringify({ email: "nocaptcha@test.local", password: "test1234", name: "x" }),
    }));
    expect(res.status).toBe(400);
  });

  test("account mail is branded with the tenant the page named in ?t=", async () => {
    const { slug } = await makeTenant();
    const email = `b${crypto.randomUUID().slice(0, 8)}@test.local`;
    await portalAuth.api.signUpEmail({
      body: { email, password: "test1234", name: "Bea", callbackURL: `http://portal.lvh.me:5180/login?t=${slug}` },
    });
    let mail;
    for (let i = 0; i < 100 && !mail; i++) {
      mail = devOutbox.find((m) => m.to === email);
      if (!mail) await Bun.sleep(20);
    }
    expect(mail?.from).toBe(`"${slug}" <notify@${process.env.MAIL_DOMAIN ?? "mail.lvh.me"}>`);
    expect(mail?.html).toContain("/api/auth/verify-email?token=");
  });

  test("Microsoft counts an email as verified only on the xms_edov claim", () => {
    expect(microsoftEmailVerified({ xms_edov: true })).toBe(true);
    expect(microsoftEmailVerified({ xms_edov: "1" })).toBe(true);
    expect(microsoftEmailVerified({ xms_edov: false })).toBe(false);
    expect(microsoftEmailVerified({ email_verified: true })).toBe(false); // not the claim we trust
    expect(microsoftEmailVerified({})).toBe(false);
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

  test("an internal member of the host tenant is refused by every builder", async () => {
    const { tenantId, slug } = await makeTenant();
    const staff = await makeUser("member", tenantId);
    const cookie = await portalSignIn(staff.email);
    // Even with a seat — the builder refuses before it ever reads one.
    await makePortalSeat(tenantId, staff.userId, "owner");
    for (const p of Object.values(probe)) expect(await codeOf(call(p, undefined, ctx(slug, cookie)))).toBe("FORBIDDEN");
  });

  test("a leftover `client` membership (the removed in-app portal, D23) is not staff", async () => {
    const { tenantId, slug } = await makeTenant();
    const former = await makeUser("client", tenantId);
    const cookie = await portalSignIn(former.email);
    expect(await call(probe.session, undefined, ctx(slug, cookie))).toBe(tenantId);
    expect((await call(portalRouter.me, undefined, ctx(slug, cookie))).internal).toBe(false);
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
    expect(internal).toMatchObject({ internal: true, company: null });
    expect(internal.internalAppUrl).toContain(`${slug}.`);
  });

  test("lobby lists the user's companies across suppliers; branding is public", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const { userId, cookie } = await makePortalUser();
    await makePortalSeat(a.tenantId, userId, "owner", "A-Kunde");
    await makePortalSeat(b.tenantId, userId, "viewer", "B-Kunde");
    const lobby = await call(portalRouter.lobby, undefined, { context: { headers: new Headers({ cookie }) } });
    expect(lobby.map((r) => r.slug).sort()).toEqual([a.slug, b.slug].sort());
    expect(lobby.find((r) => r.slug === b.slug)).toMatchObject({ cardName: "B-Kunde", role: "viewer" });

    expect(await call(portalRouter.branding, { slug: a.slug }, { context: { headers: new Headers() } }))
      .toEqual({ name: a.slug, logo: null });
    expect(await call(portalRouter.branding, { slug: "nosuchsupplier" }, { context: { headers: new Headers() } })).toBeNull();
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
  const invite = (email: string, role: "owner" | "buyer" | "viewer" = "buyer", registerDomain = false) =>
    sendInvitation({
      tenantId: t.tenantId, companyId: company!.id, email, role, registerDomain,
      inviter: { id: admin.userId, name: "Ines Inviter", email: admin.email },
    });
  return { ...t, company: company!, admin, invite };
}

const seatRole = async (companyId: string, userId: string) =>
  (await db.select({ role: portalMember.role }).from(portalMember)
    .where(and(eq(portalMember.companyId, companyId), eq(portalMember.userId, userId))))[0]?.role;

describe("onboarding.invitation / accept", () => {
  test("names the company, role and inviter; accept seats the user and registers the domain", async () => {
    const t = await invitingTenant("Müller AG");
    const invitee = await makePortalUser();
    const { id } = await t.invite(invitee.email, "buyer", true);
    expect(await call(portalRouter.onboarding.invitation, { id }, ctx(t.slug, invitee.cookie))).toMatchObject({
      // the inviter as the user table names them (the harness names users by their email)
      id, type: "existing", companyName: "Müller AG", role: "buyer", inviterName: t.admin.email, tenant: { slug: t.slug, name: t.slug },
    });
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, invitee.cookie));
    expect(await seatRole(t.company.id, invitee.userId)).toBe("buyer");
    expect((await call(portalRouter.me, undefined, ctx(t.slug, invitee.cookie))).company).toMatchObject({ cardName: "Müller AG", role: "buyer" });
    const [inv] = await db.select().from(portalInvitation).where(eq(portalInvitation.id, id));
    expect(inv!.status).toBe("accepted");
    const domains = await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.companyId, t.company.id));
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
    expect(await seatRole(t.company.id, stranger.userId)).toBeUndefined();
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, invitee.cookie));
    expect(await seatRole(t.company.id, invitee.userId)).toBe("buyer");
  });

  test("expired, cancelled or already accepted is CONFLICT; an unverified account is FORBIDDEN", async () => {
    const t = await invitingTenant();
    const a = await makePortalUser();
    const expired = await t.invite(a.email);
    await db.update(portalInvitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(portalInvitation.id, expired.id));
    expect(await codeOf(call(portalRouter.onboarding.accept, { id: expired.id }, ctx(t.slug, a.cookie)))).toBe("CONFLICT");

    const b = await makePortalUser();
    const cancelled = await t.invite(b.email);
    await db.update(portalInvitation).set({ status: "canceled" }).where(eq(portalInvitation.id, cancelled.id));
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
    expect(await db.select().from(portalMember).where(eq(portalMember.userId, u.userId))).toHaveLength(1);
  });

  test("a free-mail invitation with registerDomain registers nothing", async () => {
    const t = await invitingTenant();
    const u = await makePortalUser(`f${uid()}@gmail.com`);
    const { id } = await t.invite(u.email, "owner", true);
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, u.cookie));
    expect(await seatRole(t.company.id, u.userId)).toBe("owner");
    expect(await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.companyId, t.company.id))).toHaveLength(0);
  });
});

describe("onboarding.join (auto-join, spec §4.4)", () => {
  const registered = async (domain = "test.local") => {
    const t = await invitingTenant("Domain AG");
    await db.insert(portalCompanyDomain).values({ tenantId: t.tenantId, domain, companyId: t.company.id });
    return t;
  };

  test("a verified address on a registered domain joins as viewer", async () => {
    const t = await registered();
    const u = await makePortalUser();
    expect(await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie))).toEqual({ cardName: "Domain AG" });
    expect((await call(portalRouter.me, undefined, ctx(t.slug, u.cookie))).company).toMatchObject({ role: "viewer" });
  });

  test("free mail, an unverified address, or no registered domain: nobody joins", async () => {
    const free = await registered("gmail.com"); // not reachable through claimDomain; join must refuse anyway
    const g = await makePortalUser(`g${uid()}@gmail.com`);
    expect(await call(portalRouter.onboarding.join, undefined, ctx(free.slug, g.cookie))).toBeNull();

    const t = await registered();
    const u = await makePortalUser();
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, u.userId));
    expect(await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie))).toBeNull();

    const none = await invitingTenant();
    const v = await makePortalUser();
    expect(await call(portalRouter.onboarding.join, undefined, ctx(none.slug, v.cookie))).toBeNull();
    expect(await db.select().from(portalMember).where(eq(portalMember.userId, v.userId))).toHaveLength(0);
  });

  test("an auto-joined viewer who then accepts a buyer invitation becomes buyer", async () => {
    const t = await registered();
    const u = await makePortalUser();
    const { id } = await t.invite(u.email, "buyer");
    await call(portalRouter.onboarding.join, undefined, ctx(t.slug, u.cookie));
    expect(await seatRole(t.company.id, u.userId)).toBe("viewer");
    await call(portalRouter.onboarding.accept, { id }, ctx(t.slug, u.cookie));
    expect(await seatRole(t.company.id, u.userId)).toBe("buyer");
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
    await db.insert(portalCompanyDomain).values({ tenantId: t.tenantId, domain, companyId: t.company.id });
    const owner = await makePortalUser();
    const buyer = await makePortalUser();
    await db.insert(portalMember).values([
      { companyId: t.company.id, userId: owner.userId, tenantId: t.tenantId, role: "owner" },
      { companyId: t.company.id, userId: buyer.userId, tenantId: t.tenantId, role: "buyer" },
    ]);
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
    const [inv] = await db.select().from(portalInvitation).where(eq(portalInvitation.id, id));
    expect(inv).toMatchObject({ companyId: c.company.id, role: "viewer", registerDomain: false, invitedBy: c.owner.userId });
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
    expect(await seatRole(c.company.id, c.buyer.userId)).toBe("viewer");
    await call(portalRouter.company.members.remove, { userId: c.buyer.userId }, c.as(c.owner));
    expect(await seatRole(c.company.id, c.buyer.userId)).toBeUndefined();
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
    const [row] = await db.select().from(portalCompany).where(eq(portalCompany.id, c.company.id));
    expect(row).toMatchObject({ cardName: "Neu-Name GmbH", cardType: "cLid" });
    expect((await call(portalRouter.company.domains.list, undefined, c.as(c.buyer))).map((d) => d.domain)).toEqual([c.domain]);
  });
});
