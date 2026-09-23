import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, member, organization } from "@confire/db";
import { sessionProcedure } from "../base.ts";
import { sapConnectionExists, upsertSapConnection } from "../../seed-agent.ts";
import { seedDefaultNavPins } from "./entities.ts";

/** Apex onboarding has no tenant Host — the user's one org is the tenant. */
async function ownedTenant(userId: string): Promise<string> {
  const [row] = await db
    .select({ tenantId: organization.id, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .limit(1);
  if (!row || (row.role !== "owner" && row.role !== "admin")) throw new ORPCError("FORBIDDEN");
  return row.tenantId;
}

export const sapRouter = {
  connection: sessionProcedure.handler(async ({ context }) => ({
    connected: await sapConnectionExists(await ownedTenant(context.user.id)),
  })),
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
      // First connect only — a later reconnect must not restore pins the admin removed.
      await seedDefaultNavPins(tenantId, context.user.id);
    }),
};
