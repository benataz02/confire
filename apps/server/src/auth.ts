import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@confire/db/client";
import * as schema from "@confire/db/schema";
import { EXTERNAL_ROLES } from "@confire/db/schema";
import { authUrl, cookieDomain, portalUrl, tenantSlug } from "./tenant.ts";
import { authMail } from "./mail/auth-mail.tsx";

/** The web's SLUG_RE is UX; this is the gate. Better Auth takes any non-empty slug, and one the path
 *  rule cannot hand back is a workspace no URL can ever reach — with a one-workspace limit and
 *  deletion off, its owner could not start over. */
const assertSlug = (slug: string | undefined) => {
  if (slug !== undefined && tenantSlug(slug) !== slug) {
    throw new APIError("BAD_REQUEST", { message: "Invalid workspace URL" });
  }
};

/** Spec D5/§4.4: in multi-tenant Entra apps the `email` claim is not verified, so a Microsoft email
 *  counts as verified only on the optional `xms_edov` claim (the app registration has to emit it).
 *  Spread after Better Auth's own value, so it can change emailVerified — never the `oid` identity. */
export const microsoftEmailVerified = (profile: Record<string, unknown>): boolean =>
  profile.xms_edov === true || profile.xms_edov === "1" || profile.xms_edov === 1 || profile.xms_edov === "true";

const mail = authMail();

/** The browser calls only these two organization endpoints (workspace setup). Every other one is off:
 *  they treat every member as a peer, so a supplier's customer — a `portal_*` member — could list the
 *  supplier's staff and every other customer (`list-members`, `get-full-organization`), and an admin
 *  could turn a customer into staff (`update-member-role`). Confire's own procedures write members
 *  (portal/members.ts) and pick the organization (the path), so nothing is lost. Computed from the
 *  plugin, so an endpoint a Better Auth upgrade adds starts off too. */
const BROWSER_ORG_PATHS = new Set(["/organization/create", "/organization/check-slug"]);

// Better Auth's own three roles, unchanged, plus the customer's.
const ac = createAccessControl(defaultStatements);

const orgPlugin = organization({
  ac,
  roles: {
    owner: ac.newRole(ownerAc.statements),
    admin: ac.newRole(adminAc.statements),
    member: ac.newRole(memberAc.statements),
    // A supplier's customer (spec 2026-10-19-path-tenancy-design.md): a member of the supplier's
    // organization whose role is its role in its company (`portal_owner`/`_buyer`/`_viewer`), refused
    // by every internal procedure, with no permission on any org endpoint. Its company is `cardCode`.
    ...Object.fromEntries(EXTERNAL_ROLES.map((r) => [r, ac.newRole({})])),
  },
  schema: {
    member: {
      additionalFields: {
        // The company's CardCode: a company is (organization, CardCode), so this row's organizationId
        // completes the key — never match a CardCode without it. No FK: the generated schema cannot
        // carry one, and nothing deletes a company (§4.2). portal/members.ts is the only writer.
        cardCode: { type: "string", required: false, input: false },
      },
    },
    // A portal invitation is Better Auth's own row with the seat it will become: a `portal_*` role and
    // cardCode (null = a new client, set by its onboarding submit). It joins the supplier's
    // organization (organizationId) and never creates one. Better Auth's accept is off — it inserts
    // the member bare, before a new client has a company, and never checks an existing membership — so
    // portal/members.ts writes and accepts these rows (addPortalMember).
    invitation: {
      additionalFields: {
        cardCode: { type: "string", required: false, input: false },
        registerDomain: { type: "boolean", required: false, defaultValue: false, input: false },
        // The SAP language (UserLanguages.Code) its mail went out in: the company's, or for a new
        // client the inviter's app language — which onboarding submit also gives the new lead.
        languageCode: { type: "number", required: false, input: false },
      },
    },
  },
  // Staff of one workspace at most — there is no workspace picker in the app — but a customer of any
  // number of suppliers, so the count is of staff rows only. True = the limit is reached.
  organizationLimit: async (user) => {
    const [staff] = await db.select({ id: schema.member.id }).from(schema.member)
      .where(and(eq(schema.member.userId, user.id), notInArray(schema.member.role, EXTERNAL_ROLES))).limit(1);
    return !!staff;
  },
  // No UI deletes a company, and nothing references organization.id by FK — a delete through
  // /organization/delete would orphan every tenant_id row and free the slug. Off until a real
  // offboarding flow exists to clean those up.
  disableOrganizationDeletion: true,
  // Update too: the endpoint is off, but auth.api.updateOrganization is not, and a slug is a URL.
  organizationHooks: {
    beforeCreateOrganization: async ({ organization }) => assertSlug(organization.slug),
    beforeUpdateOrganization: async ({ organization }) => assertSlug(organization.slug),
  },
  // No seeding hook: every list's Standard view is declared in code (the web features), so a
  // new tenant has nothing to be given.
});

