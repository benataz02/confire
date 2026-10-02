import { describe, expect, test } from "bun:test";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders } from "./harness.ts";

// Saved views: who may publish, who may change what, one name per scope, one default per scope,
// and the active view remembered per user.

const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e as { code?: string }).code ?? "ERR");

const STATE = {
  columns: ["DocNum"], knownColumns: ["DocNum", "CardCode"], sortBy: [], groupBy: [],
  adaptFilterKeys: ["DocNum"], filterValues: { DocNum: 7 }, searchTerm: "",
};

describe.skipIf(!process.env.DATABASE_URL)("views", () => {
  test("a member keeps personal views; shared ones are an admin's to publish and change", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const member = await makeUser("member", tenantId);
    const asAdmin = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const asMember = { context: { headers: tenantHeaders(slug, member.cookie) } };
    const tableId = "b1:Quotations";

    expect(await code(call(router.views.create, { tableId, name: "Mine", visibility: "shared", isDefault: false, state: STATE }, asMember)))
      .toBe("FORBIDDEN");
    const mine = await call(router.views.create, { tableId, name: "Mine", visibility: "personal", isDefault: true, state: STATE }, asMember);
    const team = await call(router.views.create, { tableId, name: "Team", visibility: "shared", isDefault: false, state: STATE }, asAdmin);

    // The member sees their own view and the shared one, may edit only theirs; the new view is active.
    const list = await call(router.views.list, { tableId }, asMember);
    expect(list.views.map((v) => [v.name, v.visibility, v.canEdit])).toEqual([["Mine", "personal", true], ["Team", "shared", false]]);
    expect(list.activeId).toBe(mine.id);
    expect(list.isAdmin).toBe(false);
    expect(await code(call(router.views.update, { id: team.id, name: "Hijacked" }, asMember))).toBe("FORBIDDEN");
    expect(await code(call(router.views.remove, { id: team.id }, asMember))).toBe("FORBIDDEN");
    // …and nobody else's personal view is visible to the admin.
    expect((await call(router.views.list, { tableId }, asAdmin)).views.map((v) => v.name)).toEqual(["Team"]);

    await call(router.views.setActive, { tableId, id: "system:open" }, asMember);
    expect((await call(router.views.list, { tableId }, asMember)).activeId).toBe("system:open");
  });

  test("names are unique per scope; one default per scope; the state is validated", async () => {
    const { tenantId, slug } = await makeTenant();
    const user = await makeUser("member", tenantId);
    const as = { context: { headers: tenantHeaders(slug, user.cookie) } };
    const tableId = "configs";

    const a = await call(router.views.create, { tableId, name: "Open", visibility: "personal", isDefault: true, state: STATE }, as);
    expect(await code(call(router.views.create, { tableId, name: " open ", visibility: "personal", isDefault: false, state: STATE }, as)))
      .toBe("CONFLICT");
    const b = await call(router.views.create, { tableId, name: "Other", visibility: "personal", isDefault: true, state: STATE }, as);
    const views = (await call(router.views.list, { tableId }, as)).views;
    expect(views.find((v) => v.id === a.id)?.isDefault).toBe(false);
    expect(views.find((v) => v.id === b.id)?.isDefault).toBe(true);

    // A list table refuses an object page's layout, and the other way round.
    expect(await code(call(router.views.update, { id: a.id, state: { sections: [] } }, as))).toBe("BAD_REQUEST");
    expect(await code(call(router.views.create, { tableId: "Items::object", name: "L", visibility: "personal", isDefault: false, state: STATE }, as)))
      .toBe("BAD_REQUEST");
    await call(router.views.create, { tableId: "Items::object", name: "L", visibility: "personal", isDefault: false, state: { sections: [] } }, as);
  });

  test("per-user state round-trips, null deletes it, and the active-view key is not writable through it", async () => {
    const { tenantId, slug } = await makeTenant();
    const user = await makeUser("member", tenantId);
    const other = await makeUser("member", tenantId);
    const as = { context: { headers: tenantHeaders(slug, user.cookie) } };
    const key = "cfl:BusinessPartners";

    await call(router.views.setState, { key, value: { columns: ["CardCode"] } }, as);
    expect(await call(router.views.getState, { key }, as)).toEqual({ columns: ["CardCode"] });
    expect(await call(router.views.getState, { key }, { context: { headers: tenantHeaders(slug, other.cookie) } })).toBeNull();
    await call(router.views.setState, { key, value: null }, as);
    expect(await call(router.views.getState, { key }, as)).toBeNull();
    expect(await code(call(router.views.setState, { key: "configs::activeView", value: "x" }, as))).toBe("BAD_REQUEST");
  });
});
