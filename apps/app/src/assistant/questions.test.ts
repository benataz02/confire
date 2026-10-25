import { expect, test } from "bun:test";
import { openQuestions, type QuestionView } from "./questions.ts";
import type { ExtractResult } from "./cards/ExtractionCard.tsx";

// The open questions of a configuration, from its live view and every read in its chat (pure): what
// is still missing plus what a read could not settle, in the model's order. A question answered on
// the page drops out, because it reads the same view the page draws.

const params = [
  { key: "size", label: "Size", type: "string", ui: "select", domain: { kind: "options", ref: { source: "manual", options: [] } } },
  { key: "grade", label: "Grade", type: "string", ui: "select", domain: { kind: "options", ref: { source: "query", table: "grades" } } },
  { key: "width", label: "Width", type: "number", ui: "input" },
  { key: "note", label: "Note", type: "string", ui: "input" },
];
const view = (entries: Record<string, unknown> = {}, missing: { key?: string; code: string }[] = []): QuestionView => ({
  missing: missing as QuestionView["missing"],
  project: { entries, batches: [10], tables: {}, customer: { cardCode: "C1", cardName: "Acme" } } as unknown as QuestionView["project"],
  form: {
    fields: {
      size: { visible: true, required: true, options: [{ value: "S", label: "Small", unavailable: "No S in steel" }, { value: "L", label: "Large" }] },
      grade: { visible: true, required: false, options: [] },
      width: { visible: true, required: false },
      note: { visible: true, required: false },
    },
    conflicts: [], open: 0, tables: {},
  } as unknown as QuestionView["form"],
  model: { definition: { parameters: params } as never },
});
const x = (questions: ExtractResult["questions"]): ExtractResult => ({ applied: [], questions, notes: [] });

test("missing parameters and extraction questions merge, in model order, answered ones drop", () => {
  const qs = openQuestions(view({}, [{ key: "size", code: "param_required" }]), [
    x([{ key: "note", why: "unsure", detail: "smudged", candidates: [] }, { key: "width", why: "out_of_range", detail: "10–500", read: 900, candidates: [] }]),
  ]);
  expect(qs.map((q) => [q.key, q.why])).toEqual([["size", "missing"], ["width", "out_of_range"], ["note", "unsure"]]);
  expect(qs.find((q) => q.key === "grade")).toBeUndefined();
  // the page filled width meanwhile: no longer asked
  expect(openQuestions(view({ width: 200 }), [x([{ key: "width", why: "out_of_range", detail: "", read: 900, candidates: [] }])])).toEqual([]);
});

test("a differs question stays while the field holds what it held, and closes on either answer", () => {
  const read = [x([{ key: "size", why: "differs", detail: "", read: "S", candidates: ["L", "S"] }])];
  const open = openQuestions(view({ size: "L" }), read);
  expect(open).toEqual([expect.objectContaining({ key: "size", why: "differs", read: "S", current: "L" })]);
  expect(openQuestions(view({ size: "S" }), read)).toEqual([]); // used the read value
  expect(openQuestions(view({ size: "L" }), read, new Set(["size"]))).toEqual([]); // kept, this session
  expect(openQuestions(view({ size: "M" }), read)).toEqual([]); // decided otherwise on the page
});

test("a field a rule's default filled is answered", () => {
  const v = view();
  (v.form.fields.note as { value?: unknown }).value = "from the default";
  expect(openQuestions(v, [x([{ key: "note", why: "unsure", detail: "", candidates: [] }])])).toEqual([]);
});

test("unavailable options are kept (disabled) so the rule can be shown", () => {
  const [q] = openQuestions(view({}, [{ key: "size", code: "param_required" }]), []);
  expect(q!.kind).toBe("options");
  expect(q!.options).toEqual([{ value: "S", label: "Small", unavailable: "No S in steel" }, { value: "L", label: "Large" }]);
});

test("query-backed and free fields say how they are answered; a missing customer comes first", () => {
  const v = view({}, [{ key: "grade", code: "param_required" }, { key: "width", code: "param_required" }, { key: "__customer", code: "customer_required" }]);
  expect(openQuestions(v, []).map((q) => [q.key, q.kind])).toEqual([["__customer", "customer"], ["grade", "query"], ["width", "free"]]);
});
