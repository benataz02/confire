import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { B1EntitySchema } from "@confire/b1";

// One row per tenant: where that tenant's on-prem agent is and how to authenticate to it, written by
// pairing (apps/server/src/agent-pairing.ts). agentUrl is http://localhost:<port> in dev and
// https://<label>.<AGENT_DOMAIN> in production; that difference is this row, not a branch in the code.
// The Cloudflare Access service token is one for every tenant, so it is server env, not a column.
export const sapConnection = pgTable("sap_connection", {
  tenantId: text("tenant_id").primaryKey(),
  agentUrl: text("agent_url").notNull(),
  /** Bearer secret the agent checks. Encrypted at rest (see apps/server/src/crypto.ts). */
  secret: text("secret").notNull(),
  /** The Cloudflare tunnel pairing created; null in dev. A re-pair retires it (cloudflare.ts). */
  tunnelId: text("tunnel_id"),
  /** The company the agent last said it serves. The agent owns it (agent.json `companyDb`): Confire
   *  sends it on every call and adopts the agent's answer when they differ (b1.ts `adoptCompany`). */
  companyDb: text("company_db"),
  /** B1's local currency (OADM.MainCurncy), read once from CompanyService_GetAdminInfo. A company's
   *  local currency is fixed when its database is created, so — like entity_meta below — there is
   *  no TTL; null only means "not read yet". */
  localCurrency: text("local_currency"),
  status: text("status", { enum: ["ok", "error"] }).notNull().default("ok"),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export type SapConnection = typeof sapConnection.$inferSelect;

// Parsed B1 entity schemas, cached per tenant. B1's own $metadata is the source of truth, but a
// row here is kept until someone presses Refresh — there is no TTL, because metadata changes when
// an admin adds a UDF, not on a clock. fetchedAt is only read against entity-meta.ts' PARSER_EPOCH.
// ponytail: manual refresh only; no push-invalidation until a stale-UDF bug actually appears.
export const entityMeta = pgTable(
  "entity_meta",
  {
    tenantId: text("tenant_id").notNull(),
    entityName: text("entity_name").notNull(),
    json: jsonb("json").$type<B1EntitySchema>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.entityName] })],
);
