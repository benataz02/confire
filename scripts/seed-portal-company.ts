/**
 * A customer company on a dev tenant's portal, with an owner who can sign in — the portal side of
 * seed-dev. Run seed-dev first: the tenant has to exist.
 *
 *   SLUG=alumigraf CARD_CODE=C20000 PORTAL_EMAIL=kunde@c20000.test bun run seed:portal
 *
 * Not EMAIL/PASSWORD: those are seed-dev's internal login, and .env usually sets them.
 *
 * The CardCode should be a customer or lead in the tenant's B1, or the company page has no live
 * summary. The email's domain is registered to the company (unless it is free mail), so a second
 * address on it auto-joins as viewer. Idempotent: re-running skips whatever already exists.
 */
import { and, eq } from "drizzle-orm";
import { db, organization, pool, portalCompany, user as userTable } from "@confire/db";
import { auth } from "../apps/server/src/auth.ts";
import { addPortalMember, claimDomain, emailDomain } from "../apps/server/src/portal/members.ts";
import { portalTenantUrl } from "../apps/server/src/tenant.ts";

const slug = process.env.SLUG ?? "alumigraf";
const cardCode = process.env.CARD_CODE ?? "C20000";
const cardName = process.env.CARD_NAME ?? "Dev Kunde GmbH";
const email = (process.env.PORTAL_EMAIL ?? `kunde@${cardCode.toLowerCase()}.test`).toLowerCase();
const password = process.env.PORTAL_PASSWORD ?? "dev12345";

async function main(): Promise<void> {
  const [tenant] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1);
  if (!tenant) throw new Error(`No tenant '${slug}': run seed:dev first`);

  const [company] = await db.insert(portalCompany)
    .values({ tenantId: tenant.id, cardCode, cardName, cardType: "cCustomer" })
    .onConflictDoNothing()
    .returning();
  const companyId = company?.id ?? (await db.select({ id: portalCompany.id }).from(portalCompany)
    .where(and(eq(portalCompany.tenantId, tenant.id), eq(portalCompany.cardCode, cardCode))))[0]!.id;
  console.log(`company ${cardCode} ${company ? `(created as '${cardName}')` : "(already existed)"}`);

  const [existing] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email)).limit(1);
  // A seeded login is verified at birth, as in seed-dev: whoever runs the seed owns the address.
  const userId = existing?.id ?? (await auth.api.signUpEmail({ body: { email, password, name: "Dev Kunde" } })).user.id;
  await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, userId));
  console.log(`user    ${email} / ${existing ? "(existing password)" : password}`);

  const domain = await db.transaction(async (tx) => {
    await addPortalMember(tx, { tenantId: tenant.id, companyId, userId, role: "owner" });
    return claimDomain(tx, { tenantId: tenant.id, companyId, domain: emailDomain(email), addedBy: null });
  });
  console.log(`domain  ${emailDomain(email)}: ${typeof domain === "object" ? `registered to ${domain.takenBy}` : domain}`);

  console.log(`\nopen: ${portalTenantUrl(slug)} (sign-in sends you back there)`);
}

await main();
await pool.end();
