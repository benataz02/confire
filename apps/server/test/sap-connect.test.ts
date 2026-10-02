import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, organization, sapConnection } from "@confire/db";
import { auth } from "../src/auth.ts";
import { decryptSecret } from "../src/crypto.ts";
import { upsertSapConnection } from "../src/seed-agent.ts";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser } from "./harness.ts";

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");
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

describe.skipIf(!process.env.DATABASE_URL)("sap.connect / sap.connection", () => {
  test("owner on apex writes the row; connection flips false → true", async () => {
    const { tenantId } = await makeTenant();
    const owner = await makeUser("owner", tenantId);
    const ctx = apex(owner.cookie);

    expect(await call(router.sap.connection, undefined, ctx)).toEqual({ connected: false });

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
    expect(await call(router.sap.connection, undefined, ctx)).toEqual({ connected: true });
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

  test("member, client, and non-member are FORBIDDEN", async () => {
    const { tenantId } = await makeTenant();
    const member = await makeUser("member", tenantId);
    const client = await makeUser("client", tenantId);
    const stranger = await makeUser();
    const body = { agentUrl: "http://localhost:4000", secret: "x" };
    expect(await code(call(router.sap.connect, body, apex(member.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connection, undefined, apex(member.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connect, body, apex(client.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connection, undefined, apex(client.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connect, body, apex(stranger.cookie)))).toBe("FORBIDDEN");
    expect(await code(call(router.sap.connection, undefined, apex(stranger.cookie)))).toBe("FORBIDDEN");
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
