import { expect, test } from "bun:test";
import type { ConfigCandidate } from "@confire/db";
import { uncataloguedOperations } from "../src/config-view.ts";

const withOps = (ops: Record<string, unknown>[]) => [{ perBatch: [{ outputs: { ops } }] }] as unknown as ConfigCandidate[];

test("every uncatalogued line is named once — one whose code came out empty too, never a silent 0", () => {
  expect(uncataloguedOperations([
    ...withOps([{ operationId: "X", uncatalogued: true }, { operationId: "OK" }, { operationId: "", uncatalogued: true }]),
    ...withOps([{ operationId: "X", uncatalogued: true }]),
  ])).toEqual(["X", '""']);
});
