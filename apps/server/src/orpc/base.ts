import { os, ORPCError } from "@orpc/server";
import { and, eq, ne } from "drizzle-orm";
import { db, EXTERNAL_ROLE, member, organization } from "@confire/db";
import { auth } from "../auth.ts";
import { TENANT_HEADER, tenantSlug } from "../tenant.ts";

// Initial context provided by the Hono adapter on every request.
export interface InitialContext {
  headers: Headers;
}

export const base = os.$context<InitialContext>();

// --- Layer 1: human user via Better Auth session ---
const requireSession = base.middleware(async ({ context, next }) => {
  // Cookie cache is a signed snapshot, not a pointer at the row — a deleted or expired
  // session would otherwise stay valid for session.cookieCache.maxAge. Same as Better Auth's
  // sensitiveSessionMiddleware: the tenant boundary is a live read.
  const data = await auth.api.getSession({
    headers: context.headers,
    query: { disableCookieCache: true },
  });
  if (!data) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { session: data.session, user: data.user } });
});

/** The workspace a request names (its `x-tenant`: the page's first path segment, tenant.ts), gated by
 *  this user's staff membership — the tenant boundary. A supplier's customer (`external`) is a member
 *  of the organization too, and is refused here like a stranger. */
export async function membershipOf(slugValue: string | null | undefined, userId: string) {
  const slug = tenantSlug(slugValue);
  if (!slug) throw new ORPCError("BAD_REQUEST", { message: "No workspace in the request" });
  const [row] = await db
    .select({ tenantId: organization.id, role: member.role })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(organization.slug, slug), eq(member.userId, userId), ne(member.role, EXTERNAL_ROLE)))
    .limit(1);
  if (!row) throw new ORPCError("FORBIDDEN", { message: "Not a member of this workspace" });
  return row;
}

/**
 * Procedures a signed-in user calls, scoped to the workspace the request names. The membership
 * join is the tenant boundary: a forged `x-tenant` can only ever select an org the user is already
 * staff of.
 */
export const userProcedure = base.use(requireSession).use(async ({ context, next }) => {
  const row = await membershipOf(context.headers.get(TENANT_HEADER), context.user.id);
  return next({ context: { tenantId: row.tenantId, role: row.role, userId: context.user.id } });
});

/** Like userProcedure, but only org admins/owners — gates Settings and the model builder. */
export const adminProcedure = userProcedure.use(({ context, next }) => {
  if (context.role !== "admin" && context.role !== "owner") {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  return next({});
});

/** Session only: the sign-in host's calls (no workspace yet), and `me`. */
export const sessionProcedure = base.use(requireSession);
