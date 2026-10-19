// The tenant is the first segment of the page's path: `app.confire.ai/<slug>/…` for staff,
// `portal.confire.ai/<slug>/…` for a supplier's customers (spec 2026-10-19-path-tenancy-design.md).
// The SPA sends that slug on every call as the `x-tenant` header, and in the path of the plain file
// routes. This is the only place a slug is read off a request; the membership join behind it
// (orpc/base.ts, portal/orpc/base.ts) is the boundary.
import assert from "node:assert/strict";

/** Never a workspace slug: the staff SPA's own top-level pages, the server's routes, and a few names
 *  kept back. Mirrored in @confire/ui/host.ts, which decides what a path's first segment means. */
const RESERVED = new Set([
  "login", "signup", "forgot-password", "reset-password", "onboarding",
  "api", "rpc", "files", "assets",
  "app", "portal", "www", "auth", "admin", "static",
]);

export const TENANT_HEADER = "x-tenant";

/** The one deployment setting, compose's `DOMAIN` (`confire.ai`): the staff app — which is also the
 *  sign-in host — on `https://app.<domain>`, the portal on `https://portal.<domain>`, the session
 *  cookie on `<domain>` so it reaches both, Confire's mail from `mail.<domain>`. Unset, it is dev:
 *  `http://localhost:5173` and `http://localhost:5180`, and a host-only cookie on `localhost`, which
 *  the browser sends to both ports. The SPAs read the same rule off their own location (host.ts). */
const domain = process.env.DOMAIN?.trim().toLowerCase() || undefined;

/** The staff app's origin and the sign-in host: Better Auth's baseURL, so its OAuth callbacks and
 *  every mailed link. */
export const authUrl = domain ? `https://app.${domain}` : "http://localhost:5173";

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
  assert.equal(tenantSlug("acme"), "acme");
  assert.equal(tenantSlug("acme-2"), "acme-2");
  assert.equal(tenantSlug("ACME"), null); // the client sends what the URL holds, lowercased by the slug rule
  assert.equal(tenantSlug("login"), null); // reserved: a staff SPA page
  assert.equal(tenantSlug("files"), null); // reserved: a server route
  assert.equal(tenantSlug("a.b"), null);
  assert.equal(tenantSlug("a/b"), null);
  assert.equal(tenantSlug(""), null);
  assert.equal(tenantSlug(null), null);
  assert.equal(appTenantUrl("acme"), `${authUrl}/acme/`);
  assert.equal(portalTenantUrl("acme", "/accept/x"), `${portalUrl}/acme/accept/x`);
  assert.equal(portalTenantUrl("acme", "projects"), `${portalUrl}/acme/projects`);
  console.log("tenant.ts ok");
}
