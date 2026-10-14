import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, member, organization, sapConnection } from "@confire/db";
import { adminProcedure, sessionProcedure } from "../base.ts";
import { sapConnectionExists, upsertSapConnection } from "../../seed-agent.ts";
import { encryptSecret } from "../../crypto.ts";

/** Apex onboarding has no tenant Host — the user's one org is the tenant. */
async function oneMembership(userId: string) {
  const [row] = await db
    .select({ tenantId: organization.id, slug: organization.slug, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
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
  // The apex dispatcher's one call: which workspace, and does it still need an agent? null = no
  // company yet. Only an owner/admin can connect one, so a member — or a leftover client, whom the
  // tenant shell turns away — goes straight to the tenant whether or not the row exists.
  lobby: sessionProcedure.handler(async ({ context }) => {
    const row = await oneMembership(context.user.id);
    if (!row) return null;
    return { slug: row.slug, needsAgent: isAdmin(row.role) && !(await sapConnectionExists(row.tenantId)) };
  }),
  connect: sessionProcedure
    .input(z.object({
      agentUrl: z.url(),
      secret: z.string().min(1),
      accessClientId: z.string().nullable().optional(),
      accessClientSecret: z.string().nullable().optional(),
      beasEnabled: z.boolean().optional(),
    }))
    .handler(async ({ input, context }) => {
      const tenantId = await ownedTenant(context.user.id);
      await upsertSapConnection(tenantId, {
        agentUrl: input.agentUrl,
        secret: input.secret,
        accessClientId: input.accessClientId || null,
        accessClientSecret: input.accessClientSecret || null,
        beasEnabled: input.beasEnabled ?? false,
      });
    }),

  // Settings: the same row, edited after onboarding from the tenant subdomain — so host-scoped
  // (adminProcedure) rather than ownedTenant's "first org" lookup. Secrets never come back out:
  // the Access secret is shown once by Cloudflare and the agent secret lives in agent.json, so
  // a blank field means "keep", and changing only the URL never forces either to be re-entered.
  // ponytail: assumes the same company DB behind the new URL — localCurrency, entity_meta and the
  // masterdata cache are not reset. Clear them here if repointing at another company becomes real.
  agent: adminProcedure.handler(async ({ context }) => {
    const [row] = await db
      .select({
        agentUrl: sapConnection.agentUrl,
        accessClientId: sapConnection.accessClientId,
        beasEnabled: sapConnection.beasEnabled,
      })
      .from(sapConnection)
      .where(eq(sapConnection.tenantId, context.tenantId))
      .limit(1);
    if (!row) throw new ORPCError("NOT_FOUND", { message: "No agent is connected yet — finish onboarding first." });
    return row;
  }),
  reconfigure: adminProcedure
    .input(z.object({
      agentUrl: z.url(),
      secret: z.string().optional(),
      accessClientId: z.string().nullable(),
      accessClientSecret: z.string().optional(),
      beasEnabled: z.boolean(),
    }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(sapConnection)
        .set({
          agentUrl: input.agentUrl,
          beasEnabled: input.beasEnabled,
          accessClientId: input.accessClientId || null,
          ...(input.secret ? { secret: encryptSecret(input.secret) } : {}),
          // No client ID turns Access off, so its secret goes with it; otherwise blank keeps it.
          ...(!input.accessClientId ? { accessClientSecret: null }
            : input.accessClientSecret ? { accessClientSecret: input.accessClientSecret } : {}),
        })
        .where(eq(sapConnection.tenantId, context.tenantId))
        .returning({ tenantId: sapConnection.tenantId });
      if (!row) throw new ORPCError("NOT_FOUND", { message: "No agent is connected yet — finish onboarding first." });
    }),
};
