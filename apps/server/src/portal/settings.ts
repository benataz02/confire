import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { db, organization, portalSettings, type PortalSettings, type SenderDomain } from "@confire/db";
import type { Brand } from "../mail/layout.tsx";
import { portalUrl } from "../tenant.ts";

// The tenant's portal settings document (spec §6), loaded and saved whole. Both processes read it:
// the internal Settings → Portal tab writes it, the portal's document reads apply it.

export async function loadPortalSettings(tenantId: string): Promise<PortalSettings> {
  const [row] = await db.select({ settings: portalSettings.settings }).from(portalSettings)
    .where(eq(portalSettings.tenantId, tenantId)).limit(1);
  return row?.settings ?? {};
}

/** Everything but `senderDomain`: that key is the sender-domain handlers' (portal/sender-domain.ts),
 *  and a save of the rest keeps whatever they stored meanwhile. */
export async function savePortalSettings(tenantId: string, settings: PortalSettings): Promise<void> {
  const { senderDomain: _ours, ...rest } = settings;
  const updatedAt = new Date();
  await db.insert(portalSettings).values({ tenantId, settings: rest, updatedAt })
    .onConflictDoUpdate({
      target: portalSettings.tenantId,
      set: { settings: sql`excluded.settings || jsonb_build_object('senderDomain', ${portalSettings.settings}->'senderDomain')`, updatedAt },
    });
}

/** Store (or, with null, clear) the tenant's sender domain — one key, merged in SQL. */
export async function setSenderDomain(tenantId: string, d: SenderDomain | null): Promise<void> {
  const updatedAt = new Date();
  await db.insert(portalSettings).values({ tenantId, settings: { senderDomain: d }, updatedAt })
    .onConflictDoUpdate({
      target: portalSettings.tenantId,
      set: { settings: sql`${portalSettings.settings} || ${JSON.stringify({ senderDomain: d })}::jsonb`, updatedAt },
    });
}

/** Resend's latest word on the sender domain, written only while it is still the same domain: a
 *  refresh or a refused send that lands after Remove (or a new Add) cannot bring the old one back. */
export async function updateSenderDomain(tenantId: string, resendDomainId: string, patch: Partial<SenderDomain>) {
  await db.update(portalSettings)
    .set({
      settings: sql`jsonb_set(${portalSettings.settings}, '{senderDomain}', (${portalSettings.settings}->'senderDomain') || ${JSON.stringify(patch)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(portalSettings.tenantId, tenantId),
      sql`${portalSettings.settings}->'senderDomain'->>'resendDomainId' = ${resendDomainId}`,
    ));
}

/** The supplier as its clients see it (D20): its branding over the organization's name and logo.
 *  The logo URL is absolute — a mail has no origin to resolve against — and is the one file the
 *  portal process serves without a session. */
export async function tenantBrand(tenantId: string): Promise<{ slug: string; brand: Brand; settings: PortalSettings }> {
  const [[org], settings] = await Promise.all([
    db.select({ slug: organization.slug, name: organization.name, logo: organization.logo })
      .from(organization).where(eq(organization.id, tenantId)).limit(1),
    loadPortalSettings(tenantId),
  ]);
  if (!org) throw new ORPCError("NOT_FOUND", { message: "No such supplier" });
  const b = settings.branding ?? {};
  return {
    slug: org.slug,
    settings,
    brand: {
      name: b.displayName || org.name,
      // The one file route without a tenant in its path: mail links to it, signed out (files.ts).
      logoUrl: b.logoFileId ? `${portalUrl}/files/${b.logoFileId}` : org.logo,
      ...(b.accent ? { accent: b.accent } : {}),
    },
  };
}

/** WCAG contrast of white text on `#rrggbb`: the accent carries the portal's emphasized buttons and
 *  the mail button, both with white text, so save refuses one under 4.5:1 (D20). */
export function contrastOnWhite(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 1.05 / (0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) + 0.05);
}

/** The D27 events as Settings and the BP page list them. */
export const NOTIFY_LABELS = {
  accepted: "Request accepted (in review)", returned: "Changes requested", declined: "Request declined",
  quoted: "Quotation sent", comment: "Comment or file from your team",
} as const;
