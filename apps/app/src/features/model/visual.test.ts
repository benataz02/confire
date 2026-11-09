import { expect, test } from "bun:test";
import { commitVisual, fromVisualRecord, toVisualRecord, visualIssues } from "./visual.ts";
import { SHEET_INPUTS, withSheet } from "./visualTestModel.ts";

const t = (key: string, ...params: string[]) => [key, ...params].join(" ");
const hoja = withSheet().visuals![0]!;

test("a visual round-trips through its record of flat keys", () => {
  const r = toVisualRecord(hoja);
  expect(r["inputs.gapX"]).toBe("3");
  expect(fromVisualRecord(r)).toEqual(hoja);
});

test("visualIssues puts an input's problem on its field and a kind's on `kind`", () => {
  const { gapX: _g, ...rest } = SHEET_INPUTS;
  const missing = visualIssues(toVisualRecord({ ...hoja, inputs: rest }), withSheet(), [], "hoja", t);
  expect(Object.keys(missing.fields ?? {})).toContain("inputs.gapX");
  const unknown = visualIssues(toVisualRecord({ ...hoja, kind: "nope" }), withSheet(), [], "hoja", t);
  expect(Object.keys(unknown.fields ?? {})).toContain("kind");
});

test("commitVisual writes the visual back, a rename following into its group", () => {
  const d = commitVisual(withSheet(), "hoja", { ...hoja, key: "sheet" });
  expect(d.visuals!.map((v) => v.key)).toEqual(["sheet"]);
  expect(d.structure.sections[0]!.groups[0]!.params).toEqual(["width", "sheet"]);
});
