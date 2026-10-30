import { expect, test } from "bun:test";
import { paramSearch, sameJson, sameModelPath } from "./paramRoute.ts";

test("staying under one model is not leaving it", () => {
  expect(sameModelPath("/acme/models/abc", "/acme/models/abc/parameter")).toBe(true);
  expect(sameModelPath("/acme/models/new", "/acme/models/new/parameter")).toBe(true);
  expect(sameModelPath("/acme/models/abc/parameter", "/acme/models/abc")).toBe(true);
  expect(sameModelPath("/acme/models/abc", "/acme/models/abc/table")).toBe(true);
});

test("the list, another model, and a lookalike id are leaving", () => {
  expect(sameModelPath("/acme/models/abc", "/acme/models")).toBe(false);
  expect(sameModelPath("/acme/models/abc", "/acme/models/def")).toBe(false);
  expect(sameModelPath("/acme/models/new", "/acme/models/newish")).toBe(false);
  expect(sameModelPath("/acme/models", "/acme/configs")).toBe(false);
});

test("parameter search keeps a real key and integer placement", () => {
  expect(paramSearch({ key: "width" })).toEqual({ key: "width" });
  expect(paramSearch({ key: "new" })).toEqual({ key: "new" });
  expect(paramSearch({ s: "0", g: "2" })).toEqual({ s: 0, g: 2 });
  expect(paramSearch({ s: 1, g: "x", key: "" })).toEqual({ s: 1 });
  expect(paramSearch({ s: -1, g: 1.5 })).toEqual({});
});

test("a spread that reorders keys is still the same parameter", () => {
  expect(sameJson({ key: "a", label: "A" }, { label: "A", key: "a" })).toBe(true);
  expect(sameJson({ key: "a", unit: undefined }, { key: "a" })).toBe(true);
  expect(sameJson({ key: "a" }, { key: "b" })).toBe(false);
});
