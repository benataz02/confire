// Tenant slug lives in the request host: `<slug>.<baseDomain>`. The apex (and a few
// reserved labels) carry no tenant. This is the only place the host is parsed server-side.
import assert from "node:assert/strict";

const RESERVED = new Set(["app", "www", "api", "auth", "admin", "static", "assets"]);

/** Prod sets APP_BASE_DOMAIN (e.g. `app.confire.ai`). Dev is `app.lvh.me`: public DNS sends lvh.me
 *  and every subdomain, at any depth, to 127.0.0.1, a `.app.lvh.me` cookie spans subdomains (bare
 *  `localhost` is a TLD to the browser), and Google accepts its OAuth redirect URI.
 *  `confire.localhost` was tried: the cookie works, but Google rejects `http://*.localhost` redirect
 *  URIs. Not bare `lvh.me` either: its cookie would reach the portal's sibling zone. */
export const baseDomain = (process.env.APP_BASE_DOMAIN ?? "app.lvh.me").toLowerCase();

/** The portal process's zone (spec §3), a sibling of baseDomain, never a child: a `.app.<domain>`
 *  session cookie must never be sent to `*.portal.<domain>`, and the other way round. */
export const portalBaseDomain = (process.env.PORTAL_BASE_DOMAIN ?? "portal.lvh.me").toLowerCase();

/** `acme.app.lvh.me` + base `app.lvh.me` -> "acme"; apex/reserved/deeper -> null. */
export function tenantSlugFromHost(
  host: string | null | undefined,
  baseDomain: string,
): string | null {
  if (!host) return null;
  const name = host.split(":")[0]!.toLowerCase(); // drop port
  const base = baseDomain.toLowerCase();
  if (name === base) return null; // apex
  const suffix = `.${base}`;
  if (!name.endsWith(suffix)) return null;
  const label = name.slice(0, -suffix.length);
  if (!/^[a-z0-9-]+$/.test(label)) return null; // single label only (no deeper subdomains)
  return RESERVED.has(label) ? null : label;
}

// ponytail: assert-based self-check — `bun apps/server/src/tenant.ts`.
if (import.meta.main) {
  const t = (h: string | null, b: string) => tenantSlugFromHost(h, b);
  assert.equal(t("acme.confire.local", "confire.local"), "acme");
  assert.equal(t("acme.localhost:5173", "localhost"), "acme");
  assert.equal(t("ACME.Confire.Local", "confire.local"), "acme");
  assert.equal(t("confire.local", "confire.local"), null); // apex
  assert.equal(t("localhost:3000", "localhost"), null); // apex
  assert.equal(t("app.confire.local", "confire.local"), null); // reserved
  assert.equal(t("a.b.confire.local", "confire.local"), null); // deeper subdomain
  assert.equal(t("acme.evil.com", "confire.local"), null); // wrong base
  assert.equal(t(null, "confire.local"), null);
  // Two sibling zones (spec §3): each process parses only its own, and neither swallows the other.
  assert.equal(t("acme.app.lvh.me:5173", "app.lvh.me"), "acme");
  assert.equal(t("acme.portal.lvh.me:5174", "portal.lvh.me"), "acme");
  assert.equal(t("acme.portal.lvh.me", "app.lvh.me"), null);
  assert.equal(t("acme.app.lvh.me", "portal.lvh.me"), null);
  assert.equal(t("portal.lvh.me", "portal.lvh.me"), null); // portal apex
  assert.notEqual(portalBaseDomain, baseDomain);
  console.log("tenant.ts ok");
}
