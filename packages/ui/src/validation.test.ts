import { expect, test } from "bun:test";
import { getFieldValidationError, matchErrorFields, validateForm } from "./validation.ts";
import type { FormField } from "./types.ts";

const editable = (f: FormField): FormField => ({ metaEditable: true, ...f });

test("required: empty is an error, 0 and false are values", () => {
  const f = editable({ key: "Qty", required: true });
  expect(getFieldValidationError(f, "", {})).toBe("Enter a value.");
  expect(getFieldValidationError(f, null, {})).toBe("Enter a value.");
  expect(getFieldValidationError(f, 0, {})).toBeNull();
  expect(getFieldValidationError(f, false, {})).toBeNull();
});

test("maxLength, min/max and a dynamic required rule", () => {
  expect(getFieldValidationError({ key: "A", validators: { maxLength: 3 } }, "abcd", {})).toBe("At most 3 characters.");
  expect(getFieldValidationError({ key: "A", validators: { min: 1 } }, 0, {})).toBe("Must be at least 1.");
  const dyn: FormField = { key: "B", required: (d) => d.kind === "x" };
  expect(getFieldValidationError(dyn, "", { kind: "x" })).toBe("Enter a value.");
  expect(getFieldValidationError(dyn, "", { kind: "y" })).toBeNull();
});

test("an unchanged field on an existing record is skipped — legacy data does not block a save", () => {
  const fields = [editable({ key: "Name", validators: { maxLength: 3 } }), editable({ key: "Note", validators: { maxLength: 3 } })];
  const baseline = { Name: "too long already", Note: "ok" };
  expect(validateForm(fields, { ...baseline, Note: "longer" }, { baseline, isNew: false }))
    .toEqual({ Note: "At most 3 characters." });
  // …unless its required rule is dynamic
  const dyn = editable({ key: "Name", required: () => true });
  expect(validateForm([dyn], { Name: "" }, { baseline: { Name: "" }, isNew: false })).toEqual({ Name: "Enter a value." });
});

test("a read-only field is never validated", () => {
  expect(validateForm([{ key: "X", required: true }], {}, { baseline: null, isNew: true })).toEqual({});
});

test("a B1 save error names the field it is about, as a column or a property", () => {
  const keys = ["CardCode", "DocDueDate", "U_Note"];
  expect(matchErrorFields("Enter valid date [OQUT.DocDueDate][line: 0]", keys)).toEqual(["DocDueDate"]);
  expect(matchErrorFields("Property 'u_note' of 'Document' is invalid", keys)).toEqual(["U_Note"]);
  expect(matchErrorFields("Precondition failed", keys)).toEqual([]);
});
