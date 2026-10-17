// Client-side mirror of apps/server/src/tenant.ts, for any zone: the internal app passes its
// APP base domain, the customer portal its PORTAL one. The subdomain label is the tenant slug; the
// apex (and a few reserved labels) carry no tenant. Both zones send people to one sign-in host, whose
// hostname is the session cookie's domain. The server re-validates against membership — this is only
// for UX and redirects.

const RESERVED = new Set(["app", "www", "api", "auth", "admin", "static", "assets"]);

export const isReserved = (slug: string) => RESERVED.has(slug);

/** `acme.<base>` → "acme"; the apex, a reserved label, a deeper name or another zone → null. */
export function slugOf(hostname: string, baseDomain: string): string | null {
  const name = hostname.toLowerCase();
  const base = baseDomain.toLowerCase();
  if (name === base || !name.endsWith(`.${base}`)) return null;
  const label = name.slice(0, -(base.length + 1));
  return /^[a-z0-9-]+$/.test(label) && !RESERVED.has(label) ? label : null;
}

/**
 * Cross-origin hop (apex <-> subdomain). Returns a never-resolving promise so a router
 * beforeLoad halts instead of rendering before the browser navigates.
 */
export function hardRedirect(url: string): Promise<never> {
  window.location.assign(url);
  return new Promise<never>(() => {});
}

/** The helpers for one zone, and the sign-in host (`authOrigin`: `https://confire.ai`, dev
 *  `http://lvh.me:5173`) every zone signs in on. `window` is read on call, never at import, so tests
 *  can import this. */
export function hosts(baseDomain: string, authOrigin: string) {
  const base = baseDomain.toLowerCase();
  const auth = new URL(authOrigin);
  // The cookie domain: every host this stack serves — the sign-in host and both zones — is under it.
  const root = auth.hostname.toLowerCase();
  const origin = (host: string) =>
    `${window.location.protocol}//${host}${window.location.port ? `:${window.location.port}` : ""}`;
  const currentSlug = () => slugOf(window.location.hostname, base);
  return {
    BASE_DOMAIN: base,
    /** Tenant slug from window.location.hostname, or null on the apex/reserved hosts. */
    currentSlug,
    isApex: () => currentSlug() === null,
    isAuthHost: () => window.location.host === auth.host,
    /** A page on the sign-in host. */
    authUrl: (path = "/") => `${auth.origin}${path}`,
    /** Sign in, then come back here (or to `redirect`). */
    loginUrl: (redirect = window.location.href) => `${auth.origin}/login?${new URLSearchParams({ redirect })}`,
    tenantUrl: (slug: string, path = "/") => `${origin(`${slug}.${base}`)}${path}`,
    /**
     * Guard against open redirects: only ever hand back a URL whose hostname is the sign-in host or
     * under it — either zone, since the sign-in host sends people to both. Anything else —
     * unparsable, a relative path, a foreign host, `javascript:` — comes back `null` so callers fall
     * through to a safe default. Deliberately requires an absolute URL: `redirect=` is only ever
     * produced by the apps themselves as a full `window.location.href`.
     */
    safeRedirect: (url: string | undefined): string | null => {
      if (!url) return null;
      try {
        const u = new URL(url);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        const host = u.hostname.toLowerCase();
        return host === root || host.endsWith(`.${root}`) ? url : null;
      } catch {
        return null;
      }
    },
  };
}
