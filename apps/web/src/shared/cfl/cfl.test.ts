import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { cfl, keyFieldOf, keysToTokens, tokensToKeys } from "./cfl-configs.ts";
import { exists, findRow, probeRequest } from "./existence.ts";
import { entityPath, showLink } from "../navigation.ts";
import type { CflFieldConfig } from "../types.ts";

test("the key is keyField, else the first column", () => {
  expect(keyFieldOf({ columns: [{ key: "Code" }, { key: "Name" }] })).toBe("Code");
  expect(keyFieldOf({ keyField: "PriceListNo", columns: [{ key: "Bitmap" }] })).toBe("PriceListNo");
  expect(keyFieldOf(cfl.priceLists())).toBe("PriceListNo");
});

test("N(): tokens become key values, blanks dropped; and back", () => {
  const d = cfl.customers();
  expect(tokensToKeys([{ CardCode: " C1 " }, { CardCode: "" }, { CardCode: "C2", CardName: "x" }], d)).toEqual(["C1", "C2"]);
  expect(keysToTokens(["C1", "C2"], d)).toEqual([{ CardCode: "C1" }, { CardCode: "C2" }]);
  expect(keysToTokens(undefined, d)).toEqual([]);
});

test("the probe is fixedFilters plus keyField eq value", () => {
  const cfg: CflFieldConfig = { dialogConfig: cfl.customers() };
  expect(probeRequest(cfg, " C1 ")).toEqual({
    filter: [
      { field: "CardType", op: "eq", value: "cCustomer" },
      { field: "CardCode", op: "eq", value: "C1" },
    ],
  });
  // a numeric key stays a number
  expect(probeRequest({ dialogConfig: cfl.priceLists() }, 3).filter?.at(-1)).toEqual({ field: "PriceListNo", op: "eq", value: 3 });
});

/** A client whose every fetch answers `answer`. */
const client = (answer: () => Promise<unknown>) => {
  const qc = new QueryClient();
  qc.fetchQuery = (() => answer()) as typeof qc.fetchQuery;
  return qc;
};
const cfg: CflFieldConfig = { dialogConfig: cfl.items() };

test("a failed probe counts as exists; an empty answer is missing", async () => {
  const silence = console.warn;
  console.warn = () => {};
  try {
    expect(await exists(client(() => Promise.reject(new Error("agent down"))), cfg, "A1")).toBe(true);
    expect(await findRow(client(() => Promise.reject(new Error("agent down"))), cfg, "A1")).toBeUndefined();
  } finally {
    console.warn = silence;
  }
  expect(await exists(client(async () => ({ rows: [] })), cfg, "A1")).toBe(false);
  expect(await findRow(client(async () => ({ rows: [{ ItemCode: "a1" }, { ItemCode: "A1", ItemName: "x" }] })), cfg, "A1"))
    .toEqual({ ItemCode: "A1", ItemName: "x" });
});

test("the link shows only with somewhere to go, a value, and not for a key known missing", () => {
  const base = { link: true as const, dialogRoute: "/b1/Items", value: "A1" };
  expect(showLink(base)).toEqual({ route: "/b1/Items", action: undefined, target: "A1" });
  expect(showLink({ ...base, dialogRoute: undefined })).toBeNull(); // link: true needs a route
  expect(showLink({ ...base, value: "  " })).toBeNull();
  expect(showLink({ ...base, missingValue: "A1" })).toBeNull();
  expect(showLink({ ...base, canOpen: () => false })).toBeNull(); // /b1 is admin-only
  expect(showLink({ link: { route: "/r", idField: "Id" }, value: "x", row: { Id: " 7 " } })?.target).toBe("7");
  expect(showLink({ link: undefined, value: "A1" })).toBeNull();
});

test("entityPath: <route>/<key>, trimmed; a composite key as JSON", () => {
  expect(entityPath("/b1/Items", " A1 ")).toBe("/b1/Items/A1");
  expect(entityPath("/b1/Orders/", 12)).toBe("/b1/Orders/12");
  expect(decodeURIComponent(entityPath("/b1/X", { Code: "A", Line: 1 }))).toBe('/b1/X/{"Code":"A","Line":1}');
});
