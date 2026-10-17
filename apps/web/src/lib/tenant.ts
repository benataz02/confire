// The internal app's zone (APP base domain) and the sign-in host it shares with the customer portal.
// The rules themselves live in @confire/ui/host.ts.
import { hosts } from "@confire/ui/host.ts";

export { hardRedirect, isReserved } from "@confire/ui/host.ts";

// Same defaults as the server (apps/server/src/tenant.ts): dev needs no env; a prod build passes them.
export const BASE_DOMAIN = (import.meta.env.VITE_APP_BASE_DOMAIN ?? "app.lvh.me").toLowerCase();
const AUTH_URL: string = import.meta.env.VITE_AUTH_URL ?? "http://lvh.me:5173";

export const { currentSlug, isAuthHost, authUrl, loginUrl, tenantUrl, safeRedirect } = hosts(BASE_DOMAIN, AUTH_URL);

/** Clean a company name into a subdomain candidate (no random suffix — it's the permanent URL). */
export const toSlug = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30);

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
