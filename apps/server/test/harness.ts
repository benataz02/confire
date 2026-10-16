import { eq } from "drizzle-orm";
import { db, member, organization, portalCompany, portalMember, user, type PortalRole } from "@confire/db";
import type { ModelDef } from "@confire/config-engine";
import { auth } from "../src/auth.ts";
import { portalAuth } from "../src/portal/auth.ts";
import { baseDomain, portalBaseDomain } from "../src/tenant.ts";

export { call } from "@orpc/server";

const uid = () => crypto.randomUUID().slice(0, 8);

export async function makeTenant(): Promise<{ tenantId: string; slug: string }> {
  const slug = `t${uid()}`;
  const tenantId = crypto.randomUUID();
  await db.insert(organization).values({ id: tenantId, name: slug, slug, createdAt: new Date() });
  return { tenantId, slug };
}

export async function makeUser(
  role?: "member" | "admin" | "owner" | "client",
  tenantId?: string,
): Promise<{ userId: string; email: string; cookie: string; cookies: string }> {
  const email = `u${uid()}@test.local`;
  // Sign-up opens no session while email verification is required (auth.ts), so the harness
  // verifies the address the way the emailed link would, then signs in for the cookies.
  await auth.api.signUpEmail({ body: { email, password: "test1234", name: email } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  const res = await auth.api.signInEmail({
    body: { email, password: "test1234" },
    returnHeaders: true,
  });
  // First cookie is session_token (what most tests send). `cookies` is the full Cookie header
  // including session_data — that's the Better Auth cookie cache, and the hole requireSession
  // has to punch through.
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  const cookie = cookies.split("; ")[0] ?? res.headers.get("set-cookie")!.split(";")[0]!;
  const userId = res.response.user.id;
  if (role && tenantId) {
    await db.insert(member).values({
      id: crypto.randomUUID(), organizationId: tenantId, userId, role, createdAt: new Date(),
    });
  }
  return { userId, email, cookie, cookies };
}

export const tenantHeaders = (slug: string, cookie?: string): Headers =>
  new Headers({ "x-forwarded-host": `${slug}.${baseDomain}`, ...(cookie ? { cookie } : {}) });

// --- customer portal (apps/server/src/portal) ---------------------------------------------------

/** Signs `email` in on the portal instance — the same user row, a portal_session row and cookie. */
export async function portalSignIn(email: string): Promise<string> {
  const res = await portalAuth.api.signInEmail({ body: { email, password: "test1234" }, returnHeaders: true });
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
}

/** A verified user who signed up on the portal (no internal membership anywhere). */
export async function makePortalUser(email = `p${uid()}@test.local`): Promise<{ userId: string; email: string; cookie: string }> {
  const { user: u } = await portalAuth.api.signUpEmail({ body: { email, password: "test1234", name: email } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, u.id));
  return { userId: u.id, email, cookie: await portalSignIn(email) };
}

export const portalHeaders = (slug: string, cookie?: string): Headers =>
  new Headers({ "x-forwarded-host": `${slug}.${portalBaseDomain}`, ...(cookie ? { cookie } : {}) });

/** A customer company with one seat, inserted directly rather than through addPortalMember: the
 *  builder tests need a seat even for staff, which addPortalMember refuses. */
export async function makePortalSeat(tenantId: string, userId: string, role: PortalRole, cardName = "Kunde GmbH") {
  const [company] = await db.insert(portalCompany)
    .values({ tenantId, cardCode: `C${uid()}`, cardName, cardType: "cCustomer" })
    .returning();
  await db.insert(portalMember).values({ companyId: company!.id, userId, tenantId, role });
  return company!;
}

// Agent-free model (no query masterdata, no query domains): runs entirely from manual options.
export const TEST_MODEL: ModelDef = {
  name: "Cable",
  parameters: [
    {
      key: "material", label: "Material", type: "string", ui: "select",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "steel" }, { value: "alu" }] } },
    },
    { key: "coated", label: "Coated", type: "boolean", ui: "checkbox", defaultExpr: "false" },
  ],
  structure: {
    sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["material", "coated"] }] }],
  },
  computed: [],
  constraints: [],
  // No BOM: a priced BOM is a live price-list read, and the tests that use this model are the
  // ones that must resolve without an agent. BOM pricing is covered in config-engine's own tests.
  bom: [],
  routing: [{ id: "cut", resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" }],
  pricing: { priceExpr: "unitCost * 1.4", quoteItemCode: "CFG", priceList: 1 },
  batchDefaults: [100, 500],
};
