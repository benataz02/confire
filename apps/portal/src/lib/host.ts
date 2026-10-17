// The portal's zone (PORTAL base domain) and the sign-in host it shares with the internal app. The
// rules live in @confire/ui/host.ts.
import { hosts } from "@confire/ui/host.ts";

export { hardRedirect } from "@confire/ui/host.ts";

export const BASE_DOMAIN = (import.meta.env.VITE_PORTAL_BASE_DOMAIN ?? "portal.lvh.me").toLowerCase();
const AUTH_URL: string = import.meta.env.VITE_AUTH_URL ?? "http://lvh.me:5173";

export const { isApex, authUrl, loginUrl } = hosts(BASE_DOMAIN, AUTH_URL);
