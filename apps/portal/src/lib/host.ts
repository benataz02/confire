// The portal's zone (PORTAL base domain, spec §3). The rules live in @confire/ui/host.ts, shared
// with the internal app, which passes its own zone.
import { hosts } from "@confire/ui/host.ts";

export { hardRedirect } from "@confire/ui/host.ts";

export const BASE_DOMAIN = (import.meta.env.VITE_PORTAL_BASE_DOMAIN ?? "portal.lvh.me").toLowerCase();

export const { currentSlug, isApex, apexUrl, tenantUrl, safeRedirect } = hosts(BASE_DOMAIN);

/** Apex search params for the auth pages: where to come back to, and `t` — whose branding to show.
 *  `t` is display only; nothing on the server trusts it (spec §3). */
export const authSearch = (redirect: string | undefined, t: string | null | undefined) => {
  const q = new URLSearchParams();
  if (redirect) q.set("redirect", redirect);
  if (t) q.set("t", t);
  return q.size ? `?${q}` : "";
};

/** The apex login for this page: comes back here, wearing this supplier's branding. */
export const loginUrl = (redirect = window.location.href) => apexUrl(`/login${authSearch(redirect, currentSlug())}`);

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** validateSearch for the apex auth pages: `redirect` (where to come back to), `t` (whose branding),
 *  `error` (a code Better Auth or a social provider sent back), `token` (a reset link's). */
export const authParams = (s: Record<string, unknown>): { redirect?: string; t?: string; error?: string; token?: string } => ({
  redirect: str(s.redirect),
  t: str(s.t),
  error: str(s.error),
  token: str(s.token),
});
