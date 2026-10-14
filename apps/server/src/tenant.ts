// Tenant slug lives in the request host: `<slug>.<baseDomain>`. The apex (and a few
// reserved labels) carry no tenant. This is the only place the host is parsed server-side.
import assert from "node:assert/strict";

const RESERVED = new Set(["app", "www", "api", "auth", "admin", "static", "assets"]);

/** Prod sets APP_BASE_DOMAIN (e.g. `app.confire.ai`). The dev default needs no setup: browsers and
 *  systemd-resolved send `*.localhost` to loopback, and the second label is what lets a
 *  `.confire.localhost` cookie span subdomains — the browser treats bare `localhost` as a TLD. */
export const baseDomain = (process.env.APP_BASE_DOMAIN ?? "confire.localhost").toLowerCase();

/** `acme.confire.localhost` + base `confire.localhost` -> "acme"; apex/reserved/deeper -> null. */
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
  assert.equal(t("acme.confire.localhost", "confire.localhost"), "acme");
  assert.equal(t("acme.localhost:5173", "localhost"), "acme");
  assert.equal(t("ACME.Confire.Localhost", "confire.localhost"), "acme");
  assert.equal(t("confire.localhost", "confire.localhost"), null); // apex
  assert.equal(t("localhost:3000", "localhost"), null); // apex
  assert.equal(t("app.confire.localhost", "confire.localhost"), null); // reserved
  assert.equal(t("a.b.confire.localhost", "confire.localhost"), null); // deeper subdomain
  assert.equal(t("acme.evil.com", "confire.localhost"), null); // wrong base
  assert.equal(t(null, "confire.localhost"), null);
  console.log("tenant.ts ok");
}
