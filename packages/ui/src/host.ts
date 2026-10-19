// Client-side mirror of apps/server/src/tenant.ts, for both apps. The tenant is the first segment of
// the page's path — `app.confire.ai/<slug>/…`, `portal.confire.ai/<slug>/…` — and each app's router
// runs under it as its basepath, so routes and links never name it. Every call sends it as
// `x-tenant`; a file route carries it in its own path. Sign-in is a page of the staff app, the one
// sign-in host. The server re-validates against membership — this is only for UX and redirects.

/** Never a slug: the staff SPA's own top-level pages, the server's routes, a few names kept back. */
const RESERVED = new Set([
  "login", "signup", "forgot-password", "reset-password", "onboarding",
  "api", "rpc", "files", "assets",
  "app", "portal", "www", "auth", "admin", "static",
]);

export const isReserved = (slug: string) => RESERVED.has(slug);

export const TENANT_HEADER = "x-tenant";

/** `/acme/configs/1` → "acme"; `/`, `/login`, `/assets/x.js` → null. */
export function slugOf(pathname: string): string | null {
  const first = pathname.split("/")[1] ?? "";
  return /^[a-z0-9-]+$/.test(first) && !RESERVED.has(first) ? first : null;
}

/** This page's tenant, or null. `window` is read on call, never at import, so tests can import this. */
export const currentSlug = () => slugOf(window.location.pathname);

/** The router's basepath: `/<slug>` on a tenant's page, `/` on the app's own pages. Read once, when
 *  the router is made: a page never changes tenant without a full load (hardRedirect), so the query
 *  cache never holds two tenants' data. */
export const tenantBasepath = () => {
  const slug = currentSlug();
  return slug ? `/${slug}` : "/";
};

/** A hop to another page load: another app, another tenant, or out of the router. Returns a
 *  never-resolving promise so a router beforeLoad halts instead of rendering before the browser
 *  navigates. */
export function hardRedirect(url: string): Promise<never> {
  window.location.assign(url);
  return new Promise<never>(() => {});
}

type Loc = { protocol: string; hostname: string };

/** The two origins this stack serves, read off the page's own — the server's DOMAIN rule (tenant.ts),
 *  so a build carries no setting and one image serves any domain: `app.<domain>` (the staff app,
 *  which is the sign-in host) and `portal.<domain>`; on any other host — dev — that host on :5173
 *  and :5180. */
export function origins(loc: Loc = window.location): { auth: string; portal: string } {
  const domain = /^(?:app|portal)\.(.+)$/.exec(loc.hostname)?.[1];
  const at = (host: string) => `${loc.protocol}//${host}`;
  return domain
    ? { auth: at(`app.${domain}`), portal: at(`portal.${domain}`) }
    : { auth: at(`${loc.hostname}:5173`), portal: at(`${loc.hostname}:5180`) };
}

/** A page on the sign-in host. */
export const authUrl = (path = "/") => `${origins().auth}${path}`;

/** Sign in, then come back here (or to `redirect`). */
export const loginUrl = (redirect = window.location.href) => authUrl(`/login?${new URLSearchParams({ redirect })}`);

/** A tenant's page in this app. */
export const tenantUrl = (slug: string, path = "/") => `${window.location.origin}/${slug}${path}`;

/**
 * Guard against open redirects: only ever hand back an absolute URL on one of the two origins — the
 * sign-in host sends people to both apps. Anything else — unparsable, a relative path, a foreign
 * host, `javascript:` — comes back `null` so callers fall through to a safe default. `redirect=` is
 * only ever produced by the apps themselves as a full `window.location.href`.
 */
export function safeRedirect(url: string | undefined, loc: Loc = window.location): string | null {
  if (!url) return null;
  const { auth, portal } = origins(loc);
  try {
    const origin = new URL(url).origin;
    return origin === auth || origin === portal ? url : null;
  } catch {
    return null;
  }
}
