import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, configMasterdata, configModel } from "@confire/db";
import type { ModelDef } from "@confire/config-engine";
import { router } from "../src/orpc/router.ts";
import { call, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";

// The model TEST_MODEL is, with its select fed from masterdata instead of manual options.
const usingTable = (table: string): ModelDef => ({
  ...TEST_MODEL,
  parameters: TEST_MODEL.parameters.map((p) =>
    p.key === "material"
      ? { ...p, domain: { kind: "options", ref: { source: "table", table, valueCol: "code" } } as const }
      : p,
  ),
});

describe.skipIf(!process.env.DATABASE_URL)("masterdata.remove (integration)", () => {
  test("refuses while a model references the table, allows it once nothing does", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    const [t] = await db.insert(configMasterdata).values({
      tenantId, name: "materials", kind: "table",
      columns: [{ key: "code", label: "Code", type: "string" }], rows: [["steel"], ["alu"]],
    }).returning({ id: configMasterdata.id });
    const [m] = await db.insert(configModel)
      .values({ tenantId, name: "Cable", definition: usingTable("materials") })
      .returning({ id: configModel.id });

    await expect(call(router.masterdata.remove, { ids: [t!.id] }, ctx)).rejects.toThrow(/used by model Cable/);
    expect(await db.select().from(configMasterdata).where(eq(configMasterdata.id, t!.id))).toHaveLength(1);

    await db.delete(configModel).where(eq(configModel.id, m!.id));
    await call(router.masterdata.remove, { ids: [t!.id] }, ctx);
    expect(await db.select().from(configMasterdata).where(eq(configMasterdata.id, t!.id))).toHaveLength(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("masterdata.duplicate (integration)", () => {
  test("copies the payload and picks the first free name", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    const columns = [{ key: "code", label: "Code", type: "string" as const }];
    const [t] = await db.insert(configMasterdata).values({
      tenantId, name: "materials", kind: "table", columns, rows: [["steel"], ["alu"]],
    }).returning({ id: configMasterdata.id });

    const first = await call(router.masterdata.duplicate, { id: t!.id }, ctx);
    const [copy] = await db.select().from(configMasterdata).where(eq(configMasterdata.id, first.id));
    expect(copy!.name).toBe("materials (copy)");
    expect(copy!.kind).toBe("table");
    expect(copy!.columns).toEqual(columns);
    expect(copy!.rows).toEqual([["steel"], ["alu"]]);

    // The unique (tenant_id, name) index is what makes this more than cosmetic: a second copy of
    // the same source has to step past the name the first one took.
    const second = await call(router.masterdata.duplicate, { id: t!.id }, ctx);
    const [copy2] = await db.select().from(configMasterdata).where(eq(configMasterdata.id, second.id));
    expect(copy2!.name).toBe("materials (copy 2)");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("masterdata.save (integration)", () => {
  test("a rename is carried into the models naming the table; a taken name is refused", async () => {
    const { tenantId, slug } = await makeTenant();
    const admin = await makeUser("admin", tenantId);
    const ctx = { context: { headers: tenantHeaders(slug, admin.cookie) } };

    const columns = [{ key: "code", label: "Code", type: "string" as const }];
    const rows = [["steel"], ["alu"]];
    const [t] = await db.insert(configMasterdata).values({ tenantId, name: "materials", kind: "table", columns, rows })
      .returning({ id: configMasterdata.id });
    await db.insert(configMasterdata).values({ tenantId, name: "taken", kind: "table", columns, rows });
    const [m] = await db.insert(configModel)
      .values({ tenantId, name: "Cable", definition: usingTable("materials") })
      .returning({ id: configModel.id });

    await call(router.masterdata.save, { id: t!.id, name: "metals", kind: "table", columns, rows }, ctx);
    const [stored] = await db.select({ definition: configModel.definition }).from(configModel).where(eq(configModel.id, m!.id));
    expect(stored!.definition).toEqual(usingTable("metals"));
    // The delete guard reads the model under the new name.
    await expect(call(router.masterdata.remove, { ids: [t!.id] }, ctx)).rejects.toThrow(/used by model Cable/);

    await expect(call(router.masterdata.save, { id: t!.id, name: "taken", kind: "table", columns, rows }, ctx))
      .rejects.toThrow("A table named 'taken' already exists");
  });
});
