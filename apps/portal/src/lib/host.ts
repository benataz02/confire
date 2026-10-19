// The portal's tenancy: the supplier is the page's first path segment. Signing in happens on the
// staff app's origin, the one sign-in host. The rules live in @confire/ui/host.ts.
export { authUrl, currentSlug, hardRedirect, loginUrl, tenantBasepath, TENANT_HEADER } from "@confire/ui/host.ts";
