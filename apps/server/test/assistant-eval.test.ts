import { expect, test } from "bun:test";
import type { Extraction, FileSource } from "../src/assistant/extract.ts";
import { scoreCase } from "../../../scripts/assistant-eval.ts";

// The eval's scorer (pure): stored entries are the final values, so a reading unlike one is listed
// for a person to judge — misread or revised — rather than counted wrong.

const SRC: FileSource = { file: "RFQ.pdf", page: 1, quote: "q" };
const x = (p: Partial<Extraction>): Extraction => ({ set: [], batches: null, tables: [], unsure: [], notes: [], ...p });

test("filled, asked and differs against the stored entries", () => {
  const r = scoreCase({ a: 1, b: "x", c: 3 }, x({
    set: [{ key: "a", value: 1, source: SRC }, { key: "b", value: "y", source: SRC }],
    unsure: [{ key: "c", why: "smudged", candidates: [] }],
  }), ["a", "b", "c"]);
  expect(r).toEqual({ filled: 1, asked: 1, total: 3, differs: [{ key: "b", read: "y", stored: "x", source: SRC }] });
});

test("a key with nothing stored is not scored; a read-only key never counts", () => {
  const r = scoreCase({ a: 1, fixed: 2 }, x({ set: [{ key: "z", value: 5, source: SRC }, { key: "fixed", value: 9, source: SRC }] }), ["a", "z"]);
  expect(r).toEqual({ filled: 0, asked: 0, total: 1, differs: [] });
});
