/**
 * Point a tenant at an agent by hand, skipping pairing — for a dev agent whose agent.json you wrote
 * yourself. Pairing (`go run ./apps/agent setup --server http://localhost:3000 …`) writes the same
 * row and is the normal way, in dev too.
 *
 *   bun --env-file=.env scripts/seed-agent.ts <slug> [agentUrl] [secret] [--company=SBODEMOUS]
 *
 * The secret must match `secret` in the agent's agent.json; it is stored encrypted. The company may
 * be left out: the agent answers the first call with its own and Confire adopts it.
 */
import { eq } from "drizzle-orm";
import { db, pool, organization } from "@confire/db";
import { upsertSapConnection } from "../apps/server/src/seed-agent.ts";

const [slug, agentUrl = "http://localhost:4000", secret = "dev-secret-change-me-min-32-chars-long"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const companyDb = process.argv.find((a) => a.startsWith("--company="))?.slice("--company=".length) ?? null;

if (!slug) {
  console.error("usage: bun scripts/seed-agent.ts <slug> [agentUrl] [secret] [--company=]");
  process.exit(1);
}

const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
if (!org) {
  console.error(`no organization with slug '${slug}' — run seed:dev first`);
  process.exit(1);
}

await upsertSapConnection(org.id, { agentUrl, secret, companyDb });
console.log(`${slug} -> ${agentUrl}${companyDb ? ` (${companyDb})` : ""}`);
await pool.end();
