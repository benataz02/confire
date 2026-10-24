import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, organization, sapConnection, verification } from "@confire/db";
import { agentRoutes, isNewer, normalizeCode, redeemPairing } from "../src/agent-pairing.ts";
import { auth } from "../src/auth.ts";
import { decryptSecret } from "../src/crypto.ts";
import { upsertSapConnection } from "../src/seed-agent.ts";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { appTenantUrl, portalTenantUrl } from "../src/tenant.ts";
import { call, makePortalSeat, makeTenant, makeUser, tenantHeaders } from "./harness.ts";
import { startMockAgent, type MockAgent } from "./mock-agent.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
/** A PairingError's HTTP status, or what went wrong instead. */
const code404 = (p: Promise<unknown>) => p.then(() => 200, (e) => (e as { status?: number }).status ?? String(e));
/** The sign-in host's calls: no workspace in the path, so no x-tenant. */
const apex = (cookie: string) => ({ context: { headers: new Headers({ cookie }) } });

describe.skipIf(!process.env.DATABASE_URL)("upsertSapConnection", () => {
  test("encrypts the secret; a second call updates the row", async () => {
    const { tenantId } = await makeTenant();
    await upsertSapConnection(tenantId, { agentUrl: "http://localhost:4000", secret: "a" });
    await upsertSapConnection(tenantId, { agentUrl: "https://agent.example", secret: "b", companyDb: "SBODEMO" });
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    expect(row).toMatchObject({ agentUrl: "https://agent.example", companyDb: "SBODEMO" });
    expect(row!.secret).not.toBe("b");
    expect(decryptSecret(row!.secret)).toBe("b");
  });
});

/** The redeem body the Go agent posts. */
const pair = (code: string, port = 4123) => redeemPairing({ code, port, version: "dev", companyDb: "SBODEMO" });

