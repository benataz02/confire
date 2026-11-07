import { makeTenant, makeUser } from "../apps/server/test/harness.ts";
const t = await makeTenant();
const u = await makeUser("admin", t.tenantId);
console.log(JSON.stringify({ slug: t.slug, u }));
process.exit(0);
