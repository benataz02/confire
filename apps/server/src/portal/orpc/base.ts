import { os, ORPCError } from "@orpc/server";
import { and, eq, ne } from "drizzle-orm";
import { db, member, organization, portalCompany, portalMember } from "@confire/db";
import { portalAuth } from "../auth.ts";
import { portalBaseDomain, tenantSlugFromHost } from "../../tenant.ts";

// The portal's procedure builders (spec §4.3). The boundary is the internal app's, one step longer:
// host → tenant (organization) → this user's seat (portal_member ⋈ portal_company on that tenant).
// There is no active-company state: the host picks the tenant, and the unique (tenantId, userId)
// index leaves at most one seat there.

export interface PortalContext {
  headers: Headers;
}

export const portalBase = os.$context<PortalContext>();

/** Signed in on the portal zone — a portal_session row, read live (no cookie cache). */
export const portalAuthedProcedure = portalBase.use(async ({ context, next }) => {
  const data = await portalAuth.api.getSession({ headers: context.headers, query: { disableCookieCache: true } });
  if (!data) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { user: data.user } });
});

/** The supplier in the request host (`<slug>.<PORTAL_BASE_DOMAIN>`). Caddy preserves Host; the dev
 *  proxy and tests set X-Forwarded-Host. */
export async function tenantFromHost(headers: Headers) {
  const slug = tenantSlugFromHost(headers.get("x-forwarded-host") ?? headers.get("host"), portalBaseDomain);
  if (!slug) throw new ORPCError("BAD_REQUEST", { message: "No supplier subdomain" });
  const [tenant] = await db.select({ id: organization.id, slug: organization.slug, name: organization.name, logo: organization.logo })
    .from(organization).where(eq(organization.slug, slug)).limit(1);
  if (!tenant) throw new ORPCError("NOT_FOUND", { message: "No such supplier" });
  return tenant;
}

/** Works for this supplier: an internal membership. A leftover `client` row (the removed in-app
 *  portal) is not staff — it stays locked out of the internal app, and the portal does not read it
 *  (spec D23), so its owner is a customer here like any other. */
export async function isInternalMember(tenantId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, tenantId), eq(member.userId, userId), ne(member.role, "client"))).limit(1);
  return !!row;
}

/** This user's seat at the supplier, or undefined. */
export async function seatOf(tenantId: string, userId: string) {
  const [seat] = await db
    .select({
      companyId: portalCompany.id, cardCode: portalCompany.cardCode, cardName: portalCompany.cardName,
      cardType: portalCompany.cardType, role: portalMember.role,
    })
    .from(portalMember)
    .innerJoin(portalCompany, eq(portalCompany.id, portalMember.companyId))
    .where(and(eq(portalMember.userId, userId), eq(portalCompany.tenantId, tenantId)))
    .limit(1);
  return seat;
}

/** Signed in, tenant resolved from the host, maybe no company there yet. Refuses the supplier's own
 *  staff: an internal member uses `<slug>.app.<domain>`, never the portal. */
export const portalSessionProcedure = portalAuthedProcedure.use(async ({ context, next }) => {
  const tenant = await tenantFromHost(context.headers);
  if (await isInternalMember(tenant.id, context.user.id)) {
    throw new ORPCError("FORBIDDEN", { message: "You work for this supplier: use its internal app" });
  }
  return next({ context: { tenantId: tenant.id, tenant } });
});

/** Has a seat at a company of this supplier. */
export const portalMemberProcedure = portalSessionProcedure.use(async ({ context, next }) => {
  const seat = await seatOf(context.tenantId, context.user.id);
  if (!seat) throw new ORPCError("FORBIDDEN", { message: "Not a member of a company on this portal" });
  return next({ context: seat });
});

/** Creates, edits, submits and withdraws projects; answers quotes. */
export const portalBuyerProcedure = portalMemberProcedure.use(({ context, next }) => {
  if (context.role !== "owner" && context.role !== "buyer") throw new ORPCError("FORBIDDEN", { message: "Buyers only" });
  return next({});
});

/** Invites colleagues, changes roles, removes members. */
export const portalOwnerProcedure = portalMemberProcedure.use(({ context, next }) => {
  if (context.role !== "owner") throw new ORPCError("FORBIDDEN", { message: "Company owners only" });
  return next({});
});
