import { eq } from "drizzle-orm";
import { db, portalSettings, type PortalSettings } from "@confire/db";

// The tenant's portal settings document (spec §6), loaded and saved whole. Both processes read it:
// the internal Settings → Portal tab writes it, the portal's document reads apply it.

export async function loadPortalSettings(tenantId: string): Promise<PortalSettings> {
  const [row] = await db.select({ settings: portalSettings.settings }).from(portalSettings)
    .where(eq(portalSettings.tenantId, tenantId)).limit(1);
  return row?.settings ?? {};
}

export async function savePortalSettings(tenantId: string, settings: PortalSettings): Promise<void> {
  const updatedAt = new Date();
  await db.insert(portalSettings).values({ tenantId, settings, updatedAt })
    .onConflictDoUpdate({ target: portalSettings.tenantId, set: { settings, updatedAt } });
}
