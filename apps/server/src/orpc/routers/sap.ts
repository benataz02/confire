import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { and, eq, notInArray } from "drizzle-orm";
import { db, EXTERNAL_ROLES, member, oauthClient, organization, sapConnection } from "@confire/db";
import { auth } from "../../auth.ts";
import { adminProcedure, sessionProcedure } from "../base.ts";
import { sapConnectionExists } from "../../seed-agent.ts";
import { agentStatus, issuePairingCode } from "../../agent-pairing.ts";
import { portalSeats } from "../../portal/members.ts";
import { appTenantUrl, portalTenantUrl } from "../../tenant.ts";
import { t } from "../../i18n/index.ts";

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

  // The MCP consent page (/oauth/consent, assistant spec §4.10): what a client asks for, read off the
  // query Better Auth signed — never off the browser's say-so — and the workspace it would reach (the
  // consent's reference, auth.ts). The page then answers with Better Auth's own /oauth2/consent.
  oauthConsent: sessionProcedure
    .input(z.object({ query: z.string().max(8000) }))
    .handler(async ({ input, context }) => {
      if (!(await verifyOAuthQueryParams(input.query, (await auth.$context).secret))) throw new ORPCError("BAD_REQUEST");
      const params = new URLSearchParams(input.query);
      const [client] = await db.select({ name: oauthClient.name, uri: oauthClient.uri, disabled: oauthClient.disabled })
        .from(oauthClient).where(eq(oauthClient.clientId, params.get("client_id") ?? "")).limit(1);
      if (!client || client.disabled) throw new ORPCError("NOT_FOUND");
      const row = await oneMembership(context.user.id);
      return {
        client: { name: client.name ?? params.get("client_id")!, uri: client.uri ?? null },
        scopes: (params.get("scope") ?? "").split(" ").filter(Boolean),
        workspace: row ? { name: row.name, slug: row.slug } : null,
        email: context.user.email,
      };
    }),

  // Pairing (spec 2026-10-21 §4): a one-time code the agent redeems on the SAP server, and the status
  // that turns green once SAP answers through it. Settings reaches them through the path's tenant;
  // onboarding has no workspace in its path yet, so it resolves the user's one staff workspace.
  pairingCode: adminProcedure.handler(({ context }) => issuePairingCode(context.tenantId)),
  agentStatus: adminProcedure.handler(({ context }) => agentStatus(context.tenantId)),
  // Settings → SAP agent's Printing choice (print spec §5.1). Direct only while the paired agent
  // reports it set up — which an agent too old to know the engine never does — so the order is the
  // box's setup first, then this switch. The Gateway can always be chosen back.
  setPrintEngine: adminProcedure
    .input(z.object({ engine: z.enum(["gateway", "crystal"]) }))
    .handler(async ({ input, context }) => {
      if (input.engine === "crystal") {
        const s = await agentStatus(context.tenantId);
        if (!s.connected || !s.services?.print.crystal) throw new ORPCError("PRECONDITION_FAILED", { message: t("PRINT_DIRECT_NOT_SET_UP") });
      }
      await db.update(sapConnection).set({ printEngine: input.engine }).where(eq(sapConnection.tenantId, context.tenantId));
      return { engine: input.engine };
    }),
  onboardingPairingCode: sessionProcedure.handler(async ({ context }) => issuePairingCode(await ownedTenant(context.user.id))),
  onboardingAgentStatus: sessionProcedure.handler(async ({ context }) => agentStatus(await ownedTenant(context.user.id))),
};
