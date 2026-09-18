import { expect, test } from "bun:test";
import { db, entityMeta, type B1EntitySchema } from "@confire/db";
import type { B1Transport } from "@confire/b1";
import { entitySchema } from "../src/entity-meta.ts";
import { makeTenant } from "./harness.ts";

/** Any call on this transport is a trip to the customer's agent — the whole point of the stored
 *  schema is that a cache hit makes none. */
const noAgent = new Proxy({}, {
  get: (_t, prop) => () => { throw new Error(`agent called: ${String(prop)}`); },
}) as B1Transport;

test("a stored schema is served from Postgres, without touching the agent", async () => {
  const { tenantId } = await makeTenant();
  const json = { name: "Items", label: "Items", table: "OITM", keys: ["ItemCode"], fields: [] } as unknown as B1EntitySchema;
  await db.insert(entityMeta).values({ tenantId, entityName: "Items", json, fetchedAt: new Date() });

  expect(await entitySchema(tenantId, noAgent, "Items")).toEqual(json);
  // refresh: true is the Refresh button, and it must go back to B1 rather than re-read the row.
  expect(entitySchema(tenantId, noAgent, "Items", true)).rejects.toThrow(/agent called/);
});

test("DocCurrency gets a value help B1's own metadata does not declare", async () => {
  const { tenantId } = await makeTenant();
  const json = {
    name: "Quotations", label: "Sales Quotation", table: "OQUT", keys: ["DocEntry"],
    fields: [
      { name: "DocCurrency", label: "Currency", kind: "string", edmType: "Edm.String" },
      // B1 declared this one itself; the overlay must not overwrite it.
      { name: "CardCode", label: "Customer", kind: "string", edmType: "Edm.String",
        lookup: { entitySet: "BusinessPartners", keyField: "CardCode" } },
      { name: "Comments", label: "Remarks", kind: "string", edmType: "Edm.String" },
    ],
  } as unknown as B1EntitySchema;
  // Written without the lookup, exactly as an already-cached row looks — the overlay is applied on
  // read, so no refresh is needed to pick it up.
  await db.insert(entityMeta).values({ tenantId, entityName: "Quotations", json, fetchedAt: new Date() });

  const out = await entitySchema(tenantId, noAgent, "Quotations");
  const by = (n: string) => out.fields.find((f) => f.name === n);
  expect(by("DocCurrency")?.lookup).toEqual({ entitySet: "Currencies", keyField: "Code" });
  expect(by("CardCode")?.lookup).toEqual({ entitySet: "BusinessPartners", keyField: "CardCode" });
  expect(by("Comments")?.lookup).toBeUndefined();
});
