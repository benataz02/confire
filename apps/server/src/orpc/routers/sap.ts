import { ORPCError } from "@orpc/server";
import { and, eq, notInArray } from "drizzle-orm";
import { db, EXTERNAL_ROLES, member, organization } from "@confire/db";
import { adminProcedure, sessionProcedure } from "../base.ts";
import { sapConnectionExists } from "../../seed-agent.ts";
import { agentStatus, issuePairingCode } from "../../agent-pairing.ts";
import { portalSeats } from "../../portal/members.ts";
import { appTenantUrl, portalTenantUrl } from "../../tenant.ts";

/** Workspace setup has no workspace in its path — the user's one staff membership is the tenant.
 *  Customer seats are members too, and never count (auth.ts' organizationLimit). */
async function oneMembership(userId: string) {
  const [row] = await db
    .select({ tenantId: organization.id, slug: organization.slug, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), notInArray(member.role, EXTERNAL_ROLES)))
    .limit(1);
  return row;
}

const isAdmin = (role: string) => role === "owner" || role === "admin";

async function ownedTenant(userId: string): Promise<string> {
  const row = await oneMembership(userId);
  if (!row || !isAdmin(row.role)) throw new ORPCError("FORBIDDEN");
  return row.tenantId;
}

export const sapRouter = {
  // The sign-in dispatcher's one call (/login, signed in): every place this user can go — their
  // workspace (null = no company yet; does it still need an agent?) and every supplier portal they
  // have a seat at, the one the session last worked in marked `active`. Only an owner/admin can
  // pair an agent, so a member goes straight to the workspace whether or not the row exists. The
  // URLs are built here so the browser never guesses the other app's origin.
  lobby: sessionProcedure.handler(async ({ context }) => {
    const [row, seats] = await Promise.all([oneMembership(context.user.id), portalSeats(context.user.id)]);
    const active = context.session.activeOrganizationId;
    return {
      workspace: row
        ? {
          slug: row.slug, name: row.name, url: appTenantUrl(row.slug), active: row.tenantId === active,
          needsAgent: isAdmin(row.role) && !(await sapConnectionExists(row.tenantId)),
        }
        : null,
      portals: seats.map(({ tenantId, ...s }) => ({ ...s, url: portalTenantUrl(s.slug), active: tenantId === active })),
    };
  }),

  // Pairing (spec 2026-10-21 §4): a one-time code the agent redeems on the SAP server, and the status
  // that turns green once SAP answers through it. Settings reaches them through the path's tenant;
  // onboarding has no workspace in its path yet, so it resolves the user's one staff workspace.
  pairingCode: adminProcedure.handler(({ context }) => issuePairingCode(context.tenantId)),
  agentStatus: adminProcedure.handler(({ context }) => agentStatus(context.tenantId)),
  onboardingPairingCode: sessionProcedure.handler(async ({ context }) => issuePairingCode(await ownedTenant(context.user.id))),
  onboardingAgentStatus: sessionProcedure.handler(async ({ context }) => agentStatus(await ownedTenant(context.user.id))),
};
