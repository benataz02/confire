import { describe, expect, test } from "bun:test";
import { applyModelPatch, diffModel, isEmptyPatch, ModelPatchZ } from "../src/model-patch";
import type { ModelDef } from "../src/model";
import { fieldGroup, model } from "./fixture";

const roundTrip = (a: ModelDef, b: ModelDef) => applyModelPatch(a, ModelPatchZ.parse(diffModel(a, b)));
/** Every object's keys in reverse, as a jsonb read hands them back in an order of its own. */
const reversed = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(reversed)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)]))
  : v;

describe("diffModel", () => {
  test("an unchanged model is an empty patch, even with its keys reordered as jsonb does", () => {
    expect(isEmptyPatch(diffModel(model, structuredClone(model)))).toBe(true);
    expect(isEmptyPatch(diffModel(reversed(model) as ModelDef, model))).toBe(true);
  });

  test("one edited parameter sends that parameter, nothing else", () => {
    const next = structuredClone(model);
    next.parameters[3] = { ...next.parameters[3]!, visibleWhen: "!coated" };
    expect(diffModel(model, next)).toEqual({ parameters: { upsert: [next.parameters[3]!] } });
    expect(roundTrip(model, next)).toEqual(next);
  });

  test("added, removed, renamed and reordered items round-trip", () => {
    const next = structuredClone(model);
    next.parameters = [
      next.parameters[2]!,
      { key: "length", label: "Length", type: "number", ui: "input" },
      next.parameters[0]!,
      { ...next.parameters[1]!, key: "crossSection" },
    ];
    fieldGroup(next, 0, 0).params = ["material", "crossSection"];
    fieldGroup(next, 0, 1).params = ["coated", "length"];
    next.computed = [];
    const p = diffModel(model, next);
    expect(p.parameters?.remove?.sort()).toEqual(["color", "section"]);
    expect(p.computed).toEqual({ remove: ["weight"] });
    expect(roundTrip(model, next)).toEqual(next);
  });

  test("keyless parts go whole, and only when they changed", () => {
    const next = structuredClone(model);
    next.routing = next.routing.slice(0, 1);
    next.description = "Cables";
    expect(diffModel(model, next)).toEqual({ routing: next.routing, description: "Cables" });
    expect(roundTrip(model, next)).toEqual(next);
  });

  test("a removed optional part is null on the wire and absent after", () => {
    const withBoth: ModelDef = { ...structuredClone(model), description: "x", history: { mappings: [], display: [] } };
    const next = structuredClone(withBoth);
    delete next.description;
    delete next.history;
    expect(diffModel(withBoth, next)).toEqual({ description: null, history: null });
    expect(roundTrip(withBoth, next)).toEqual(next);
  });
});

describe("applyModelPatch", () => {
  test("merges onto a model another admin changed meanwhile: different items both stand", () => {
    const mine = structuredClone(model);
    mine.parameters[0] = { ...mine.parameters[0]!, label: "Material" };
    const theirs = structuredClone(model);
    theirs.parameters[2] = { ...theirs.parameters[2]!, label: "Coating" };
    theirs.parameters.push({ key: "length", label: "Length", type: "number", ui: "input" });
    fieldGroup(theirs, 0, 1).params.push("length");
    const out = applyModelPatch(theirs, diffModel(model, mine));
    expect(out.parameters.map((x) => x.label)).toEqual(["Material", "Cross-section", "Coating", "Coating color", "Length"]);
  });

  test("the same item edited by both: the later save wins", () => {
    const mine = structuredClone(model);
    mine.parameters[0] = { ...mine.parameters[0]!, label: "Mine" };
    const theirs = structuredClone(model);
    theirs.parameters[0] = { ...theirs.parameters[0]!, label: "Theirs", help: "?" };
    expect(applyModelPatch(theirs, diffModel(model, mine)).parameters[0]).toEqual(mine.parameters[0]!);
  });

  test("an order naming fewer keys keeps the others after it, in their stored order", () => {
    const mine = structuredClone(model);
    mine.parameters = [mine.parameters[1]!, mine.parameters[0]!, mine.parameters[2]!, mine.parameters[3]!];
    const theirs = structuredClone(model);
    theirs.parameters.push({ key: "length", label: "Length", type: "number", ui: "input" });
    fieldGroup(theirs, 0, 1).params.push("length");
    const out = applyModelPatch(theirs, diffModel(model, mine));
    expect(out.parameters.map((x) => x.key)).toEqual(["section", "material", "coated", "color", "length"]);
  });

  // Parameters merge per key, the structure goes whole: a save diffed against a copy older than
  // another tab's save sends a structure that never heard of the parameter added there.
  test("a parameter added meanwhile stays in its group when a stale save rewrites the structure", () => {
    const theirs = structuredClone(model);
    theirs.parameters.push({ key: "length", label: "Length", type: "number", ui: "input" });
    fieldGroup(theirs, 0, 1).params.push("length");
    const mine = structuredClone(model);
    fieldGroup(mine, 0, 0).title = "Wire";
    const out = applyModelPatch(theirs, diffModel(model, mine));
    expect(out.parameters.map((x) => x.key)).toContain("length");
    expect(out.structure).toEqual({
      sections: [{ ...mine.structure.sections[0]!, groups: [fieldGroup(mine, 0, 0), { ...fieldGroup(mine, 0, 1), params: ["coated", "color", "length"] }] }],
    });
  });

  test("a stale save deleting the group a parameter was added to deletes the parameter and its formulas", () => {
    const theirs = structuredClone(model);
    theirs.parameters.push({ key: "length", label: "Length", type: "number", ui: "input" });
    theirs.computed.push({ key: "twice", expr: "length * 2", param: "length" });
    fieldGroup(theirs, 0, 1).params.push("length");
    const mine = structuredClone(model);
    mine.structure.sections[0]!.groups.pop();
    mine.parameters = mine.parameters.filter((p) => p.key !== "coated" && p.key !== "color");
    const out = applyModelPatch(theirs, diffModel(model, mine));
    expect(out.parameters.map((x) => x.key)).toEqual(["material", "section"]);
    expect(out.computed.map((c) => c.key)).toEqual(["weight"]);
    expect(out.structure).toEqual(mine.structure);
  });

  test("a parameter stored in no group goes on the next save", () => {
    const stored = structuredClone(model);
    stored.parameters.push({ key: "lost", label: "Lost", type: "string", ui: "input" });
    const mine = structuredClone(stored);
    mine.description = "x";
    expect(applyModelPatch(stored, diffModel(stored, mine)).parameters.map((x) => x.key)).not.toContain("lost");
  });
});
