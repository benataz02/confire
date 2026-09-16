import { describe, expect, test } from "bun:test";
import { ModelDefZ, LookupRefZ, derivedColumns, displayColumns, derivedKey } from "../src/model";
import { model } from "./fixture";

describe("ModelDefZ", () => {
  test("accepts the fixture model", () => {
    expect(() => ModelDefZ.parse(model)).not.toThrow();
  });

  test("rejects a parameter with a bad key", () => {
    const bad = structuredClone(model);
    bad.parameters[0]!.key = "1bad key";
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });

  test("keeps excludeFromDomains and mandatory on a parameter", () => {
    const m = structuredClone(model) as any;
    m.parameters[0].excludeFromDomains = true;
    m.parameters[0].mandatory = true;
    const parsed = ModelDefZ.parse(m);
    expect(parsed.parameters[0]!.excludeFromDomains).toBe(true);
    expect(parsed.parameters[0]!.mandatory).toBe(true);
  });

  test("rejects unknown constraint kind", () => {
    const bad = structuredClone(model) as any;
    bad.constraints.push({ kind: "magic" });
    expect(() => ModelDefZ.parse(bad)).toThrow();
  });
});

describe("LookupRef columns", () => {
  test("accepts named-source query refs and rejects the old inline shape", () => {
    expect(LookupRefZ.safeParse({ source: "query", table: "items", valueCol: "ItemCode" }).success).toBe(true);
    expect(LookupRefZ.safeParse({ source: "query", target: "b1", query: { entitySet: "Items" }, valueField: "ItemCode" }).success).toBe(false);
    expect(LookupRefZ.safeParse({ source: "table", table: "mats", valueCol: "code", columns: ["density"] }).success).toBe(true);
  });

  test("derivedColumns is every extra column; displayColumns honours the subset", () => {
    const ref = { source: "table", table: "mats", valueCol: "code" } as const;
    const all = ["code", "density", "name"];
    expect(derivedColumns(ref, all)).toEqual(["density", "name"]);
    expect(derivedColumns({ ...ref, columns: ["density"] }, all)).toEqual(["density", "name"]);
    expect(derivedColumns({ ...ref, columns: ["density"] }, undefined)).toEqual([]);
    expect(derivedColumns(ref, undefined)).toEqual([]);
    expect(derivedColumns({ source: "manual", options: [] }, ["x"])).toEqual([]);
    expect(displayColumns(ref, all)).toEqual(["density", "name"]);
    expect(displayColumns({ ...ref, columns: ["density"] }, all)).toEqual(["density"]);
    expect(displayColumns({ ...ref, columns: ["density"] }, undefined)).toEqual(["density"]);
    expect(displayColumns(ref, undefined)).toEqual([]);
    expect(displayColumns({ source: "manual", options: [] }, ["x"])).toEqual([]);
  });

  test("derivedKey joins with underscore", () => {
    expect(derivedKey("material", "density")).toBe("material_density");
  });

  test("a query ref derives and displays every column but the key", () => {
    const cols = ["ItemCode", "ItemName", "OnHand"];
    const ref = { source: "query" as const, table: "items" };
    expect(derivedColumns(ref, cols)).toEqual(["ItemName", "OnHand"]);
    expect(displayColumns(ref, cols)).toEqual(["ItemName", "OnHand"]);
  });

  test("a model definition no longer carries query definitions", () => {
    const m = structuredClone(model) as Record<string, unknown>;
    m.queryTables = [{ name: "items", target: "b1", query: { entitySet: "Items" }, columns: ["ItemCode"] }];
    expect("queryTables" in ModelDefZ.parse(m)).toBe(false);
  });

  test("history names a masterdata query rather than carrying one", () => {
    const m = structuredClone(model) as Record<string, unknown>;
    m.history = {
      query: { target: "b1", query: { entitySet: "X" }, columns: ["mat"] },
      table: "past",
      mappings: [],
      display: [],
    };
    expect(ModelDefZ.parse(m).history).toEqual({ table: "past", mappings: [], display: [] });
  });
});
