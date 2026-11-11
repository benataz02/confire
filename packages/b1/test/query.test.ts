import { expect, test } from "bun:test";
import { sqlQueryPath } from "../src/query.ts";

test("a stored query's params are OData literals, percent-encoded", () => {
  expect(sqlQueryPath("CF_X")).toBe("SQLQueries('CF_X')/List");
  expect(sqlQueryPath("CF_X", { CardCode: "O'Neil & Co", n: 5 }))
    .toBe("SQLQueries('CF_X')/List?CardCode='O''Neil%20%26%20Co'&n=5");
  expect(() => sqlQueryPath("CF_X", { "a=b": 1 })).toThrow();
});
