import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

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
  /** The engine `/print` uses (print spec §5.1): the SAP API Gateway, or Direct — Crystal run by
   *  the agent's confire-print.exe — only once the agent reports it set up (`sap.setPrintEngine`). */
  printEngine: text("print_engine", { enum: ["gateway", "crystal"] }).notNull().default("gateway"),
  /** The home's open-document counts, one read shared by the whole workspace (open-counts.ts): by
   *  entity set, with the company that answered and when — a count of another company is no count. */
  openCounts: jsonb("open_counts").$type<{ company: string | null; at: string; counts: Record<string, number> }>(),
  status: text("status", { enum: ["ok", "error"] }).notNull().default("ok"),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastError: text("last_error"),
});

export type SapConnection = typeof sapConnection.$inferSelect;
export type PrintEngine = SapConnection["printEngine"];

/** What `sap_cache` holds, one kind per copy of SAP data (spec 2026-11-09-sap-cache-design.md). */
export const CACHE_KINDS = [
  "schema", "entity_list", "beas_schemas", "currency", "open_counts", "print_layout", "masterdata", "price_list", "report",
] as const;
export type CacheKind = (typeof CACHE_KINDS)[number];

// Everything Confire keeps from SAP, in one table; apps/server/src/sap-cache.ts is its only reader
// and writer. `seq` 0 is the entry: its `company`, `fetched_at` and `error` say whether it may be
// used, and a one-value kind keeps its value in `data`. A many-row kind (masterdata, price_list)
// keeps its SAP rows at seq 1..n in the read's order, which is what replays a query's own orderby.
// An entry whose company is not `sap_connection.company_db` is no entry, so a refill of the old
// company landing after a switch is never served; the switch itself deletes the tenant's rows.
export const sapCache = pgTable(
  "sap_cache",
  {
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").$type<CacheKind>().notNull(),
    key: text("key").notNull().default(""),
    seq: integer("seq").notNull().default(0),
    /** the company the SAP call carried; null in dev before an agent names one */
    company: text("company"),
    data: jsonb("data").$type<unknown>(),
    /** the last refresh's failure; the data and fetched_at stay the last good read's */
    error: text("error"),
    /** when SAP answered; null while no read has succeeded */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.kind, t.key, t.seq] })],
);
