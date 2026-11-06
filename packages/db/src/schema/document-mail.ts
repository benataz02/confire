import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Document mail (spec docs/superpowers/specs/2026-11-06-document-mail-design.md §5.1): a workspace's
// Microsoft 365 mailbox, which its quotations, orders, deliveries and invoices are sent from, and
// what each document type's "Notify the client" switch starts as. One row per tenant, written only by
// apps/server/src/document-mail.ts.

export const DOCUMENT_MAIL_TYPES = ["Quotations", "Orders", "DeliveryNotes", "Invoices"] as const;
export type DocumentMailType = (typeof DOCUMENT_MAIL_TYPES)[number];

/** One jsonb document, loaded and saved whole (the CLAUDE.md convention). An absent type is a switch
 *  that starts off and sends from the connected account. */
export type DocumentMailSettings = {
  types: Partial<Record<DocumentMailType, { notify: boolean; from?: string }>>;
};

export const documentMail = pgTable("document_mail", {
  tenantId: text("tenant_id").primaryKey(),
  settings: jsonb("settings").$type<DocumentMailSettings>().notNull().default({ types: {} }),
  /** The connected mailbox (`/me` mail, else its userPrincipalName); null = not connected. */
  account: text("account"),
  /** The customer's Entra tenant (`tid`). */
  msTenantId: text("ms_tenant_id"),
  /** Encrypted at rest (crypto.ts encryptSecret) and never selected into an answer. */
  refreshToken: text("refresh_token"),
  connectedBy: text("connected_by"),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  /** The last token failure (`invalid_grant` …): what the Settings card's Reconnect explains. */
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
