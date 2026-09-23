import { eq } from "drizzle-orm";
import { db, sapConnection } from "@confire/db";
import { encryptSecret } from "./crypto.ts";

export type AgentSeed = {
  agentUrl: string;
  secret: string;
  accessClientId?: string | null;
  accessClientSecret?: string | null;
  beasEnabled?: boolean;
};

export async function upsertSapConnection(tenantId: string, seed: AgentSeed): Promise<void> {
  const row = {
    tenantId,
    agentUrl: seed.agentUrl,
    secret: encryptSecret(seed.secret),
    accessClientId: seed.accessClientId ?? null,
    accessClientSecret: seed.accessClientSecret ?? null,
    beasEnabled: seed.beasEnabled ?? false,
    status: "ok" as const,
  };
  await db.insert(sapConnection).values(row).onConflictDoUpdate({ target: sapConnection.tenantId, set: row });
}

/** True when this tenant already has an agent row. No decrypt — onboarding only needs the bit. */
export async function sapConnectionExists(tenantId: string): Promise<boolean> {
  const [hit] = await db
    .select({ tenantId: sapConnection.tenantId })
    .from(sapConnection)
    .where(eq(sapConnection.tenantId, tenantId))
    .limit(1);
  return !!hit;
}
