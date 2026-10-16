import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, portalSession, session } from "@confire/db";
import { auth } from "../src/auth.ts";
import { devOutbox } from "../src/mail/mailer.ts";
import { microsoftEmailVerified, portalAuth } from "../src/portal/auth.ts";
import { portalBuyerProcedure, portalMemberProcedure, portalOwnerProcedure, portalSessionProcedure } from "../src/portal/orpc/base.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { call, makePortalSeat, makePortalUser, makeTenant, makeUser, portalHeaders, portalSignIn } from "./harness.ts";

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
