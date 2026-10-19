import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, organization, sapConnection } from "@confire/db";
import { auth } from "../src/auth.ts";
import { decryptSecret } from "../src/crypto.ts";
import { upsertSapConnection } from "../src/seed-agent.ts";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { appTenantUrl, portalTenantUrl } from "../src/tenant.ts";
import { call, makePortalSeat, makeTenant, makeUser, tenantHeaders } from "./harness.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
/** The sign-in host's calls: no workspace in the path, so no x-tenant. */
const apex = (cookie: string) => ({ context: { headers: new Headers({ cookie }) } });

describe.skipIf(!process.env.DATABASE_URL)("upsertSapConnection", () => {
  test("encrypts the secret and upserts Access/Beas", async () => {
    const { tenantId } = await makeTenant();
    await upsertSapConnection(tenantId, {
      agentUrl: "http://localhost:4000",
      secret: "plain-secret",
      accessClientId: "cf-id",
      accessClientSecret: "cf-secret",
      beasEnabled: true,
    });
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    expect(row).toBeDefined();
    expect(row!.agentUrl).toBe("http://localhost:4000");
    expect(row!.secret).not.toBe("plain-secret");
    expect(decryptSecret(row!.secret)).toBe("plain-secret");
    expect(row!.accessClientId).toBe("cf-id");
    expect(row!.accessClientSecret).toBe("cf-secret");
    expect(row!.beasEnabled).toBe(true);
  });

  test("a second call updates agentUrl", async () => {
    const { tenantId } = await makeTenant();
    await upsertSapConnection(tenantId, { agentUrl: "http://localhost:4000", secret: "a" });
    await upsertSapConnection(tenantId, { agentUrl: "https://agent.example", secret: "b" });
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    expect(row!.agentUrl).toBe("https://agent.example");
    expect(decryptSecret(row!.secret)).toBe("b");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("sap.connect / sap.lobby", () => {
  test("owner on apex writes the row; lobby stops asking for an agent", async () => {
    const { tenantId, slug } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const ctx = apex(owner.cookie);

    expect(await call(router.sap.lobby, undefined, ctx)).toEqual({
      workspace: { slug, name: slug, url: appTenantUrl(slug), active: false, needsAgent: true }, portals: [],
    });

    await call(router.sap.connect, {
      agentUrl: "http://localhost:4000",
      secret: "from-ui",
      accessClientId: "aid",
      accessClientSecret: "asec",
      beasEnabled: true,
    }, ctx);

    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    expect(row!.secret).not.toBe("from-ui");
    expect(decryptSecret(row!.secret)).toBe("from-ui");
    expect(row!.accessClientId).toBe("aid");
    expect(row!.accessClientSecret).toBe("asec");
    expect(row!.beasEnabled).toBe(true);
    expect((await call(router.sap.lobby, undefined, ctx)).workspace?.needsAgent).toBe(false);
  });

  test("second connect updates agentUrl", async () => {
    const { tenantId } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const ctx = apex(owner.cookie);
    await call(router.sap.connect, { agentUrl: "http://localhost:4000", secret: "s1" }, ctx);
    await call(router.sap.connect, { agentUrl: "https://agent.example", secret: "s2" }, ctx);
    const [row] = await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1);
    expect(row!.agentUrl).toBe("https://agent.example");
  });

  test("member, customer and non-member can't connect; lobby sends them on", async () => {
    const { tenantId, slug } = await makeTenant();
    const member = await makeUser("member", tenantId);
    const customer = await makeUser();
    await makePortalSeat(tenantId, customer.userId, "owner");
    const stranger = await makeUser();
    const body = { agentUrl: "http://localhost:4000", secret: "x" };
    expect(await code(call(router.sap.connect, body, apex(member.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connect, body, apex(customer.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connect, body, apex(stranger.cookie)))).toBe("FORBIDDEN");
    // No agent yet, but they couldn't connect one — so the workspace, not the agent form.
    expect((await call(router.sap.lobby, undefined, apex(member.cookie))).workspace).toMatchObject({ slug, needsAgent: false });
    // A seat is a membership too, but never a workspace.
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

describe.skipIf(!process.env.DATABASE_URL)("sap.agent / sap.reconfigure", () => {
  test("blank secrets keep, filled ones rotate, no client ID clears Access; admins only", async () => {
    const { tenantId, slug } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const member = await makeUser("member", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, owner.cookie) } };
    const read = async () =>
      (await db.select().from(sapConnection).where(eq(sapConnection.tenantId, tenantId)).limit(1))[0]!;
    await upsertSapConnection(tenantId, {
      agentUrl: "http://localhost:4000", secret: "s1", accessClientId: "aid", accessClientSecret: "asec",
    });

    await call(router.sap.reconfigure, { agentUrl: "https://agent.example", accessClientId: "aid", beasEnabled: true }, ctx);
    let row = await read();
    expect(row.agentUrl).toBe("https://agent.example");
    expect(decryptSecret(row.secret)).toBe("s1");
    expect(row.accessClientSecret).toBe("asec");
    expect(await call(router.sap.agent, undefined, ctx))
      .toEqual({ agentUrl: "https://agent.example", accessClientId: "aid", beasEnabled: true });

    await call(router.sap.reconfigure, { agentUrl: "https://agent.example", secret: "s2", accessClientId: null, beasEnabled: false }, ctx);
    row = await read();
    expect(decryptSecret(row.secret)).toBe("s2");
    expect(row.accessClientId).toBeNull();
    expect(row.accessClientSecret).toBeNull();

    const asMember = { context: { headers: tenantHeaders(slug, member.cookie) } };
    expect(await code(call(router.sap.agent, undefined, asMember))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.reconfigure, { agentUrl: "https://x.example", accessClientId: null, beasEnabled: false }, asMember)))
      .toBe("FORBIDDEN");
  });
});
