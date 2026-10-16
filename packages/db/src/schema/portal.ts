import { index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// The customer portal (spec docs/superpowers/specs/2026-10-07-portal-redesign.md §4, §6).
// Hand-written: the portal's Better Auth instance has no generate target. It adds one core table
// (portalSession); user, account and verification stay owned by the generated auth.ts and are shared.

/** Better Auth's `session` columns, minus `activeOrganizationId` (the portal has no organization
 *  plugin). The portal instance sets `session.modelName: "portalSession"`, and the drizzle adapter
 *  resolves schema[modelName] — so the export key, not the SQL name, is what has to match.
 *  A separate table means a portal session can never authenticate an internal request. */
export const portalSession = pgTable(
  "portal_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("portal_session_userId_idx").on(t.userId)],
);

export type PortalCardType = "cCustomer" | "cLid";
export type PortalRole = "owner" | "buyer" | "viewer";

/** A customer company: one per tenant × CardCode, the register of which CardCodes are on the portal
 *  (§4.2). Created server-side only — by an invitation or an onboarding submit — never by a call a
 *  portal user can make. Plain Confire table, not a Better Auth organization. */
export const portalCompany = pgTable(
  "portal_company",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id").notNull(),
    cardCode: text("card_code").notNull(),
    cardName: text("card_name").notNull(),
    cardType: text("card_type").$type<PortalCardType>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("portal_company_tenant_card_uq").on(t.tenantId, t.cardCode)],
);

/** A portal user's seat in a company. The unique (tenantId, userId) index IS "one company per user
 *  per tenant": a constraint rather than a hook, so a concurrent join and accept cannot both win.
 *  tenantId is copied from the company for exactly that index. */
export const portalMember = pgTable(
  "portal_member",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => portalCompany.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    role: text("role").$type<PortalRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.companyId, t.userId] }),
    uniqueIndex("portal_member_tenant_user_uq").on(t.tenantId, t.userId),
  ],
);
