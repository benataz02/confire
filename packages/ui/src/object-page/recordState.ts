import { validateForm } from "../validation.ts";
import { sameState } from "../views.ts";
import type { FormField, Row } from "../types.ts";

// A record's lifecycle as plain data: what the buffer, the baseline and the errors become on each
// step. useObjectRecord runs it with React; the tests run it bare.

export type CreateAction = "view" | "new" | "back";

/** A problem with no field of its own: listed under its section, jumping to `anchor`. */
export type RecordMessage = { id: string; text: string; detail?: string; section: string; anchor?: string };

/** A record's own rules (`validate`): errors by field key, a grid's by `<row>:<column>` under its
 *  table key, and whatever has no field. Any of them blocks Save. */
export type RecordIssues = {
  fields?: Record<string, string>;
  cells?: Record<string, Record<string, string>>;
  other?: RecordMessage[];
};

export const hasIssues = (i: RecordIssues): boolean =>
  !!(Object.keys(i.fields ?? {}).length || Object.values(i.cells ?? {}).some((c) => Object.keys(c).length) || i.other?.length);

// --- the state, pure ----------------------------------------------------------------------------

export type RecordState = {
  formData: Row;
  /** null = display mode */
  baseline: Row | null;
  /** declared-rule errors (a record without `validate`) */
  errors: Record<string, string>;
  /** value-help keys that do not exist */
  existence: Record<string, string>;
  /** per table key: value-help cells that do not exist */
  cellErrors: Record<string, Record<string, string>>;
  /** a save failure that names no field */
  saveError: string | null;
  /** Save was pressed: a new record shows `validate`'s errors from here on */
  tried: boolean;
  /** refused actions — a Save stopped by validation, or rejected */
  refused: number;
  saving: boolean;
};

export type RecordAction =
  | { type: "load"; data: Row; edit: boolean }
  | { type: "edit"; fn: (r: Row) => Row }
  | { type: "startEdit" }
  | { type: "errors"; errors: Record<string, string> }
  | { type: "existence"; key: string; message: string | null }
  | { type: "saving" }
  | { type: "idle" }
  | { type: "refused"; errors?: Record<string, string>; existence?: Record<string, string>; cells?: Record<string, Record<string, string>>; saveError?: string | null }
  | { type: "saved"; record: Row; keepEditing: boolean }
  | { type: "cancel" };

export const initialRecord = (data: Row, edit: boolean): RecordState => ({
  formData: data, baseline: edit ? data : null, errors: {}, existence: {}, cellErrors: {}, saveError: null, tried: false, refused: 0, saving: false,
});

export function recordReducer(s: RecordState, a: RecordAction): RecordState {
  switch (a.type) {
    case "load": return { ...initialRecord(a.data, a.edit), refused: s.refused };
    case "edit": return { ...s, formData: a.fn(s.formData) };
    case "startEdit": return { ...s, baseline: s.formData };
    case "errors": return sameState(a.errors, s.errors) ? s : { ...s, errors: a.errors };
    case "existence": {
      if (a.message) return { ...s, existence: { ...s.existence, [a.key]: a.message } };
      if (!(a.key in s.existence)) return s;
      const { [a.key]: _gone, ...rest } = s.existence;
      return { ...s, existence: rest };
    }
    case "saving": return { ...s, tried: true, saveError: null, saving: true };
    case "idle": return s.saving ? { ...s, saving: false } : s;
    case "refused": return {
      ...s,
      errors: a.errors ?? s.errors,
      existence: a.existence ?? s.existence,
      cellErrors: a.cells ?? s.cellErrors,
      saveError: a.saveError === undefined ? s.saveError : a.saveError,
      refused: s.refused + 1,
    };
    // An always-editing record takes what it saved as its new baseline; the rest go back to display.
    case "saved": return { ...s, formData: a.record, baseline: a.keepEditing ? a.record : null, errors: {}, cellErrors: {}, saveError: null };
    case "cancel": return { ...s, formData: s.baseline ?? s.formData, baseline: null, errors: {}, existence: {}, saveError: null };
  }
}

/** The errors a Save checks: the record's own `validate` when it has one, else the declared rules. */
export function checkFields(
  validate: ((formData: Row) => RecordIssues) | undefined, fields: FormField[], formData: Row, opts: Parameters<typeof validateForm>[2],
): RecordIssues {
  return validate ? validate(formData) : { fields: validateForm(fields, formData, opts) };
}
