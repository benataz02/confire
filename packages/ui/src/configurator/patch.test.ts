import { expect, test } from "bun:test";
import { mergePatch, overlay, overlayForm } from "./patch.ts";

test("set then unset clears; unset then set sets", () => {
  expect(mergePatch({ set: { a: 1, b: 2 } }, { unset: ["a"] })).toEqual({ set: { b: 2 }, unset: ["a"] });
  expect(mergePatch({ unset: ["a"] }, { set: { a: 3 } })).toEqual({ set: { a: 3 } });
});

test("within one patch a key both set and cleared ends up cleared, as the server merges it", () => {
  expect(mergePatch({}, { set: { a: 1 }, unset: ["a"] })).toEqual({ unset: ["a"] });
});

test("tables replace per table; the later of anything wins", () => {
  expect(mergePatch(
    { tables: { t: [{ x: 1 }], u: [{ y: 1 }] }, batches: [1], name: "A" },
    { tables: { t: [{ x: 2 }] }, batches: [2, 3], name: "B", customer: null },
  )).toEqual({ tables: { t: [{ x: 2 }], u: [{ y: 1 }] }, batches: [2, 3], name: "B", customer: null });
});

test("order: the same edits merged pairwise, in order, are the same patch", () => {
  const edits = [{ set: { a: 1 } }, { unset: ["a"] }, { set: { b: 2 } }, { set: { a: 4 } }];
  expect(edits.reduce(mergePatch, {})).toEqual({ set: { b: 2, a: 4 } });
});

test("the overlay echoes what was typed over the last answer, and nothing more", () => {
  const project = { name: "N", customer: null, entries: { a: 1, b: 2 }, batches: [10], tables: { t: [] }, status: "draft" };
  expect(overlay(project, { set: { c: 3 }, unset: ["a"], tables: { u: [{}] } })).toEqual({
    ...project, entries: { b: 2, c: 3 }, tables: { t: [], u: [{}] },
  });
  expect(overlay(project, null)).toBe(project);

  const form = { fields: { a: { value: 5, defaulted: true as const, visible: true, required: false } }, conflicts: [], open: 0, tables: {} };
  expect(overlayForm(form, { set: { a: 7 } }).fields.a).toEqual({ value: 7, visible: true, required: false });
  expect(overlayForm(form, { unset: ["a"] }).fields.a).toEqual({ visible: true, required: false });
});
