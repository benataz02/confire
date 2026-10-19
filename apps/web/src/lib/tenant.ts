// The staff app's tenancy: the workspace is the page's first path segment, and this app's origin is
// also the sign-in host the customer portal sends people to. The rules live in @confire/ui/host.ts.
import { currentSlug, isAuthHost } from "@confire/ui/host.ts";

export {
  authUrl, currentSlug, hardRedirect, isReserved, loginUrl, safeRedirect, tenantBasepath, TENANT_HEADER, tenantUrl,
} from "@confire/ui/host.ts";

/** Where the sign-in pages render: the sign-in host, outside any workspace. Anywhere else — a stale
 *  `/<slug>/login` — they hop there. */
export const onSignInHost = () => isAuthHost() && currentSlug() === null;

/** Clean a company name into a slug candidate (no random suffix — it's the permanent URL). */
export const toSlug = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 30);

export const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
