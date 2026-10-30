import { expect, test } from "bun:test";
import { checkFields, initialRecord, recordReducer, type RecordState } from "./recordState.ts";
import type { FormField } from "../types.ts";

const edit = (s: RecordState, key: string, v: unknown) => recordReducer(s, { type: "edit", fn: (r) => ({ ...r, [key]: v }) });

test("an always-editing record takes what it saved as its new baseline and goes on editing", () => {
  let s = initialRecord({ name: "A" }, true);
  s = edit(s, "name", "B");
  s = recordReducer(s, { type: "saved", record: s.formData, keepEditing: true });
  expect(s.baseline).toEqual({ name: "B" });
  expect(s.formData).toBe(s.baseline!);
  // A record that edits on demand goes back to display.
  expect(recordReducer(s, { type: "saved", record: s.formData, keepEditing: false }).baseline).toBeNull();
});

test("validate replaces the declared rules", () => {
  const fields: FormField[] = [{ key: "name", required: true, metaEditable: true }];
  const opts = { baseline: null, isNew: true };
  expect(checkFields(undefined, fields, {}, opts).fields).toEqual({ name: "Enter a value." });
  // The declared `required` only draws the asterisk now: the record's own rule is the one answer.
  expect(checkFields(() => ({ fields: { other: "own rule" } }), fields, {}, opts)).toEqual({ fields: { other: "own rule" } });
});

test("the refused count goes up on a refused Save, never on an edit", () => {
  let s = initialRecord({ name: "" }, true);
  s = edit(s, "name", "x");
  expect(s.refused).toBe(0);
  s = recordReducer(s, { type: "saving" });
  s = recordReducer(s, { type: "refused", saveError: "nope" });
  expect(s.refused).toBe(1);
  expect(s.tried).toBe(true);
  s = edit(s, "name", "y");
  expect(s.refused).toBe(1);
  // A reload keeps the count: a page reloaded after a refusal must not re-open the popover.
  expect(recordReducer(s, { type: "load", data: {}, edit: true }).refused).toBe(1);
});
