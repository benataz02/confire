import { os, ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db, organization } from "@confire/db";
import { auth } from "../../auth.ts";
import { TENANT_HEADER, tenantSlug } from "../../tenant.ts";
import { isInternalMember, seatOf } from "../members.ts";

export { isInternalMember, seatOf };

// The portal's procedure builders (spec §4.3). The boundary is the internal app's, one step longer:
// the supplier the request names (`x-tenant`, the page's first path segment) → this user's seat there
// (their `external` member row ⋈ its portal_company). The path picks the supplier, and one member row
// per (organization, user) leaves at most one seat there.

export interface PortalContext {
  headers: Headers;
}

export const portalBase = os.$context<PortalContext>();

/** Signed in — the one session staff and customers share, read live (no cookie cache). Signed in is
 *  not a seat: every tenant-scoped builder below joins one. */
export const portalAuthedProcedure = portalBase.use(async ({ context, next }) => {
  const data = await auth.api.getSession({ headers: context.headers, query: { disableCookieCache: true } });
  if (!data) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { session: data.session, user: data.user } });
});

/** The supplier a slug names — from `x-tenant`, or a file route's path. */
export async function tenantOf(slugValue: string | null | undefined) {
  const slug = tenantSlug(slugValue);
  if (!slug) throw new ORPCError("BAD_REQUEST", { message: "No supplier in the request" });
  const [tenant] = await db.select({ id: organization.id, slug: organization.slug, name: organization.name, logo: organization.logo })
    .from(organization).where(eq(organization.slug, slug)).limit(1);
  if (!tenant) throw new ORPCError("NOT_FOUND", { message: "No such supplier" });
  return tenant;
}

/** Signed in, the request's supplier resolved, maybe no company there yet. Refuses the supplier's own
 *  staff: an internal member uses the staff app, never the portal. */
export const portalSessionProcedure = portalAuthedProcedure.use(async ({ context, next }) => {
  const tenant = await tenantOf(context.headers.get(TENANT_HEADER));
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
