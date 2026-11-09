import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configModel } from "@confire/db";
import { diffModel, itemsTable, type ModelDef } from "@confire/config-engine";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// checkModel refuses a model with no items grid, and TEST_MODEL is stored directly elsewhere.
const VALID: ModelDef = { ...TEST_MODEL, tables: [itemsTable()] };
const relabel = (d: ModelDef, key: string, label: string): ModelDef =>
  ({ ...d, parameters: d.parameters.map((p) => (p.key === key ? { ...p, label } : p)) });

describe.skipIf(!process.env.DATABASE_URL)("models.save (integration)", () => {
  test("refuses a tenant visual written for another workspace", async () => {
    const { tenantId, slug } = await makeTenant(); // a `t…` slug, never hera
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const SHEET_INPUTS = { sheetLength: "1000", sheetWidth: "500", pieceLength: "120", pieceWidth: "70", gapX: "3", gapY: "3", marginX: "10", marginY: "10" };
    const [sec] = VALID.structure.sections;
    const withVisual: ModelDef = {
      ...VALID,
      visuals: [{ key: "hoja", kind: "hera.sheetLayout", inputs: SHEET_INPUTS }],
      structure: { sections: [{ ...sec!, groups: [{ ...sec!.groups[0]!, params: [...sec!.groups[0]!.params, "hoja"] }] }] },
    };
    const err = await call(router.models.create, { definition: withVisual }, ctx)
      .then(() => null, (e: unknown) => e as { data?: { issues?: { path: string }[] } });
    expect(err?.data?.issues?.map((i) => i.path)).toContain("visuals[0].kind");
  });

  test("two admins' patches of different parameters both stand; the answer is only updatedAt", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const created = await call(router.models.create, { definition: VALID }, ctx);

    // Both diffed against the definition they loaded, neither seeing the other's edit.
    const a = await call(router.models.save, { id: created.id, patch: diffModel(VALID, relabel(VALID, "material", "Mat")) }, ctx);
    await call(router.models.save, { id: created.id, patch: diffModel(VALID, relabel(VALID, "coated", "Coat")) }, ctx);
    expect(Object.keys(a)).toEqual(["updatedAt"]);

    const [row] = await db.select().from(configModel).where(eq(configModel.id, created.id));
    expect(row!.definition.parameters.map((p) => p.label)).toEqual(["Mat", "Coat"]);
    expect(row!.updatedAt.getTime()).toBeGreaterThanOrEqual(a.updatedAt.getTime());
  });

  test("refuses a patch whose merged model fails the gate, and stores nothing", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const created = await call(router.models.create, { definition: VALID }, ctx);
    const broken = { ...VALID, parameters: VALID.parameters.map((p) => (p.key === "coated" ? { ...p, visibleWhen: "nope" } : p)) };

    await expect(call(router.models.save, { id: created.id, patch: diffModel(VALID, broken) }, ctx)).rejects.toThrow("Model has errors");
    const [row] = await db.select().from(configModel).where(eq(configModel.id, created.id));
    expect(row!.definition.parameters[1]!.visibleWhen).toBeUndefined();
  });

  test("the portal columns save alone without moving updatedAt; a definition change moves it", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };
    const created = await call(router.models.create, { definition: VALID, portal: false, portalPricing: "request" }, ctx);

    const published = await call(router.models.save, { id: created.id, patch: {}, portal: true, portalPricing: "indicative" }, ctx);
    const [row] = await db.select().from(configModel).where(eq(configModel.id, created.id));
    expect(row!.portal).toBe(true);
    expect(row!.portalPricing).toBe("indicative");
    expect(published.updatedAt.getTime()).toBe(created.updatedAt.getTime());
    expect(row!.updatedAt.getTime()).toBe(created.updatedAt.getTime());

    const renamed = await call(router.models.save, { id: created.id, patch: { name: "Renamed" } }, ctx);
    expect(renamed.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
    const [after] = await db.select().from(configModel).where(eq(configModel.id, created.id));
    expect(after!.portal).toBe(true);
  });

  test("another tenant's model is not found", async () => {
    const mine = await makeTenant();
    const other = await makeTenant();
    const admin = await makeUser("admin", mine.tenantId);
    const [m] = await db.insert(configModel).values({ tenantId: other.tenantId, name: "X", definition: VALID }).returning({ id: configModel.id });
    await expect(call(router.models.save, { id: m!.id, patch: { name: "Mine" } }, { context: { headers: tenantHeaders(mine.slug, admin.cookie) } }))
      .rejects.toThrow();
    const [row] = await db.select().from(configModel).where(eq(configModel.id, m!.id));
    expect(row!.name).toBe("X");
  });
});
