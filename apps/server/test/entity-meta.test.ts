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