describe("pairing codes", () => {
  test("Crockford: any case, hyphens and spaces ignored, I/L read as 1 and O as 0", () => {
    expect(normalizeCode("k7qm-2xpa")).toBe("K7QM2XPA");
    expect(normalizeCode(" OIL0 1l1o ")).toBe("01101110");
  });

  test("update available: only a later numbered build", () => {
    expect(isNewer("2026.10.24.12", "2026.10.23.99")).toBe(true);
    expect(isNewer("2026.10.23.100", "2026.10.23.99")).toBe(true);
    expect(isNewer("2026.10.23.99", "2026.10.23.99")).toBe(false);
    expect(isNewer("2026.10.24.1", "dev")).toBe(false); // a dev build is never behind
    expect(isNewer(null, "2026.10.23.1")).toBe(false); // no bundled build (dev server)
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sap.pairingCode / redeem (dev: no Cloudflare)", () => {
  test("code → row → code gone; a reused code is refused", async () => {
    const { tenantId, slug } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const { code, expiresAt } = await call(router.sap.pairingCode, undefined, { context: { headers: tenantHeaders(slug, owner.cookie) } });
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000);

    const paired = await pair(code.toLowerCase());
    expect(paired).toMatchObject({ slug, agentUrl: "http://localhost:4123", tunnelToken: null });
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    expect(row).toMatchObject({ agentUrl: "http://localhost:4123", companyDb: "SBODEMO", tunnelId: null });
    expect(decryptSecret(row!.secret)).toBe(paired.secret);
    expect(await db.select().from(verification).where(eq(verification.value, tenantId))).toEqual([]);
    expect(await code404(pair(code))).toBe(404);

    // Pairing again (a new server) replaces the secret: the old box is cut off.
    const again = await call(router.sap.pairingCode, undefined, { context: { headers: tenantHeaders(slug, owner.cookie) } });
    const second = await pair(again.code, 4200);
    expect(second.secret).not.toBe(paired.secret);
    expect((await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)))[0]!.agentUrl).toBe("http://localhost:4200");
  });

  test("an expired code, a replaced code and a wrong code are refused", async () => {
    const { tenantId, slug } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, owner.cookie) } };
    const old = await call(router.sap.pairingCode, undefined, ctx);
    const current = await call(router.sap.pairingCode, undefined, ctx);
    expect(await code404(pair(old.code))).toBe(404); // a new code replaces the earlier one
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.value, tenantId));
    expect(await code404(pair(current.code))).toBe(404);
    expect(await code404(pair("0000-0000"))).toBe(404);
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId));
    expect(row).toBeUndefined();
  });

  test("a deployment without Cloudflare refuses to pair, and the code survives the refusal", async () => {
    const { tenantId, slug } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const { code } = await call(router.sap.pairingCode, undefined, { context: { headers: tenantHeaders(slug, owner.cookie) } });
    const domain = process.env.DOMAIN;
    process.env.DOMAIN = "confire.example";
    try {
      expect(await code404(pair(code))).toBe(503);
    } finally {
      process.env.DOMAIN = domain;
    }
    expect((await pair(code)).agentUrl).toBe("http://localhost:4123");
  });

  test("POST /api/agent/pair: the agent's route", async () => {
    const { tenantId } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const { code } = await call(router.sap.onboardingPairingCode, undefined, apex(owner.cookie));
    const app = agentRoutes();
    const post = (body: unknown) => app.request("/api/agent/pair", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ code })).status).toBe(400); // not a pairing request
    const ok = await post({ code, port: 4000, version: "dev", companyDb: "SBODEMO" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ agentUrl: "http://localhost:4000", tunnelToken: null });
    const again = await post({ code, port: 4000, version: "dev", companyDb: "SBODEMO" });
    expect([again.status, ((await again.json()) as { message: string }).message]).toEqual([404, "This pairing code is wrong or has expired. Create a new one in Confire."]);
    expect((await app.request("/download/confire-agent.exe")).status).toBe(404); // no build in dev
  });

  test("admins only; onboarding resolves the owner's workspace; members, customers and strangers can't", async () => {
    const { tenantId, slug } = await makeTenant();
    const member = await makeUser("member", tenantId);
    const customer = await makeUser();
    await makePortalSeat(tenantId, customer.userId, "owner");
    const stranger = await makeUser();
    expect(await code(call(router.sap.pairingCode, undefined, { context: { headers: tenantHeaders(slug, member.cookie) } }))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.agentStatus, undefined, { context: { headers: tenantHeaders(slug, member.cookie) } }))).toBe("FORBIDDEN");
    for (const u of [member, customer, stranger]) {
      expect(await code(call(router.sap.onboardingPairingCode, undefined, apex(u.cookie)))).toBe("FORBIDDEN");
      expect(await code(call(router.sap.onboardingAgentStatus, undefined, apex(u.cookie)))).toBe("FORBIDDEN");
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sap.agentStatus", () => {
  let agent: MockAgent;
  beforeAll(() => { agent = startMockAgent({}); });
  afterAll(() => agent.stop());

  test("not paired, then green once SAP answers through the agent, then the error when it is gone", async () => {
    const { tenantId } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const status = () => call(router.sap.onboardingAgentStatus, undefined, apex(owner.cookie));
    expect(await status()).toMatchObject({ paired: false, connected: false });

    // Paired in dev against the mock's port; the mock's secret is not pairing's, so put it back.
    const { code } = await call(router.sap.onboardingPairingCode, undefined, apex(owner.cookie));
    expect(await status()).toMatchObject({ paired: false, pairingPending: true });
    await pair(code, Number(new URL(agent.url).port));
    await upsertSapConnection(tenantId, { agentUrl: agent.url, secret: "test-agent-secret", companyDb: "SBODEMO" });
    const green = await status();
    expect(green).toMatchObject({
      paired: true, connected: true, version: "test", companyDb: agent.company.db,
      services: { b1: true, beas: false, print: ["Quotations"] }, updateAvailable: false, error: null, pairingPending: false,
    });
    expect(green.lastOkAt).toBeInstanceOf(Date);

    await upsertSapConnection(tenantId, { agentUrl: "http://127.0.0.1:9", secret: "x", companyDb: "SBODEMO" });
    const red = await status();
    expect(red).toMatchObject({ paired: true, connected: false });
    expect(red.error).toContain("Agent unreachable");
    expect((await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)))[0]).toMatchObject({ status: "error" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sap.lobby", () => {
  test("an owner without an agent row is asked for one; once paired, not again", async () => {
    const { tenantId, slug } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const ctx = apex(owner.cookie);
    expect(await call(router.sap.lobby, undefined, ctx)).toEqual({
      workspace: { slug, name: slug, url: appTenantUrl(slug), active: false, needsAgent: true }, portals: [],
    });
    await pair((await call(router.sap.onboardingPairingCode, undefined, ctx)).code);
    expect((await call(router.sap.lobby, undefined, ctx)).workspace?.needsAgent).toBe(false);
  });

  test("a member is sent on to the workspace even without an agent; a seat is never a workspace", async () => {
    const { tenantId, slug } = await makeTenant();
    const member = await makeUser("member", tenantId);
    const customer = await makeUser();
    await makePortalSeat(tenantId, customer.userId, "owner");
    const stranger = await makeUser();
    // No agent yet, but they couldn't pair one — so the workspace, not the agent step.
    expect((await call(router.sap.lobby, undefined, apex(member.cookie))).workspace).toMatchObject({ slug, needsAgent: false });
    expect(await call(router.sap.lobby, undefined, apex(customer.cookie))).toMatchObject({ workspace: null, portals: [{ slug }] });
    expect(await call(router.sap.lobby, undefined, apex(stranger.cookie))).toEqual({ workspace: null, portals: [] });
  });

  // The sign-in dispatcher's shapes (spec 2026-10-19-path-tenancy-design.md).
  test("lobby lists every portal seat, by supplier name, next to the workspace", async () => {
    const [a, b, c] = [await makeTenant(), await makeTenant(), await makeTenant()];
    await db.update(organization).set({ name: "Zeta" }).where(eq(organization.id, a.tenantId));
    await db.update(organization).set({ name: "Alpha" }).where(eq(organization.id, b.tenantId));
    const u = await makeUser("member", c.tenantId); // staff at C, customer of A and B (spec D3)
    await makePortalSeat(a.tenantId, u.userId, "owner", "A-Kunde");
    await makePortalSeat(b.tenantId, u.userId, "viewer", "B-Kunde");
    const lobby = await call(router.sap.lobby, undefined, apex(u.cookie));
    expect(lobby.workspace?.url).toBe(appTenantUrl(c.slug));
    expect(lobby.portals).toEqual([
      { slug: b.slug, tenantName: "Alpha", logo: null, cardName: "B-Kunde", role: "viewer", url: portalTenantUrl(b.slug), active: false },
      { slug: a.slug, tenantName: "Zeta", logo: null, cardName: "A-Kunde", role: "owner", url: portalTenantUrl(a.slug), active: false },
    ]);

    // The place the session last worked in is marked: where /login sends it back to.
    await call(portalRouter.me, undefined, { context: { headers: tenantHeaders(a.slug, u.cookie) } });
    const afterPortal = await call(router.sap.lobby, undefined, apex(u.cookie));
    expect(afterPortal.portals.filter((p) => p.active).map((p) => p.slug)).toEqual([a.slug]);
    expect(afterPortal.workspace?.active).toBe(false);
    await call(router.me, undefined, { context: { headers: tenantHeaders(c.slug, u.cookie) } });
    const afterApp = await call(router.sap.lobby, undefined, apex(u.cookie));
    expect(afterApp.workspace?.active).toBe(true);
    expect(afterApp.portals.some((p) => p.active)).toBe(false);

    const customer = await makeUser();
    await makePortalSeat(a.tenantId, customer.userId, "buyer");
    expect(await call(router.sap.lobby, undefined, apex(customer.cookie))).toMatchObject({ workspace: null, portals: [{ slug: a.slug }] });
  });

  test("a slug the path can't carry is refused on create and rename", async () => {
    const u = await makeUser();
    for (const slug of ["Acme", "app", "login", "files", "a.b", "a_b"]) {
      await expect(auth.api.createOrganization({ body: { name: slug, slug, userId: u.userId } })).rejects.toThrow("Invalid workspace URL");
    }
    const { tenantId } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const rename = (slug: string) =>
      auth.api.updateOrganization({
        body: { organizationId: tenantId, data: { slug } },
        headers: new Headers({ cookie: owner.cookie }),
      });
    await expect(rename("www")).rejects.toThrow("Invalid workspace URL");
    const ok = `r${crypto.randomUUID().slice(0, 8)}`;
    expect((await rename(ok))?.slug).toBe(ok);
  });

  test("createOrganization does not insert sap_connection", async () => {
    const u = await makeUser();
    const slug = `s${crypto.randomUUID().slice(0, 8)}`;
    await auth.api.createOrganization({ body: { name: slug, slug, userId: u.userId } });
    const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, org!.id)).limit(1);
    expect(row).toBeUndefined();
  });
});
