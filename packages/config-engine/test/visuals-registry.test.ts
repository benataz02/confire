import { expect, test } from "bun:test";
import { computeVisual, VISUALS, visualsFor } from "../src/visuals/index.ts";

const ok = { sheetLength: 1000, sheetWidth: 500, pieceLength: 120, pieceWidth: 70, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };

test("visualsFor scopes kinds to their tenants", () => {
  expect(visualsFor("hera").map((v) => v.kind)).toEqual(["hera.sheetLayout"]);
  expect(visualsFor("acme")).toEqual([]);
});

test("computeVisual: undefined for a missing, null or mistyped input", () => {
  const calc = VISUALS["hera.sheetLayout"]!;
  expect(computeVisual(calc, ok)?.outputs.piezas).toBe(48);
  expect(computeVisual(calc, { ...ok, gapX: undefined })).toBeUndefined();
  expect(computeVisual(calc, { ...ok, gapX: null })).toBeUndefined();
  expect(computeVisual(calc, { ...ok, gapX: "3" })).toBeUndefined();
});

test("computeVisual memoizes by inputs and swallows a throw", () => {
  const calc = VISUALS["hera.sheetLayout"]!;
  expect(computeVisual(calc, ok)).toBe(computeVisual(calc, { ...ok }));
  const boom = { ...calc, kind: "test.boom", compute: () => { throw new Error("x"); } };
  expect(computeVisual(boom, ok)).toBeUndefined();
});
