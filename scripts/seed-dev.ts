/**
 * Bootstrap a dev tenant from an empty database: a user + the org whose slug IS the workspace's
 * path. Sign in at http://localhost:5173/login, land on http://localhost:5173/<slug>/configs.
 *
 *   bun run seed:dev [slug] [email] [password]
 *
 * Standard views are declared in code (apps/app/src/features), so there is nothing to seed for
 * them. Idempotent: re-running skips whatever already exists.
 */
import { eq } from "drizzle-orm";
import { db, pool, organization, user as userTable } from "@confire/db";
import { auth } from "../apps/server/src/auth.ts";
import { appTenantUrl, authUrl } from "../apps/server/src/tenant.ts";

const slug = process.env.SLUG ?? "alumigraf";
const email = process.env.EMAIL ?? `dev@${slug}.test`;
const password = process.env.PASSWORD ?? "dev12345";

async function main(): Promise<void> {
  const [existingUser] = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, email))
    .limit(1);

  // A seeded login is verified at birth: whoever runs the seed owns it, and sign-in requires a
  // verified email (auth.ts). An existing unverified user is left alone — it gets a fresh link on
  // its next sign-in, printed by the console mailer.
  const userId = existingUser?.id ?? (await createVerifiedUser());
  console.log(`user  ${email} / ${password}`);

  const [existingOrg] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);

  if (existingOrg) {
    console.log(`org   ${slug} (already existed)`);
  } else {
    await auth.api.createOrganization({
      body: { name: slug, slug, userId },
    });
    console.log(`org   ${slug} (created)`);
  }

  console.log(`\nsign in: ${authUrl}/login  ->  ${appTenantUrl(slug)}`);
}

async function createVerifiedUser(): Promise<string> {
  const { user } = await auth.api.signUpEmail({ body: { email, password, name: "Dev User" } });
  await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, user.id));
  return user.id;
}

await main();
await pool.end();
