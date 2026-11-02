import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { assistantSettings, configModel, configProjectEvent, db, member } from "@confire/db";
import { createMCPClient } from "@tanstack/ai-mcp";
import type { AnyServerTool } from "@tanstack/ai";
import { auth, TENANT_CLAIM } from "../src/auth.ts";
import { mcpUrl, TENANT_HEADER } from "../src/tenant.ts";
import { MCP_TOOL_NAMES, mcpTools, proposalMessage } from "../src/assistant/tools.ts";
import { makeTenant, makeUser, TEST_MODEL, call, tenantHeaders } from "./harness.ts";
import { router } from "../src/orpc/router.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// MCP (assistant spec §4.10): the bearer token's user and workspace, the switch, the tool surface, and
// the approval path — no SAP write without the user's accept.

// The tool surface is code: it holds without a database.
test("the MCP tool set is the chat's, less the thread's, plus the confirmed writes — never b1.post", () => {
  const names = mcpTools(() => ({ headers: new Headers() })).map((t) => t.name);
  expect(names).toEqual([...MCP_TOOL_NAMES]);
  for (const n of ["b1_post", "ask_user", "read_request", "extract_values", "propose_quotation", "models_save"]) expect(names).not.toContain(n);
  const destructive = mcpTools(() => ({ headers: new Headers() }))
    .filter((t) => (t.metadata as { annotations?: { destructiveHint?: boolean } } | undefined)?.annotations?.destructiveHint)
    .map((t) => t.name);
  expect(destructive).toEqual(["b1_write", "b1_copy", "post_quotation"]);
});

test("a proposal's confirmation is built from what will post: before → after per field", () => {
  expect(proposalMessage({
    op: "update", entity: "Orders", key: 5, etag: "e", payload: { Comments: "new" },
    changes: { Comments: { before: "old", after: "new" } }, title: "Change Orders 905",
  })).toBe("Change Orders 905 — post to SAP?\n• Comments: old → new");
});

const EDMX = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
<edmx:DataServices><Schema Namespace="SAPB1" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <ComplexType Name="DocumentLine">
    <Property Name="LineNum" Type="Edm.Int32"/><Property Name="ItemCode" Type="Edm.String"/>
    <Property Name="Quantity" Type="Edm.Double"/><Property Name="Price" Type="Edm.Double"/>
  </ComplexType>
  <EntityType Name="Document"><Key><PropertyRef Name="DocEntry"/></Key>
    <Property Name="DocEntry" Type="Edm.Int32"/><Property Name="DocNum" Type="Edm.Int32"/>
    <Property Name="CardCode" Type="Edm.String"/><Property Name="CardName" Type="Edm.String"/>
    <Property Name="Comments" Type="Edm.String"/><Property Name="DocTotal" Type="Edm.Double"/>
    <Property Name="DocumentLines" Type="Collection(SAPB1.DocumentLine)"/>
  </EntityType>
  <EntityContainer Name="ServiceLayer"><EntitySet Name="Orders" EntityType="SAPB1.Document"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

