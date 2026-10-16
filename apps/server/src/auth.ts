import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db } from "@confire/db/client";
import * as schema from "@confire/db/schema";
import { baseDomain, tenantSlugFromHost } from "./tenant.ts";
import { authMail } from "./mail/auth-mail.tsx";
import { CONFIRE } from "./mail/layout.tsx";

/** The web's SLUG_RE is UX; this is the gate. Better Auth takes any non-empty slug, and one the host
 *  parser cannot hand back is a workspace no request can ever reach — with organizationLimit: 1 and
 *  deletion off, its owner could not start over. */
const assertSlug = (slug: string | undefined) => {
  if (slug !== undefined && tenantSlugFromHost(`${slug}.${baseDomain}`, baseDomain) !== slug) {
    throw new APIError("BAD_REQUEST", { message: "Invalid workspace URL" });
  }
};

// Internal mail is always Confire's: the apex has no tenant to brand it with.
const mail = authMail(async () => CONFIRE);

// secret and baseURL come from BETTER_AUTH_SECRET / BETTER_AUTH_URL, which Better Auth reads itself.
export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // Default min length (8) on purpose: there is no dev/prod branch here, so a dev-only floor ships.
  // Sign-in never checks length, so an existing shorter dev password still logs in.
  emailAndPassword: {
    enabled: true,
    // Spec D13: a mailer exists, so an address has to be proven before it signs in. Sign-up then
    // returns no session, and every sign-in of an unverified account is refused (EMAIL_NOT_VERIFIED).
    // Existing unverified accounts are not grandfathered: sendOnSignIn mails them a fresh link.
    requireEmailVerification: true,
    sendResetPassword: mail.sendResetPassword,
    // A reset is what someone does when a session may be in the wrong hands. This revokes this
    // instance's sessions; the password is shared with the portal (spec §4.1), so its sessions —
    // in their own table — go too.
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      await db.delete(schema.portalSession).where(eq(schema.portalSession.userId, user.id));
    },
  },
  emailVerification: {
    sendVerificationEmail: mail.sendVerificationEmail,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID ?? "",
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET ?? "",
    }
  },
  plugins: [
    organization({
      // A user belongs to exactly one company — there is no workspace picker anywhere in the
      // app, so a second one would be unreachable. Better Auth returns FORBIDDEN on create.
      organizationLimit: 1,
      // No UI deletes a company, and nothing references organization.id by FK — a delete through
      // /organization/delete would orphan every tenant_id row and free the slug. Off until a real
      // offboarding flow exists to clean those up.
      disableOrganizationDeletion: true,
      // Update too: an admin can rename the slug through /organization/update.
      organizationHooks: {
        beforeCreateOrganization: async ({ organization }) => assertSlug(organization.slug),
        beforeUpdateOrganization: async ({ organization }) => assertSlug(organization.slug),
      },
      // No seeding hook: every list's Standard view is declared in code (the web features), so a
      // new tenant has nothing to be given.
    }),
  ],
  // Off: a signed session_data cookie would keep a deleted/expired row "valid" for maxAge,
  // and login's getSession would bounce the 401 interceptor back to the tenant. oRPC also
  // passes disableCookieCache so a future re-enable cannot paper over the tenant boundary.
  session: { cookieCache: { enabled: false } },
  // Auth lives on the apex, but the app POSTs (sign-out) from every tenant subdomain, so those
  // origins need trusting; baseURL's own origin is trusted automatically. A pattern without
  // `://` is matched against URL.host — which includes the port — hence both forms: prod
  // (`acme.app.confire.ai`) and dev (`acme.app.lvh.me:5173`). Anything outside the base domain — a LAN
  // IP to open the app from a phone — is a per-machine fact, so it comes from
  // APP_TRUSTED_ORIGINS (comma-separated) and never from a literal in here.
  trustedOrigins: [
    `*.${baseDomain}`,
    `*.${baseDomain}:*`,
    ...(process.env.APP_TRUSTED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  ],
  advanced: {
    crossSubDomainCookies: { enabled: true, domain: `.${baseDomain}` },
  },
});
