import { isFieldEditable } from "./metadata.ts";
import type { FormField, Row } from "./types.ts";

// Beas' FormValidationService (LIST-REPORT-OBJECT-PAGE.md §4.8). Pure: the object page feeds it
// the resolved fields, so most of these rules are metadata's (MaxLength, Required), not the
// feature's.

export const isEmptyValue = (v: unknown): boolean =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** A rule that may be a function of the record. */
export const evalDyn = <T>(
  rule: T | ((formData: Row, isEditMode: boolean, isNew: boolean) => T) | undefined,
  formData: Row, isEditMode: boolean, isNew: boolean,
): T | undefined =>
  (typeof rule === "function" ? (rule as (d: Row, e: boolean, n: boolean) => T)(formData, isEditMode, isNew) : rule);

/** The first rule a value breaks, in Beas' order: required, min/max, maxLength, pattern, custom. */
export function getFieldValidationError(
  f: FormField, value: unknown, formData: Row, isEditMode = true, isNew = false,
): string | null {
  const required = !!evalDyn(f.required, formData, isEditMode, isNew);
  if (isEmptyValue(value)) return required ? "Enter a value." : null;
  const v = f.validators ?? {};
  if (typeof value === "number") {
    if (v.min !== undefined && value < v.min) return `Must be at least ${v.min}.`;
    if (v.max !== undefined && value > v.max) return `Must be at most ${v.max}.`;
  }
  if (v.maxLength !== undefined && typeof value === "string" && value.length > v.maxLength)
    return `At most ${v.maxLength} characters.`;
  if (v.pattern && !new RegExp(v.pattern).test(String(value))) return "Invalid format.";
  return v.custom?.(value, formData) ?? null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Every editable field's error. Read-only fields are never validated, and on an existing record a
 * field whose value did not change from the edit baseline is skipped unless its `required` rule
 * is dynamic — so legacy data that breaks a rule does not block saving an unrelated change.
 */
export function validateForm(
  fields: FormField[], formData: Row,
  opts: { baseline: Row | null; isNew: boolean; isEditMode?: boolean },
): Record<string, string> {
  const errors: Record<string, string> = {};
  const isEditMode = opts.isEditMode ?? true;
  for (const f of fields) {
    if (!isFieldEditable(f, isEditMode, opts.isNew)) continue;
    if (!opts.isNew && opts.baseline && typeof f.required !== "function" && same(formData[f.key], opts.baseline[f.key]))
      continue;
    const e = getFieldValidationError(f, formData[f.key], formData, isEditMode, opts.isNew);
    if (e) errors[f.key] = e;
  }
  return errors;
}

/**
 * reportSaveFailed's matcher: the field keys a B1 error names. B1 names a column as
 * `[OQUT.CardCode]` and a property as `'CardCode'`; both are matched case-insensitively against
 * the form's own keys, so an inline error lands on the field SAP complained about. Whatever does
 * not match stays a page message.
 */
export function matchErrorFields(message: string, keys: string[]): string[] {
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const found = new Set<string>();
  for (const m of message.matchAll(/\[\w+\.(\w+)\]/g)) {
    const k = lower.get(m[1]!.toLowerCase());
    if (k) found.add(k);
  }
  for (const m of message.matchAll(/'(\w+)'/g)) {
    const k = lower.get(m[1]!.toLowerCase());
    if (k) found.add(k);
  }
  return [...found];
}

/** The fields whose required rule is a function — re-checked whenever any field changes. */
export const dynamicRequired = (fields: FormField[]) => fields.filter((f) => typeof f.required === "function");