describe.skipIf(!process.env.DATABASE_URL)("mcp", () => {
  let agent: MockAgent;
  let srv: ReturnType<typeof Bun.serve>;
  let endpoint: string;
  beforeAll(async () => {
    agent = startMockAgent();
    agent.metadata.xml = EDMX;
    // requireMcpAuth reads the JWKS over loopback on PORT (mcp.ts): serve the staff app there.
    process.env.PORT = String(40000 + Math.floor(Math.random() * 10000));
    const app = (await import("../src/index.ts")).default;
    srv = Bun.serve({ port: Number(process.env.PORT), fetch: app.fetch });
    // The MCP host is its own (mcpUrl, mcp.localhost in dev and here): *.localhost is loopback.
    endpoint = `http://${new URL(mcpUrl).hostname}:${srv.port}/`;
  });
  afterAll(() => { srv?.stop(true); agent?.stop(); });

  async function world(o: { mcp?: boolean } = {}) {
    const { tenantId, slug } = await makeTenant();
    const u = await makeUser("member", tenantId);
    await db.insert(assistantSettings).values({ tenantId, mcp: o.mcp ?? true });
    await connectTenant(tenantId, agent);
    return { tenantId, slug, u };
  }
  // As the OAuth provider signs an access token: its issuer is the auth base URL (getIssuer).
  const token = async (sub: string, tenant: string, aud = mcpUrl) => (await auth.api.signJWT({
    body: { payload: { sub, azp: "test-client", [TENANT_CLAIM]: tenant, aud, scope: "openid" }, overrideOptions: { jwt: { issuer: (await auth.$context).baseURL } } },
  })).token;
  const post = (bearer: string | null, body: unknown, extra: Record<string, string> = {}) => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
  const client = (bearer: string, extra: Record<string, string> = {}) =>
    createMCPClient({ transport: { type: "http", url: endpoint, headers: { authorization: `Bearer ${bearer}`, ...extra } } });
  const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  test("no token or another audience's: 401 with the protected-resource challenge", async () => {
    const res = await post(null, LIST);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    const w = await world();
    expect((await post(await token(w.u.userId, w.tenantId, "https://elsewhere.example"), LIST)).status).toBe(401);
  });

  test("the MCP host is only MCP: no SPA, no /rpc, and a browser Origin is refused", async () => {
    expect((await fetch(new URL("/rpc/me", endpoint), { method: "POST" })).status).toBe(404);
    expect((await fetch(new URL("/login", endpoint))).status).toBe(404);
    expect((await post(null, LIST, { origin: "http://evil.localhost" })).status).toBe(403);
  });

  test("discovery: the protected resource names its authorization server", async () => {
    const res = await fetch(new URL("/.well-known/oauth-protected-resource", endpoint));
    expect(res.status).toBe(200);
    const doc = await res.json() as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe(mcpUrl);
    // Clients send `resource` back as a parsed URL's href; Better Auth matches it exactly.
    expect(new URL(doc.resource).href).toBe(doc.resource);
    expect(doc.authorization_servers.length).toBe(1);
  });

  test("the switch off, or a user no longer staff of the token's workspace: 403 before the handshake", async () => {
    const off = await world({ mcp: false });
    const r1 = await post(await token(off.u.userId, off.tenantId), LIST);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ error: { data: { code: "MCP_OFF" } } });

    const w = await world();
    const tok = await token(w.u.userId, w.tenantId);
    await db.delete(member).where(eq(member.userId, w.u.userId)); // removed after the token was issued
    expect((await post(tok, LIST)).status).toBe(403);
  });

  test("tools reach the token's workspace only, whatever x-tenant the request sends", async () => {
    const a = await world();
    const b = await world();
    // B has a model, A has none: what configs_models answers says whose workspace the call ran in.
    await db.insert(configModel).values({ tenantId: b.tenantId, name: "Brackets of B", definition: { ...TEST_MODEL, name: "Brackets of B" } });
    // A's token, B's slug in x-tenant: the token decides.
    const c = await client(await token(a.u.userId, a.tenantId), { [TENANT_HEADER]: b.slug });
    try {
      const listed = (await c.tools()).map((t) => t.name).sort();
      expect(listed).toEqual([...MCP_TOOL_NAMES].sort());
      const out = await c.callTool("configs_models", {}) as { content: { text: string }[]; isError?: boolean };
      expect(out.isError).toBeFalsy();
      expect(out.content[0]!.text).not.toContain("Brackets of B");
    } finally {
      await c.close?.();
    }
  });

  test("the OAuth flow end to end: register, authorize, consent, token — the token names the user's workspace", async () => {
    const w = await world();
    const base = `http://127.0.0.1:${srv.port}/api/auth`;
    const cookie = w.u.cookie;
    const reg = await fetch(`${base}/oauth2/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test AI", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    expect(reg.status).toBeLessThan(300);
    const { client_id } = await reg.json() as { client_id: string };

    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const authorize = new URL(`${base}/oauth2/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: "https://client.example/cb", scope: "openid offline_access", state: "s1", code_challenge: challenge, code_challenge_method: "S256", resource: mcpUrl }))
      authorize.searchParams.set(k, v);
    const toConsent = await fetch(authorize, { headers: { cookie }, redirect: "manual" });
    const consentAt = new URL(toConsent.headers.get("location")!, "http://x");
    expect(consentAt.pathname).toBe("/oauth/consent");
    const query = consentAt.search.slice(1);

    // What the consent page shows: read off the signed query, and the user's workspace.
    const shown = await call(router.sap.oauthConsent, { query }, { context: { headers: new Headers({ cookie }) } });
    expect(shown).toMatchObject({ client: { name: "Test AI" }, workspace: { slug: w.slug } });
    expect(await call(router.sap.oauthConsent, { query: query.replace("state=s1", "state=s2") }, { context: { headers: new Headers({ cookie }) } }).catch((e) => e.code)).toBe("BAD_REQUEST");

    const consent = await fetch(`${base}/oauth2/consent`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ accept: true, oauth_query: query }),
    });
    const back = new URL(((await consent.json()) as { url: string }).url);
    expect(back.origin + back.pathname).toBe("https://client.example/cb");
    const tok = await fetch(`${base}/oauth2/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: "https://client.example/cb", client_id, code_verifier: verifier, resource: mcpUrl }),
    });
    const { access_token } = await tok.json() as { access_token: string };
    const claims = JSON.parse(Buffer.from(access_token.split(".")[1]!, "base64url").toString());
    expect(claims).toMatchObject({ sub: w.u.userId, [TENANT_CLAIM]: w.tenantId, azp: client_id });
    expect(claims.aud).toContain(mcpUrl); // with the userinfo endpoint, for the openid scope

    const c = await client(access_token);
    try {
      expect((await c.tools()).length).toBe(MCP_TOOL_NAMES.length);
    } finally {
      await c.close?.();
    }
  });

  test("no staff membership (a portal customer, or nobody's staff): no consent, so no token", async () => {
    const base = `http://127.0.0.1:${srv.port}/api/auth`;
    const outsider = await makeUser(); // signed in, staff of no workspace
    const reg = await fetch(`${base}/oauth2/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test AI", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
    });
    const { client_id } = await reg.json() as { client_id: string };
    const authorize = new URL(`${base}/oauth2/authorize`);
    for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri: "https://client.example/cb", scope: "openid", state: "s", code_challenge: "x".repeat(43), code_challenge_method: "S256", resource: mcpUrl }))
      authorize.searchParams.set(k, v);
    const res = await fetch(authorize, { headers: { cookie: outsider.cookie }, redirect: "manual" });
    const to = res.headers.get("location");
    expect(to === null || !new URL(to, "http://x").pathname.startsWith("/oauth/consent")).toBe(true);
    if (to) expect(new URL(to, "http://x").searchParams.get("code")).toBeNull();
  });

  // The approval path, on the tools themselves: what the MCP client's confirmation answers decides.
  describe("SAP writes ask first", () => {
    const order = () => ({
      DocEntry: 5, DocNum: 905, CardCode: "C1", CardName: "ACME", Comments: "old", DocTotal: 10, DocumentStatus: "bost_Open",
      "@odata.etag": 'W/"1"', DocumentLines: [{ LineNum: 0, ItemCode: "A", Quantity: 2, Price: 5 }],
    });
    const tool = (name: string) => mcpTools((c) => (c as { context: { headers: Headers; mcpUserId: string } }).context)
      .find((t) => t.name === name) as AnyServerTool & { execute: (i: unknown, c: unknown) => Promise<any> };
    const asks: string[] = [];
    const run = (w: { slug: string; u: { userId: string } }, answer: "accept" | "decline" | "none") => ({
      context: {
        headers: new Headers({ [TENANT_HEADER]: w.slug }),
        mcpUserId: w.u.userId,
        ...(answer === "none" ? {} : {
          requestInput: async (r: { message: string }) => {
            asks.push(r.message);
            if (answer === "decline") throw new Error("The user did not accept the input request.");
            return {};
          },
        }),
      },
    });

    test("b1_write: nothing posts on a decline, even with auto mode on; an accept posts exactly the proposal", async () => {
      agent.store.Orders = [order()];
      const w = await world();
      // Auto mode fully on: over MCP it still asks.
      await db.update(assistantSettings).set({ assistant: true, b1AutoWrite: true }).where(eq(assistantSettings.tenantId, w.tenantId));
      await call(router.views.setState, { key: "assistant:autoWrite", value: true }, { context: { headers: tenantHeaders(w.slug, w.u.cookie) } });
      const write = tool("b1_write");
      const input = { entity: "Orders", key: 5, data: { Comments: "new" } };

      expect(await write.execute(input, run(w, "decline"))).toEqual({ posted: false, note: "Not posted: the user declined." });
      expect(agent.store.Orders![0]!.Comments).toBe("old");
      expect(asks.at(-1)).toContain("Comments: old → new");

      expect(await write.execute(input, run(w, "none"))).toMatchObject({ posted: false });
      expect(agent.store.Orders![0]!.Comments).toBe("old");

      expect(await write.execute(input, run(w, "accept"))).toMatchObject({ written: { entity: "Orders", key: 5 } });
      expect(agent.store.Orders![0]!.Comments).toBe("new");
    });

    test("configs_create over MCP is marked on the timeline", async () => {
      const w = await world();
      const [m] = await db.insert(configModel).values({ tenantId: w.tenantId, name: "M", definition: TEST_MODEL }).returning({ id: configModel.id });
      const created = await tool("configs_create").execute({ modelId: m!.id, name: "Via MCP" }, run(w, "none")) as { id: string };
      const [ev] = await db.select().from(configProjectEvent).where(eq(configProjectEvent.projectId, created.id));
      expect(ev!.payload).toEqual({ via: "mcp" });
    });
  });
});
