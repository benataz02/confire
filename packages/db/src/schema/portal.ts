import { foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { user } from "./auth.ts";

// The customer portal (spec docs/superpowers/specs/2026-10-07-portal-redesign.md §4, §6): companies and
// their domains. Hand-written. A seat is not here: a customer is a Better Auth `member` of the
// supplier's organization whose role is its portal role (`portal_buyer`) and whose `cardCode` is its
// company (spec 2026-10-19-path-tenancy-design.md), and an invitation is Better Auth's `invitation`
// with the same two. A company has no id of its own: it is (tenant, CardCode).

export type PortalCardType = "cCustomer" | "cLid";
/** A customer's role in their company, as the API and the UI name it. */
export const PORTAL_ROLES = ["owner", "buyer", "viewer"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];
/** The same role as `member.role`/`invitation.role` store it. Prefixed so it is never a staff role:
 *  Better Auth compares role names exactly (split on `,`), so `portal_owner` is not its `owner`. */
export const externalRole = (r: PortalRole) => `portal_${r}` as const;
/** Every customer role. Any other `member.role` (owner, admin, member) is staff. */
export const EXTERNAL_ROLES = PORTAL_ROLES.map(externalRole);
/** The other way, in SQL: a customer's `member.role`/`invitation.role` as its PortalRole. */
export const portalRoleOf = (role: AnyPgColumn) => sql<PortalRole>`replace(${role}, 'portal_', '')`;
/** The SAP document fields a tenant shows its clients (D19), per entity, in display order. */
export type PortalDocFields = { header: string[]; lines: string[] };
/** A BusinessPartners field an admin adds to the new-client onboarding form (§5.3), in form order. */
export type PortalExtraField = { key: string; required: boolean };
/** The supplier's look on its portal and in its client mail (D20). Absent keys fall back to the
 *  organization's name and logo, and Horizon's own colours. */
export type PortalBranding = { displayName?: string; accent?: string; logoFileId?: string };
/** `portal_settings.settings` (spec §6): one document, loaded and saved whole. P5 writes `docFields`,
 *  P6 `onboarding` and `leadSeries` (a B1 BP numbering series; absent = B1's default for leads), P7
 *  the branding. Who hears of what is each user's own setting (notification_optout), not this. */
export type PortalSettings = {
  docFields?: Partial<Record<string, PortalDocFields>>;
  onboarding?: { extraFields: PortalExtraField[] };
  leadSeries?: number;
  branding?: PortalBranding;
};

/** A customer company: one per tenant × CardCode, the register of which CardCodes are on the portal
 *  (§4.2). Created server-side only — by an invitation or an onboarding submit — never by a call a
 *  portal user can make. Plain Confire table, not a Better Auth organization or team: its people are
 *  the supplier's customer members (`portal_*` roles) whose `cardCode` names it, in its tenant. */
export const portalCompany = pgTable(
  "portal_company",
  {
    tenantId: text("tenant_id").notNull(),
    cardCode: text("card_code").notNull(),
    cardName: text("card_name").notNull(),
    cardType: text("card_type").$type<PortalCardType>().notNull(),
    /** The BP's SAP language, `BusinessPartners.LanguageCode` → `UserLanguages.Code`: what its mail is
     *  written in (mail/layout.tsx `mailLang`). Copied whenever Confire reads or writes the BP — an
     *  invitation, an onboarding submit, an edit on the Object Page. ponytail: a change made in SAP
     *  itself lands at the next of those; re-read it at send time if that lag ever matters. */
    languageCode: integer("language_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.cardCode] })],
);

/** The auto-join index (§4.4): a verified sign-in on this domain joins this company as `viewer`.
 *  The primary key is what stops one domain mapping to two companies. Written only by internal
 *  users: a company cannot claim a domain itself, or a lead that registered a competitor's domain
 *  would capture that competitor's staff. */
export const portalCompanyDomain = pgTable(
  "portal_company_domain",
  {
    tenantId: text("tenant_id").notNull(),
    domain: text("domain").notNull(),
    cardCode: text("card_code").notNull(),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.domain] }),
    foreignKey({ name: "portal_company_domain_company_fk", columns: [t.tenantId, t.cardCode], foreignColumns: [portalCompany.tenantId, portalCompany.cardCode] })
      .onDelete("cascade"),
    index("portal_company_domain_company_idx").on(t.tenantId, t.cardCode),
  ],
);

/** The tenant's portal settings (spec §6): one jsonb document loaded and saved whole, the CLAUDE.md
 *  convention for configuration. Written only through apps/server/src/portal/settings.ts. */
export const portalSettings = pgTable("portal_settings", {
  tenantId: text("tenant_id").primaryKey(),
  settings: jsonb("settings").$type<PortalSettings>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
