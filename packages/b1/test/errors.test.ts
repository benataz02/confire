import { describe, expect, test } from "bun:test";
import { B1Error } from "../src/errors.ts";

describe("B1Error.parse", () => {
  // The message goes straight into a MessageStrip, so it must carry B1's sentence and nothing else.
  test("keeps B1's own message, status and code stay fields", () => {
    const e = B1Error.parse(400, {
      error: { code: -5002, message: { lang: "en-us", value: "To generate this document, first define the numbering series in the Administration module" } },
    });
    expect(e.message).toBe("To generate this document, first define the numbering series in the Administration module");
    expect(e.status).toBe(400);
    expect(e.code).toBe(-5002);
  });

  test("v1 shape (message as a plain string)", () => {
    expect(B1Error.parse(404, { error: { code: "-2028", message: "No matching records found" } }).message)
      .toBe("No matching records found");
  });

  test("a bodyless failure still says something", () => {
    expect(B1Error.parse(500, "").message).toBe("SAP returned 500 with no message.");
  });
});
