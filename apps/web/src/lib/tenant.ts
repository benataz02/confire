// The internal app's zone (APP base domain). The rules themselves live in @confire/ui/host.ts,
// shared with the customer portal, which passes its own zone.
import { hosts } from "@confire/ui/host.ts";

export { hardRedirect, isReserved } from "@confire/ui/host.ts";

// Same default as the server (apps/server/src/tenant.ts): dev needs no env; a prod build passes it.
export const BASE_DOMAIN = (import.meta.env.VITE_APP_BASE_DOMAIN ?? "app.lvh.me").toLowerCase();

export const { currentSlug, isApex, apexUrl, tenantUrl, safeRedirect } = hosts(BASE_DOMAIN);

/** Clean a company name into a subdomain candidate (no random suffix — it's the permanent URL). */
export const toSlug = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30);

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
