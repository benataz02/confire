/**
 * One-way migration for the List Report / Object Page rewrite: drop the two tables it replaced.
 *
 *   bun --env-file=.env scripts/migrate-views.ts
 *   bun run db:push            # then creates ui_view and ui_user_state
 *
 * Run it BEFORE db:push. EXISTING SAVED VIEWS ARE DISCARDED, deliberately: a ui_variant row is a
 * ListVariantDef (select/filter/orderby/filterBar), not the combined ViewState the new views store,
 * and the Standard rows it mostly held are now declared in code. b1_nav_pin goes with the /b1
 * catalog — the side nav lists the declared features instead.
 *
 * If drizzle-kit push already dropped them itself, this is just the confirmation.
 */
import { pool } from "@confire/db";

for (const table of ["ui_variant", "b1_nav_pin"]) {
  const { rows } = await pool.query<{ n: string }>(`select count(*) as n from information_schema.tables where table_name = $1`, [table]);
  if (rows[0]?.n === "0") {
    console.log(`- ${table}: already gone`);
    continue;
  }
  await pool.query(`drop table ${table}`);
  console.log(`- ${table}: dropped`);
}
await pool.end();
