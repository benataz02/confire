import { expect, test } from "bun:test";
import { formatValue } from "./format.ts";
import { isFieldEditable, resolveColumns, resolveField, resolveSections, udfColumns, udfSection, type Constraints } from "./metadata.ts";
import type { FormField } from "./types.ts";

const C: Constraints = {
  CardCode: { Type: "string", EdmType: "Edm.String", Label: "Customer", MaxLength: 15, Required: true, Editable: true },
  DocTotal: { Type: "number", EdmType: "Edm.Double", Label: "Total" },
  Printed: { Type: "boolean", EdmType: "SAPB1.BoYesNoEnum" },
  U_Note: { Type: "string", EdmType: "Edm.String", Label: "Note", Udf: true, Editable: true },
  U_Prio: { Type: "enum", EdmType: "SAPB1.Prio", Udf: true, Options: [{ value: "H", label: "High" }] },
};

test("resolveField matches case-insensitively and rewrites the key to metadata's casing", () => {
  const f = resolveField({ key: "cardcode" }, C);
  expect(f.key).toBe("CardCode");
  expect(f.label).toBe("Customer");
  expect(f.type).toBe("string");
  expect(f.validators?.maxLength).toBe(15);
  expect(f.required).toBe(true);
});

test("a declared label/type wins; metadata only fills what the field left out", () => {
  const f = resolveField({ key: "CardCode", label: "BP", validators: { maxLength: 5 } }, C);
  expect(f.label).toBe("BP");
  // Feature validators are kept, metadata's merge underneath.
  expect(f.validators?.maxLength).toBe(5);
});

test("a declared required function wins over metadata's Required", () => {
  const rule = (d: Record<string, unknown>) => d.DocTotal === 0;
  const f = resolveField({ key: "CardCode", required: rule }, C);
  expect(f.required).toBe(rule);
});

test("an unknown field comes back untouched (same object)", () => {
  const f: FormField = { key: "Nope" };
  expect(resolveField(f, C)).toBe(f);
});

test("an Edm integer (DocNum) is shown without digit grouping, an Edm.Double is grouped", () => {
  const c: Constraints = { ...C, DocNum: { Type: "number", EdmType: "Edm.Int32" } };
  const [docNum, total] = resolveColumns([{ key: "DocNum" }, { key: "DocTotal" }], c);
  expect(formatValue(123456, docNum!.type, docNum!.options, docNum!.integer)).toBe("123456");
  expect(formatValue(123456, total!.type, total!.options, total!.integer)).toBe((123456).toLocaleString());
  expect(resolveField({ key: "DocNum" }, c).integer).toBe(true);
});

test("BoYesNoEnum is flagged so the checkbox writes tYES/tNO", () => {
  expect(resolveField({ key: "Printed" }, C).yesNo).toBe(true);
});

test("editability: edit mode, the allowlist, and editableOnCreate only while creating", () => {
  const code = resolveField({ key: "CardCode" }, C);
  const total = resolveField({ key: "DocTotal" }, C);
  expect(isFieldEditable(code, false, false)).toBe(false); // display mode
  expect(isFieldEditable(code, true, false)).toBe(true);
  expect(isFieldEditable(total, true, false)).toBe(false); // not in the allowlist
  expect(isFieldEditable({ ...code, readonly: true }, true, false)).toBe(false);
  expect(isFieldEditable({ ...code, readonly: true, editableOnCreate: true }, true, true)).toBe(true);
  expect(isFieldEditable({ ...code, editableOnCreate: true }, true, false)).toBe(false);
  // Required-only (requiredOnCreate, not Editable): writable on create, not after.
  const typeOnly = resolveField({ key: "CardType" }, { CardType: { Type: "enum", EdmType: "X", Required: true } });
  expect(isFieldEditable(typeOnly, true, true)).toBe(true);
  expect(isFieldEditable(typeOnly, true, false)).toBe(false);
});

test("resolveSections reaches groups and fieldGroup children", () => {
  const [s] = resolveSections([{
    id: "g", label: "G",
    groups: [{ id: "a", fields: [{ key: "cardcode" }, { key: "grp", controlType: "fieldGroup", fields: [{ key: "doctotal" }] }] }],
  }], C);
  expect(s!.groups![0]!.fields[0]!.key).toBe("CardCode");
  expect(s!.groups![0]!.fields[1]!.fields![0]!.key).toBe("DocTotal");
});

test("UDFs not declared become hidden columns and the auto section", () => {
  expect(udfColumns(C).map((c) => [c.key, c.hidden])).toEqual([["U_Note", true], ["U_Prio", true]]);
  const s = udfSection(C, ["U_Prio"]);
  expect(s?.id).toBe("udf");
  expect(s?.label).toBe("User-defined fields");
  expect(s?.fields?.map((f) => [f.key, f.label])).toEqual([["U_Note", "Note"]]);
  expect(udfSection(C, ["U_Note", "U_Prio"])).toBeNull();
});
