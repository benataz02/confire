import { expect, test } from "bun:test";
import type { ConfigCandidate } from "@confire/db";
import { priceListNotices, uncataloguedOperations } from "../src/config-view.ts";

const withOps = (ops: Record<string, unknown>[]) => [{ perBatch: [{ outputs: { ops } }] }] as unknown as ConfigCandidate[];

test("every uncatalogued line is named once — one whose code came out empty too, never a silent 0", () => {
  expect(uncataloguedOperations([
    ...withOps([{ operationId: "X", uncatalogued: true }, { operationId: "OK" }, { operationId: "", uncatalogued: true }]),
    ...withOps([{ operationId: "X", uncatalogued: true }]),
  ])).toEqual(["X", '""']);
});

test("a price list that failed to load says so; one never loaded says that", () => {
  expect(priceListNotices(1, { error: "SQL refused", fetchedAt: null, changedAt: null, rows: 0 }).map((n) => [n.code, n.params]))
    .toEqual([["sync_failed", ["Price list 1", "SQL refused", "0"]]]);
  expect(priceListNotices(1, null).map((n) => [n.code, n.params])).toEqual([["sync_never", ["Price list 1"]]]);
  expect(priceListNotices(1, { error: null, fetchedAt: new Date(), changedAt: new Date(), rows: 3 })).toEqual([]);
  expect(priceListNotices(undefined, null)).toEqual([]);
});