// The one Better Auth instance, for staff and customers alike. Both processes mount it on /api/auth;
// the tenant boundary is not the session but the membership join behind it (orpc/base.ts staff,
// portal/orpc/base.ts customers). The secret comes from BETTER_AUTH_SECRET, which Better Auth reads
// itself.
export const auth = betterAuth({
  // The staff app's origin, which is also the sign-in host: OAuth callbacks and every mailed link.
  // From DOMAIN (tenant.ts), so Better Auth needs no BETTER_AUTH_URL of its own.
  baseURL: authUrl,
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
    // A reset is what someone does when a session may be in the wrong hands.
    revokeSessionsOnPasswordReset: true,
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
      mapProfileToUser: (profile) => ({ emailVerified: microsoftEmailVerified(profile as unknown as Record<string, unknown>) }),
    },
  },
  plugins: [orgPlugin],
  disabledPaths: Object.values(orgPlugin.endpoints)
    .map((e) => e.path)
    .filter((p): p is string => !!p && !BROWSER_ORG_PATHS.has(p)),
  // Off: a signed session_data cookie would keep a deleted/expired row "valid" for maxAge,
  // and login's getSession would bounce the 401 interceptor back to the tenant. oRPC also
  // passes disableCookieCache so a future re-enable cannot paper over the tenant boundary.
  session: { cookieCache: { enabled: false } },
  // Sign-in lives on baseURL (trusted automatically), but the portal POSTs (sign-out) from its own
  // origin, and a sign-in's callbackURL may be a portal page. Better Auth appends
  // BETTER_AUTH_TRUSTED_ORIGINS (comma-separated) itself: dev from a phone on the LAN sets
  // `http://<lan-ip>:5173,http://<lan-ip>:5180` there. Never set it in production — every entry is a
  // valid sign-in origin and redirect target.
  trustedOrigins: [portalUrl],
  advanced: {
    // DOMAIN (`confire.ai`) is the parent of both hosts, so one session reaches the staff app and the
    // portal. Every `*.confire.ai` host receives this cookie: never point a confire.ai name at a
    // service this stack does not control. Unset (dev): a host-only cookie on `localhost`, which the
    // browser sends to both ports anyway.
    crossSubDomainCookies: { enabled: cookieDomain !== undefined, domain: cookieDomain },
  },
});

/** The session remembers the organization its last request was scoped to: where the dispatcher sends
 *  a fresh visit to /login. Written to the row directly, and only when it changes — the caller has
 *  already joined the membership (Better Auth's set-active would join it again), and with the cookie
 *  cache off there is no cookie to refresh. */
export async function rememberActiveOrganization(
  session: { id: string; activeOrganizationId?: string | null }, organizationId: string,
): Promise<void> {
  if (session.activeOrganizationId === organizationId) return;
  await db.update(schema.session).set({ activeOrganizationId: organizationId }).where(eq(schema.session.id, session.id));
}
