import { os, ORPCError } from "@orpc/server";
import { and, eq, notInArray } from "drizzle-orm";
import { db, EXTERNAL_ROLES, member, organization, user } from "@confire/db";
import { auth } from "../auth.ts";
import { TENANT_HEADER, tenantSlug } from "../tenant.ts";
import { t } from "../i18n/index.ts";

// Initial context provided by the Hono adapter on every request.
export interface InitialContext {
  headers: Headers;
  /** Set only by the assistant's chat when its tools call a procedure (tools.ts `procedureTool`):
   *  the thread the call runs in. The RPC and OpenAPI handlers never fill it from a request, so a
   *  browser cannot set it. b1.write/b1.copy read it for auto mode's file exception. */
  assistantThreadId?: string;
  /** Set only by the MCP route (mcp.ts) once Better Auth has verified the bearer token: the token's
   *  user. Like assistantThreadId, no handler fills it from a request, so a cookie or header cannot. */
  mcpUserId?: string;
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

/** The user behind a workspace call: the MCP token's (read live, so a deleted user is refused at
 *  once), otherwise the cookie session's. Only userProcedure takes a token: `me`, the lobby and setup
 *  (sessionProcedure) are the browser's and keep requireSession. */
const requireUser = base.middleware(async ({ context, next }) => {
  if (context.mcpUserId) {
    const [row] = await db.select().from(user).where(eq(user.id, context.mcpUserId)).limit(1);
    if (!row) throw new ORPCError("UNAUTHORIZED");
    return next({ context: { user: row } });
  }
  const data = await auth.api.getSession({ headers: context.headers, query: { disableCookieCache: true } });
  if (!data) throw new ORPCError("UNAUTHORIZED");
  return next({ context: { user: data.user } });
});

/** The workspace a request names (its `x-tenant`: the page's first path segment, tenant.ts), gated by
 *  this user's staff membership — the tenant boundary. A supplier's customer (a `portal_*` role) is a member
 *  of the organization too, and is refused here like a stranger. */
export async function membershipOf(slugValue: string | null | undefined, userId: string) {
  const slug = tenantSlug(slugValue);
  if (!slug) throw new ORPCError("BAD_REQUEST", { message: t("NO_WORKSPACE") });
  const [row] = await db
    .select({ tenantId: organization.id, role: member.role })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(and(eq(organization.slug, slug), eq(member.userId, userId), notInArray(member.role, EXTERNAL_ROLES)))
    .limit(1);
  if (!row) throw new ORPCError("FORBIDDEN", { message: t("NOT_A_MEMBER") });
  return row;
}

/**
 * Procedures a signed-in user calls, scoped to the workspace the request names. The membership
 * join is the tenant boundary: a forged `x-tenant` can only ever select an org the user is already
 * staff of.
 */
export const userProcedure = base.use(requireUser).use(async ({ context, next }) => {
  const row = await membershipOf(context.headers.get(TENANT_HEADER), context.user.id);
  return next({ context: { tenantId: row.tenantId, role: row.role, userId: context.user.id } });
});

/** The admin check, named so a caller (the assistant's tool list) can tell an admin procedure. */
export const requireAdmin = base.$context<InitialContext & { role: string }>().middleware(({ context, next }) => {
  if (context.role !== "admin" && context.role !== "owner") {
    throw new ORPCError("FORBIDDEN", { message: t("ADMINS_ONLY") });
  }
  return next({});
});

/** Like userProcedure, but only org admins/owners — gates Settings (not a member's own
 *  notifications), the model builder and portal invitations. The SAP pages are userProcedure. */
export const adminProcedure = userProcedure.use(requireAdmin);

/** Session only: the sign-in host's calls (no workspace yet), and `me`. */
export const sessionProcedure = base.use(requireSession);
