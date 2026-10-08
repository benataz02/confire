import { os, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, member, organization } from "@confire/db";
import { auth } from "../auth.ts";
import { tenantSlugFromHost } from "../tenant.ts";

export const baseDomain = process.env.APP_BASE_DOMAIN ?? "lvh.me";

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

/** Resolve host subdomain → org, gated by this user's membership (the tenant boundary). */
export async function membershipFromHost(headers: Headers, userId: string) {
  // Caddy preserves Host; the dev proxy and e2e set X-Forwarded-Host. Prefer the latter.
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  const slug = tenantSlugFromHost(host, baseDomain);
  if (!slug) throw new ORPCError("BAD_REQUEST", { message: "No tenant subdomain" });
  const [row] = await db
    .select({ tenantId: organization.id, role: member.role })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(organization.slug, slug), eq(member.userId, userId)))
    .limit(1);
  if (!row) throw new ORPCError("FORBIDDEN", { message: "Not a member of this workspace" });
  return row;
}

/**
 * Procedures a signed-in user calls, scoped to the tenant in the request host
 * (`<slug>.<baseDomain>`). The membership join is the tenant boundary: a forged host
 * can only ever select an org the user already belongs to. A leftover `client` membership
 * — the removed external portal — stays locked out of every internal endpoint.
 */
export const userProcedure = base.use(requireSession).use(async ({ context, next }) => {
  const row = await membershipFromHost(context.headers, context.user.id);
  if (row.role === "client") throw new ORPCError("FORBIDDEN", { message: "Not available for this account" });
  return next({ context: { tenantId: row.tenantId, role: row.role, userId: context.user.id } });
});

/** Like userProcedure, but only org admins/owners — gates Settings and the model builder. */
export const adminProcedure = userProcedure.use(({ context, next }) => {
  if (context.role !== "admin" && context.role !== "owner") {
    throw new ORPCError("FORBIDDEN", { message: "Admins only" });
  }
  return next({});
});

/** Session only. `me` resolves membership itself so the shell can learn the role. */
export const sessionProcedure = base.use(requireSession);
