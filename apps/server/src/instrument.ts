import * as Sentry from "@sentry/bun";
import { domainOf } from "./tenant.ts";

// Preloaded by every server start script (`bun --preload`), so the SDK's hooks are in place before the
// app's modules load. No DSN = a no-op: tests and a bare checkout send nothing.
// The SDK reads the release from SENTRY_RELEASE: the image's git sha (Dockerfile); dev has none.
// No sendDefaultPii/dataCollection on purpose: request cookies carry the session token and bodies carry
// tenants' SAP data.
// DOMAIN is the whole deployment (tenant.ts): unset or `localhost` is dev, which sends nothing even with
// SENTRY_DSN set, so a dev error never raises a production alert.
const deployed = domainOf(process.env.DOMAIN) !== undefined;

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  // Not a dsn of undefined: the SDK then falls back to SENTRY_DSN itself.
  enabled: deployed,
  environment: "production",
  tracesSampleRate: 0.1,
  // Both processes preload this file; the entry point says which one this is.
  initialScope: { tags: { process: Bun.main.includes("/portal/") ? "portal" : "staff" } },
});
