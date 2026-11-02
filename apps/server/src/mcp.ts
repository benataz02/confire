import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import * as Sentry from "@sentry/bun";
import { requireMcpAuth } from "@better-auth/mcp";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { createMCPServer } from "@tanstack/ai-mcp/server";
import { assistantSettings, db, organization } from "@confire/db";
import { auth, TENANT_CLAIM } from "./auth.ts";
import { membershipOf } from "./orpc/base.ts";
import { mcpUrl, TENANT_HEADER } from "./tenant.ts";
import { mcpTools, type CallCtx } from "./assistant/tools.ts";
import { rateLimit } from "./assistant/usage.ts";
import { langOf, t, withLang } from "./i18n/index.ts";

// MCP (assistant spec §4.10): the user's own Claude or ChatGPT calls the chat's tools as the user.
// Better Auth is the authorization server (auth.ts `mcp()`): the bearer JWT says who (`sub`) and which
// workspace (`tenant`, the consent's reference). Every call still goes through the procedures'
// builders, so the membership join stays the tenant boundary, read live here and on every tool call.
// Staff process only, on its own host (`mcpUrl`: `mcp.<DOMAIN>`, dev `mcp.localhost`): there the
// endpoint is `/` and the protected-resource document is at the root's /.well-known.

/** What one MCP request hands its tool calls (createMCPServer's `ctx.context`). */
type McpContext = { headers: Headers; mcpUserId: string };

const callCtx = (call: unknown): CallCtx => {
  const c = (call as { context: McpContext }).context;
  // The chat's window, shared: one user's AI cannot outrun the in-app assistant's limit.
  rateLimit(c.mcpUserId);
  return { headers: c.headers, mcpUserId: c.mcpUserId };
};

const server = createMCPServer({
  name: "confire",
  version: process.env.SENTRY_RELEASE ?? "dev",
  tools: mcpTools(callCtx),
  // Spec 2025 clients elicit (confirm a write) only on an open session; one staff process holds them.
  // ponytail: in-memory sessions (30 idle minutes); a shared store if the staff process ever scales out.
  sessions: "memory",
  onerror: (e) => Sentry.captureException(e),
});

/** A refusal before the handshake, as a JSON-RPC error the client can show. */
const refuse = (status: number, code: string, message: string) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message, data: { code } } }, { status });

const serveMcp: Parameters<typeof requireMcpAuth>[1] = async (request, claims) => {
  const userId = claims.sub;
  const tenantId = claims[TENANT_CLAIM];
  if (!userId || typeof tenantId !== "string") return refuse(401, "UNAUTHORIZED", t("NOT_A_MEMBER"));
  const [org] = await db.select({ slug: organization.slug, mcp: assistantSettings.mcp })
    .from(organization).leftJoin(assistantSettings, eq(assistantSettings.tenantId, organization.id))
    .where(eq(organization.id, tenantId)).limit(1);
  if (!org?.slug) return refuse(403, "FORBIDDEN", t("NOT_A_MEMBER"));
  try {
    await membershipOf(org.slug, userId);
  } catch (e) {
    if (e instanceof ORPCError) return refuse(403, e.code, e.message);
    throw e;
  }
  if (!org.mcp) return refuse(403, "MCP_OFF", t("MCP_OFF"));
  // The workspace is the token's, never the request's: these headers are all a tool call sees.
  const headers = new Headers({ [TENANT_HEADER]: org.slug });
  const lang = request.headers.get("accept-language");
  if (lang) headers.set("accept-language", lang);
  const context: McpContext = { headers, mcpUserId: userId };
  return server.handle(request, {
    // Spec 2025 sessions belong to (clientId, sub), so another token cannot resume this one's.
    authInfo: {
      token: request.headers.get("authorization")?.replace(/^\S+\s+/, "") ?? "",
      clientId: String(claims.azp ?? claims.client_id ?? ""),
      scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
      ...(typeof claims.exp === "number" ? { expiresAt: claims.exp } : {}),
      extra: { sub: userId },
    },
    context,
  });
};

// requireMcpAuth builds its verifier per request anyway; PORT is read then (tests serve on their own).
const handle = (request: Request) => requireMcpAuth(auth, serveMcp, {
  resource: mcpUrl,
  // Its own JWKS over loopback: the public name may not resolve from inside the container.
  jwksUrl: `http://127.0.0.1:${process.env.PORT || 3000}/api/auth/jwks`,
})(request);

const MCP_HOST = new URL(mcpUrl).hostname;

/** Whether a request is for the MCP host. index.ts sends those here before the staff app sees them. */
export const isMcpHost = (req: Request) => new URL(req.url).hostname === MCP_HOST;

/** The MCP host is nothing but MCP: the endpoint, and the RFC 9728 protected-resource document, which
 *  Better Auth answers itself (the mcp() plugin's onRequest). Never the SPA, /rpc or a cookie route. */
export const mcpHost = new Hono()
  // MCP clients are servers and CLIs, which send no Origin; a browser page's request (DNS rebinding,
  // spec "Security Warning") carries one, and is refused.
  .use("*", async (c, next) => (c.req.header("origin") ? c.text("Forbidden origin", 403) : next()))
  .use("*", (c, next) => withLang(langOf(c.req.header("accept-language")), next))
  .get("/.well-known/oauth-protected-resource", (c) => auth.handler(c.req.raw))
  // As /rpc (serve.ts): a tool call is JSON, never a file.
  .on(["GET", "POST", "DELETE"], "/", bodyLimit({ maxSize: 2 * 1024 * 1024 }), (c) => handle(c.req.raw));

/** The authorization server's discovery, on the staff app's host (the issuer's). */
export function oauthDiscoveryRoutes() {
  const app = new Hono();
  // The authorization server's two documents, on the issuer's host (the staff app): server-only
  // endpoints in Better Auth, served here at the RFC 8414 issuer-inserted paths.
  const authServer = oauthProviderAuthServerMetadata(auth);
  const openId = oauthProviderOpenIdConfigMetadata(auth);
  app.get("/.well-known/oauth-authorization-server", (c) => authServer(c.req.raw));
  app.get("/.well-known/oauth-authorization-server/*", (c) => authServer(c.req.raw));
  app.get("/.well-known/openid-configuration", (c) => openId(c.req.raw));
  app.get("/.well-known/openid-configuration/*", (c) => openId(c.req.raw));
  return app;
}
