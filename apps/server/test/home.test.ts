import { expect, test } from "bun:test";
import { db, configMasterdata, configModel, configProject, invitation } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// The home page's counts: each one the caller's or the workspace's, never another tenant's.

test("home.overview counts the caller's own work and the workspace's to-dos", async () => {
  const t = await makeTenant();
  const me = await makeUser("member", t.tenantId);
  const other = await makeUser("member", t.tenantId);
  const [m] = await db.insert(configModel).values({ tenantId: t.tenantId, name: "Cable", definition: TEST_MODEL }).returning();
  const p = (v: Partial<typeof configProject.$inferInsert>) =>
    ({ tenantId: t.tenantId, modelId: m!.id, name: "p", createdBy: me.userId, ...v });
  const lastYear = new Date(Date.now() - 400 * 86_400_000);
  await db.insert(configProject).values([
    p({}), // my draft
    p({ createdBy: other.userId }), // a colleague's draft: the workspace's, not mine
    p({ portalCardCode: "C1" }), // a client's draft: invisible to staff
    p({ portalCardCode: "C1", status: "submitted" }), // a new request
    p({ portalCardCode: "C1", status: "in_review", assigneeId: me.userId }),
    p({ status: "quoted", quotedAt: new Date(), quotedValue: "1200.50" }),
    p({ portalCardCode: "C1", status: "quoted", assigneeId: me.userId, quotedAt: new Date(), quotedValue: "800" }),
    p({ status: "quoted", quotedAt: lastYear, quotedValue: "999" }), // not this month
    p({ status: "quoted", createdBy: other.userId, quotedAt: new Date(), quotedValue: "5" }), // not mine
  ]);
  await db.insert(configMasterdata).values([
    { tenantId: t.tenantId, name: "ok", kind: "query" },
    { tenantId: t.tenantId, name: "bad", kind: "query", syncError: "agent down" },
  ]);
  const inv = (expiresAt: Date) => ({
    id: crypto.randomUUID(), organizationId: t.tenantId, email: `${crypto.randomUUID()}@kunde.de`,
    role: "portal_buyer", status: "pending", expiresAt, inviterId: me.userId,
  });
  await db.insert(invitation).values([inv(new Date(Date.now() + 86_400_000)), inv(lastYear)]);

  // Another tenant's rows count nowhere.
  const t2 = await makeTenant();
  await db.insert(configProject).values({ tenantId: t2.tenantId, modelId: m!.id, name: "x", createdBy: me.userId });

  const r = await call(router.home.overview, undefined, { context: { headers: tenantHeaders(t.slug, me.cookie) } });
  expect(r).toEqual({
    myDrafts: 1, myInReview: 1, myQuoted: 2, myQuotedValue: 2000.5,
    drafts: 2, newRequests: 1, models: 1, syncErrors: 1, openInvitations: 1,
  });
});
