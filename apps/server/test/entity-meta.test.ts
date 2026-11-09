import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, sapCache, type B1EntitySchema } from "@confire/db";
import type { B1Transport } from "@confire/b1";
import { entityList, entitySchema, toConstraints } from "../src/entity-meta.ts";
import { put } from "../src/sap-cache.ts";
import { ENTITY_PROFILES } from "../src/entity-profiles.ts";
import { makeTenant } from "./harness.ts";

/** Any call on this transport is a trip to the customer's agent — the whole point of the stored
 *  schema is that a cache hit makes none. */
const noAgent = new Proxy({}, {
  get: (_t, prop) => () => { throw new Error(`agent called: ${String(prop)}`); },
}) as B1Transport;

describe.skipIf(!process.env.DATABASE_URL)("entitySchema", () => {
  test("a stored schema is served from Postgres, without touching the agent", async () => {
    const { tenantId } = await makeTenant();
    const json = { name: "Items", label: "Items", table: "OITM", keys: ["ItemCode"], fields: [] } as unknown as B1EntitySchema;
    await put(tenantId, "schema", [{ key: "Items", data: json }], { company: null });

    expect(await entitySchema(tenantId, noAgent, "Items")).toEqual(json);
    // refresh: true is the Refresh button, and it must go back to B1 rather than re-read the row.
    expect(entitySchema(tenantId, noAgent, "Items", true)).rejects.toThrow(/agent called/);
  });

  test("the entity list is kept in Postgres", async () => {
    const { tenantId } = await makeTenant();
    let reads = 0;
    const xml = `<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx" Version="4.0"><edmx:DataServices>
      <Schema xmlns="http://docs.oasis-open.org/odata/ns/edm" Namespace="SAPB1"><EntityContainer Name="ServiceLayer">
      <EntitySet Name="Items" EntityType="SAPB1.Item"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
    const b1 = { metadata: async () => { reads++; return xml; } } as unknown as B1Transport;
    expect((await entityList(tenantId, b1)).map((e) => e.name)).toEqual(["Items"]);
    expect((await entityList(tenantId, b1)).map((e) => e.name)).toEqual(["Items"]);
    expect(reads).toBe(1);
    const stored = await db.select().from(sapCache).where(and(eq(sapCache.tenantId, tenantId), eq(sapCache.kind, "entity_list")));
    expect(stored).toHaveLength(1);
  });
});

// toConstraints is pure: the write rule restated as per-field data. These pin the three things the
// object page reads from it — Required, Editable, and a document line's own fields.
const doc = (name: string): B1EntitySchema => ({
  name, entityType: "Document", table: "OQUT", label: name, entityClass: "standard", keys: ["DocEntry"],
  fields: [
    { name: "DocEntry", kind: "number", edmType: "Edm.Int32" },
    { name: "CardCode", kind: "string", edmType: "Edm.String", label: "Customer", maxLength: 15 },
    { name: "DocTotal", kind: "number", edmType: "Edm.Double" },
    { name: "U_Note", kind: "string", edmType: "Edm.String", isUDF: true },
    {
      name: "DocumentStatus", kind: "enum", edmType: "SAPB1.BoStatus",
      options: [{ value: "O", label: "bost_Open" }, { value: "C", label: "bost_Close" }],
    },
    {
      name: "DocumentLines", kind: "collection", edmType: "SAPB1.DocumentLine",
      fields: [
        { name: "ItemCode", kind: "string", edmType: "Edm.String", maxLength: 50 },
        { name: "Quantity", kind: "number", edmType: "Edm.Double" },
      ],
    },
  ],
});

describe("toConstraints", () => {
  test("Required is requiredOnCreate; Editable is the write allowlist, U_ fields included", () => {
    const c = toConstraints(doc("Quotations"), ENTITY_PROFILES.Quotations);
    expect(c.writable).toBe(true);
    expect(c.fields.CardCode).toMatchObject({ Type: "string", Label: "Customer", MaxLength: 15, Required: true, Editable: true });
    expect(c.fields.DocTotal?.Editable).toBeUndefined(); // a calculated total is never ours to write
    expect(c.fields.U_Note).toMatchObject({ Udf: true, Editable: true });
    expect(c.fields.DocumentLines?.Required).toBe(true);
  });

  test("an editable collection's line fields are editable too — the lines grid's ItemCode editor", () => {
    const lines = toConstraints(doc("Quotations"), ENTITY_PROFILES.Quotations).fields.DocumentLines!;
    expect(lines.Editable).toBe(true);
    expect(lines.Fields?.ItemCode).toMatchObject({ Type: "string", MaxLength: 50, Editable: true });
  });

  test("no profile is read-only all the way down", () => {
    const c = toConstraints(doc("Invoices"), undefined);
    expect(c.writable).toBe(false);
    const editable = Object.values(c.fields).filter((f) => f.Editable);
    expect(editable).toEqual([]);
    expect(c.fields.U_Note?.Editable).toBeUndefined();
    expect(c.fields.DocumentLines?.Fields?.ItemCode?.Editable).toBeUndefined();
  });

  test("an enum option sends B1's member name and shows it without its prefix", () => {
    const c = toConstraints(doc("Quotations"), ENTITY_PROFILES.Quotations);
    expect(c.fields.DocumentStatus?.Options).toEqual([
      { value: "bost_Open", label: "Open" },
      { value: "bost_Close", label: "Close" },
    ]);
  });
});
