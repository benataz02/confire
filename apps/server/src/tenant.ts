// The tenant is the first segment of the page's path: `app.confire.ai/<slug>/…` for staff,
// `portal.confire.ai/<slug>/…` for a supplier's customers (spec 2026-10-19-path-tenancy-design.md).
// The SPA sends that slug on every call as the `x-tenant` header, and in the path of the plain file
// routes. This is the only place a slug is read off a request; the membership join behind it
// (orpc/base.ts, portal/orpc/base.ts) is the boundary.
import assert from "node:assert/strict";

/** Never a workspace slug: the staff SPA's own top-level pages, the server's routes, a few names
 *  kept back, and the mail names — a tenant's client mail goes out as `<slug>@mail.<domain>`, so a
 *  slug may not be Confire's own sender or a role address. Mirrored in @confire/ui/host.ts, which
 *  decides what a path's first segment means. */
const RESERVED = new Set([
  "login", "signup", "forgot-password", "reset-password", "onboarding",
  "api", "rpc", "files", "assets", "download", "oauth", "mcp",
  "app", "portal", "www", "auth", "admin", "static",
  "notify", "noreply", "no-reply", "postmaster", "abuse", "hostmaster", "webmaster", "security", "mailer-daemon",
]);

export const TENANT_HEADER = "x-tenant";

/** The one deployment setting, compose's `DOMAIN` (`confire.ai`): the staff app — which is also the
 *  sign-in host — on `https://app.<domain>`, the portal on `https://portal.<domain>`, the session
 *  cookie on `<domain>` so it reaches both, Confire's mail from `mail.<domain>`. Unset or `localhost`, it is dev:
 *  `http://localhost:5173` and `http://localhost:5180`, and a host-only cookie on `localhost`, which
 *  the browser sends to both ports. The SPAs read the same rule off their own location (host.ts). */
export const domainOf = (raw: string | undefined): string | undefined => {
  const d = raw?.trim().toLowerCase();
  // `localhost` (any port) is dev too: there is no app./portal. under it, and Google refuses an OAuth
  // redirect to anything but plain http://localhost.
  return d && !/^localhost(:\d+)?$/.test(d) ? d : undefined;
};
const domain = domainOf(process.env.DOMAIN);

/** The staff app's origin and the sign-in host: Better Auth's baseURL, so its OAuth callbacks and
 *  every mailed link. */
export const authUrl = domain ? `https://app.${domain}` : "http://localhost:5173";

/** The MCP connector address (assistant spec §4.10), one for every workspace, and the token audience:
 *  its own host, served by the staff process (mcp.ts routes on the host). Dev is `http://mcp.localhost`
 *  — `*.localhost` is loopback, and OAuth allows plain http there — which `bun run dev` forwards from
 *  port 80 to the staff server (scripts/dev-mcp.ts). The trailing slash is load-bearing: clients send
 *  `resource` as `new URL(<the PRM's resource>).href`, which always has it, and Better Auth matches the
 *  identifier exactly — without it, authorize answers "invalid_target: … is not configured". */
export const mcpUrl = domain ? `https://mcp.${domain}/` : "http://mcp.localhost/";

/** The customer portal's origin. */
export const portalUrl = domain ? `https://portal.${domain}` : "http://localhost:5180";

/** The session cookie's domain; undefined = host-only. */
export const cookieDomain = domain;

/** Confire's own domain: every name under it is the platform's, never a tenant's. */
export const platformDomain = domain ?? "localhost";

/** A slug as a request carries it, or null: one lowercase label, not reserved. */
export function tenantSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^[a-z0-9-]+$/.test(value) && !RESERVED.has(value) ? value : null;
}

const tenantUrl = (origin: string, slug: string, path: string) => `${origin}/${slug}${path.startsWith("/") ? path : `/${path}`}`;

/** A workspace page: `<authUrl>/<slug><path>`. */
export const appTenantUrl = (slug: string, path = "/") => tenantUrl(authUrl, slug, path);

/** A supplier's portal page: `<portalUrl>/<slug><path>`. */
export const portalTenantUrl = (slug: string, path = "/") => tenantUrl(portalUrl, slug, path);

// ponytail: assert-based self-check — `bun apps/server/src/tenant.ts`.
if (import.meta.main) {
  assert.equal(domainOf("confire.ai"), "confire.ai");
  assert.equal(domainOf(" Confire.AI "), "confire.ai");
  assert.equal(domainOf("localhost"), undefined); // dev, like unset
  assert.equal(domainOf("localhost:5173"), undefined);
  assert.equal(domainOf(""), undefined);
  assert.equal(domainOf(undefined), undefined);
  assert.equal(tenantSlug("acme"), "acme");
  assert.equal(tenantSlug("acme-2"), "acme-2");
  assert.equal(tenantSlug("ACME"), null); // the client sends what the URL holds, lowercased by the slug rule
  assert.equal(tenantSlug("login"), null); // reserved: a staff SPA page
  assert.equal(tenantSlug("files"), null); // reserved: a server route
  assert.equal(tenantSlug("download"), null); // reserved: the agent's download
  assert.equal(tenantSlug("notify"), null); // reserved: Confire's own sender
  assert.equal(tenantSlug("postmaster"), null); // reserved: a role address
  assert.equal(tenantSlug("a.b"), null);
  assert.equal(tenantSlug("a/b"), null);
  assert.equal(tenantSlug(""), null);
  assert.equal(tenantSlug(null), null);
  assert.equal(appTenantUrl("acme"), `${authUrl}/acme/`);
  assert.equal(portalTenantUrl("acme", "/accept/x"), `${portalUrl}/acme/accept/x`);
  assert.equal(portalTenantUrl("acme", "projects"), `${portalUrl}/acme/projects`);
  console.log("tenant.ts ok");
}
