import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { captcha } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db, organization } from "@confire/db";
import * as schema from "@confire/db/schema";
import { portalBaseDomain } from "../tenant.ts";
import { authMail } from "../mail/auth-mail.tsx";
import { CONFIRE, type Brand } from "../mail/layout.tsx";

// The customer portal's Better Auth instance (spec §4.1). One identity with the internal instance —
// the same user, account and verification tables, so one password and one Google link per person —
// but its own session table and cookie zone, so a portal session can never authenticate an internal
// request. No organization plugin: companies, seats and invitations are Confire tables (§4.2).

/** The portal apex as the browser sees it. Always passed: left unset, Better Auth would fall back to
 *  BETTER_AUTH_URL — the internal apex, which this process shares an .env with in dev. */
export const portalAuthUrl = (process.env.PORTAL_AUTH_URL ?? `http://${portalBaseDomain}:5180`).replace(/\/+$/, "");

/** Spec D5/§4.4: in multi-tenant Entra apps the `email` claim is not verified, so a Microsoft email
 *  counts as verified only on the optional `xms_edov` claim (the app registration has to emit it).
 *  Spread after Better Auth's own value, so it can change emailVerified — never the `oid` identity. */
export const microsoftEmailVerified = (profile: Record<string, unknown>): boolean =>
  profile.xms_edov === true || profile.xms_edov === "1" || profile.xms_edov === 1 || profile.xms_edov === "true";

/** The tenant a page named with `?t=` on the URL Better Auth mails (its callbackURL). Display only:
 *  nothing trusts `t` (§3), it only picks whose name and logo the mail wears. */
async function brandOf(url: string): Promise<Brand> {
  const callback = new URL(url).searchParams.get("callbackURL");
  const slug = callback ? new URL(callback, portalAuthUrl).searchParams.get("t") : null;
  if (!slug) return CONFIRE;
  const [org] = await db.select({ name: organization.name, logo: organization.logo })
    .from(organization).where(eq(organization.slug, slug.toLowerCase())).limit(1);
  return org ? { name: org.name, logoUrl: org.logo } : CONFIRE;
}

const mail = authMail(brandOf);

export const portalAuth = betterAuth({
  appName: "Confire portal",
  baseURL: portalAuthUrl,
  // secret: BETTER_AUTH_SECRET, read by Better Auth itself — the same one as the internal instance.
  database: drizzleAdapter(db, { provider: "pg", schema }),
  session: {
    // The drizzle adapter resolves schema[modelName]: the export key in schema/portal.ts.
    modelName: "portalSession",
    // Off for the same reason as the internal instance: the boundary is a live read.
    cookieCache: { enabled: false },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: mail.sendResetPassword,
    // Revokes portal sessions only. The password itself is shared with the internal zone (§4.1).
    revokeSessionsOnPasswordReset: true,
  },
  emailVerification: {
    sendVerificationEmail: mail.sendVerificationEmail,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
  },
  socialProviders: {
    // The same OAuth clients as the internal instance, with this zone's callback URL registered too.
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
      mapProfileToUser: (profile) => ({ emailVerified: microsoftEmailVerified(profile as unknown as Record<string, unknown>) }),
    },
  },
  plugins: [
    // Turnstile on /sign-up/email, /sign-in/email and /request-password-reset (the plugin's
    // defaults, spec §4.5). The browser sends the widget's token as x-captcha-response.
    captcha({ provider: "cloudflare-turnstile", secretKey: process.env.TURNSTILE_SECRET_KEY ?? "" }),
  ],
  // Same shape as the internal instance: tenant pages POST sign-out from their own subdomain.
  trustedOrigins: [
    `*.${portalBaseDomain}`,
    `*.${portalBaseDomain}:*`,
    ...(process.env.PORTAL_TRUSTED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  ],
  advanced: {
    // A prefix of its own as well as a zone of its own: in dev both zones share a browser profile.
    cookiePrefix: "confire-portal",
    crossSubDomainCookies: { enabled: true, domain: `.${portalBaseDomain}` },
  },
});
