import { useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { confirm } from "../confirm.ts";
import { exists, notFoundMessage } from "../cfl/existence.ts";
import { useUiI18n } from "../i18n.ts";
import { useUiSource } from "../source.tsx";
import { validateCflCells } from "../list-report/EditGrid.tsx";
import { isFieldEditable, resolveSections, sectionFields, sectionTables, udfSection, type EntityConstraints } from "../metadata.ts";
import { evalDyn, getFieldValidationError, isEmptyValue, matchErrorFields } from "../validation.ts";
import { checkFields, hasIssues, initialRecord, recordReducer, type CreateAction, type RecordIssues } from "./recordState.ts";
import { sameState } from "../views.ts";
import type { FormField, Row, Section } from "../types.ts";

// One record's lifecycle (Beas §4.7), for every explicit-save page: data is copied into a buffer,
// Edit takes a baseline, each edit re-validates, Save waits for the value-help checks and validates
// before it hands the diff to the caller, a failed save maps the server's complaint onto the field
// it names, and leaving with unsaved changes asks. ObjectPage makes one itself; a caller that has to
// keep a record alive across routes (the model builder's scope) makes it and passes it in.

export type { CreateAction, RecordIssues, RecordMessage } from "./recordState.ts";

export type SaveContext = { createAction: CreateAction; formData: Row; baseline: Row };

export type RecordOptions = {
  /** the record, or a create seed. Must be a stable object: a new one resets the form. */
  data: Row;
  sections: Section[];
  /** the entity's metadata; without it every declared field is the record's to write */
  constraints?: EntityConstraints;
  isNew?: boolean;
  /** editing from the first render, no Edit; a save rebases and editing goes on */
  alwaysEdit?: boolean;
  /** no Edit at all (a read-only entity) */
  readonly?: boolean;
  /** fields the page shows but never writes (the quote page's server-built lines) */
  lockedFields?: string[];
  /** the record's own rules; replaces the declared ones (`required` then only draws the asterisk) */
  validate?: (formData: Row) => RecordIssues;
  /** the leave guard's "still here": default the same pathname */
  sameRecord?: (current: string, next: string) => boolean;
  /** resolves when the server took it — with the record as stored, when that differs from what was
   *  sent; rejects with the server's error, which the page maps onto fields */
  onSave: (diff: Row, ctx: SaveContext) => Promise<Row | void>;
  /** Cancel on a record that is always editing (new, or alwaysEdit): it leaves */
  onLeave?: () => unknown;
};

// --- the hook -----------------------------------------------------------------------------------

export type ObjectRecord = ReturnType<typeof useObjectRecord>;

export function useObjectRecord(o: RecordOptions) {
  const isNew = !!o.isNew;
  const always = isNew || !!o.alwaysEdit;
  const fields = o.constraints?.fields;
  const i18n = useUiI18n();
  const t = (key: string, ...params: Array<string | number>) => i18n.getText(key, ...params);
  const qc = useQueryClient();
  const { client } = useUiSource();

  // rg() + the auto UDF section, unless the feature declared its own `udf`.
  const sections = useMemo(() => {
    const r = resolveSections(o.sections, fields);
    if (!fields || r.some((s) => s.id === "udf")) return r;
    const declared = r.flatMap((s) => [...sectionFields(s).map((f) => f.key), ...sectionTables(s).map((x) => x.key)]);
    const udf = udfSection(fields, declared);
    return udf ? [...r, udf] : r;
  }, [o.sections, fields]);

  const [s, dispatch] = useReducer(recordReducer, undefined, () => initialRecord(o.data, always));
  const isEditMode = s.baseline !== null;
  const dirty = isEditMode && !sameState(s.formData, s.baseline);
  const touched = useRef(new Set<string>());
  const pending = useRef<Promise<unknown>[]>([]);
  const saving = useRef(false);
  // The last state, for a save in the same tick as an edit and for the guard's async callback.
  const latest = useRef({ s, dirty, isNew, o });
  latest.current = { s, dirty, isNew, o };

  // A new record from the caller (load, reload after save, record navigation) replaces the form —
  // except the same record arriving again (a background refetch) while there are unsaved edits:
  // those stay, as in Beas.
  const rowKey = (r: Row) => (o.constraints?.keys ?? []).map((k) => String(r[k] ?? "")).join("|");
  const lastData = useRef(o.data);
  const lastKey = useRef(rowKey(o.data));
  useEffect(() => {
    if (lastData.current === o.data) return;
    lastData.current = o.data;
    const k = rowKey(o.data);
    const same = k === lastKey.current;
    lastKey.current = k;
    if (same && !isNew && latest.current.dirty) return;
    touched.current.clear();
    dispatch({ type: "load", data: o.data, edit: always });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.data]);

  const locked = useMemo(() => new Set(o.lockedFields ?? []), [o.lockedFields]);
  const isEditable = useCallback(
    (f: FormField) => !o.readonly && !locked.has(f.key) && isFieldEditable(f, isEditMode, isNew),
    [o.readonly, locked, isEditMode, isNew],
  );
  // B1 lines are written only with a new document: editing an existing one's lines needs B1's
  // ReplaceCollectionsOnPatch semantics, which nothing here does yet. A record with no metadata
  // owns its lines.
  const isTableEditable = useCallback(
    (key: string) => isEditMode && !o.readonly && !locked.has(key) && (!fields || (isNew && !!fields[key]?.Editable)),
    [isEditMode, o.readonly, locked, fields, isNew],
  );

  const visible = useMemo(
    () => sections.filter((x) => evalDyn(x.visible, s.formData, isEditMode, isNew) !== false),
    [sections, s.formData, isEditMode, isNew],
  );
  // Every field validation reads, plus each collection as a field of its own (Required = at least
  // one line).
  const allFields = useMemo<FormField[]>(
    () => visible.flatMap((x) => [
      ...sectionFields(x),
      ...sectionTables(x).map((tb) => ({
        key: tb.key, label: x.label, type: "collection" as const, required: !!fields?.[tb.key]?.Required,
        metaEditable: isTableEditable(tb.key), metaRequired: !!fields?.[tb.key]?.Required,
      })),
    ]),
    [visible, fields, isTableEditable],
  );
  // What an edit of a key runs besides the edit: a field's or a grid's `onChange`.
  const onChangeOf = useMemo(() => new Map<string, (v: unknown, next: Row, prev: Row) => Row | void>(sections.flatMap((x) => [
    ...sectionFields(x).flatMap((f) => (f.onChange ? [[f.key, f.onChange] as const] : [])),
    ...sectionTables(x).flatMap((tb) => (tb.onChange ? [[tb.key, (v: unknown, n: Row, p: Row) => tb.onChange!(v as Row[], n, p)] as const] : [])),
  ])), [sections]);

  // Declared rules: each edit re-validates the fields it touched and every field whose `required`
  // is dynamic. A record with `validate` reads its errors off the record instead (below).
  useEffect(() => {
    if (!isEditMode || o.validate) return;
    const next = { ...s.errors };
    for (const f of allFields) {
      if (!touched.current.has(f.key) && typeof f.required !== "function" && !(f.key in s.errors)) continue;
      const e = isEditable(f) ? getFieldValidationError(f, s.formData[f.key], s.formData, isEditMode, isNew, t) : null;
      if (e) next[f.key] = e;
      else delete next[f.key];
    }
    dispatch({ type: "errors", errors: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.formData]);

  // The record's own rules lag fast typing rather than block a keystroke. A loaded record shows them
  // at once; a new one once Save was pressed — an empty form is not a mistake yet.
  const deferred = useDeferredValue(s.formData);
  const issues = useMemo(() => (o.validate ? o.validate(deferred) : null), [o.validate, deferred]);
  const showIssues = !!issues && (!isNew || s.tried);

  const updateField = useCallback((key: string, value: unknown) => {
    touched.current.add(key);
    dispatch({
      type: "edit", fn: (prev) => {
        const next = { ...prev, [key]: value };
        const extra = onChangeOf.get(key)?.(value, next, prev);
        return extra ? { ...next, ...extra } : next;
      },
    });
  }, [onChangeOf]);
  /** One edit over several fields. */
  const update = useCallback((fn: (r: Row) => Row) => dispatch({ type: "edit", fn }), []);

  // --- unsaved-changes guard --------------------------------------------------------------------
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      const { o: opts, isNew: fresh, dirty: d } = latest.current;
      // Same record page (a search param, the section tab): not leaving. Not so for create mode:
      // it lives on the list's own path (`/b1/X#create`), so going to `/b1/X` IS leaving.
      const here = opts.sameRecord ? opts.sameRecord(current.pathname, next.pathname) : !fresh && current.pathname === next.pathname;
      if (here || !d || saving.current) return false;
      return !(await confirm({ title: t("UI_DISCARD_TITLE"), message: t("UI_DISCARD_LEAVE"), actionText: t("UI_DISCARD"), destructive: true }));
    },
    enableBeforeUnload: () => latest.current.dirty,
  });

  // --- save -------------------------------------------------------------------------------------
  /** What goes to the server: the writable fields that differ from the baseline. A cleared B1 text
   *  field is sent as "" (B1 keeps a value it is sent null for); a new document's lines lose their
   *  empty cells (and a line added but never filled goes entirely), and a create skips what was
   *  never filled. A record without metadata sends every changed key. */
  const diffOf = (formData: Row, baseline: Row): Row => {
    const writable = (key: string) => {
      if (locked.has(key)) return false;
      if (!fields) return true;
      const m = fields[key];
      return !!(isNew ? m?.Editable || m?.Required : m?.Editable);
    };
    const out: Row = {};
    for (const [k, v] of Object.entries(formData)) {
      if (!writable(k) || sameState(v, baseline[k])) continue;
      if (isNew && isEmptyValue(v)) continue;
      if (fields && Array.isArray(v))
        out[k] = (v as Row[])
          .map((line) => Object.fromEntries(Object.entries(line).filter(([, x]) => !isEmptyValue(x))))
          .filter((line) => Object.keys(line).length);
      else out[k] = v === null && fields?.[k]?.Type === "string" ? "" : v;
    }
    return out;
  };

  /** Save `next` when given (a caller that changed the record in this same tick), else the buffer. */
  const save = async (next?: Row, createAction: CreateAction = "view") => {
    const formData = next ?? latest.current.s.formData;
    const baseline = latest.current.s.baseline ?? formData;
    if (next) dispatch({ type: "edit", fn: () => next });
    saving.current = true;
    dispatch({ type: "saving" });
    try {
      // 1. value-help checks still in flight
      while (pending.current.length) {
        const ps = pending.current;
        pending.current = [];
        await Promise.allSettled(ps);
      }
      // 2. changed value-help fields that must exist, probed again
      const ex: Record<string, string> = {};
      for (const f of allFields) {
        if (!f.cfl || f.cfl.mustExist === false || !isEditable(f)) continue;
        const v = formData[f.key];
        if (isEmptyValue(v) || sameState(v, baseline[f.key])) continue;
        if (!(await exists(qc, client, f.cfl, v))) ex[f.key] = notFoundMessage(f.cfl, t);
      }
      // 3. the grids' value-help cells
      const cells: Record<string, Record<string, string>> = {};
      for (const tb of visible.flatMap(sectionTables)) {
        if (!isTableEditable(tb.key)) continue;
        const ce = await validateCflCells(qc, client, tb.columns, (formData[tb.key] as Row[] | undefined) ?? [], t);
        if (Object.keys(ce).length) cells[tb.key] = ce;
      }
      // 4. the rules: the record's own, or the declared ones
      const checked = checkFields(
        o.validate,
        allFields.filter((f) => !locked.has(f.key)),
        formData, { baseline: isNew ? null : baseline, isNew, t },
      );
      const allEx = { ...Object.fromEntries(Object.entries(latest.current.s.existence).filter(([k]) => !(k in ex))), ...ex };
      if (hasIssues(checked) || Object.keys(allEx).length || Object.keys(cells).length) {
        dispatch({ type: "refused", errors: o.validate ? {} : checked.fields ?? {}, existence: allEx, cells });
        return;
      }
      const diff = diffOf(formData, baseline);
      if (!isNew && !Object.keys(diff).length) {
        dispatch({ type: "saved", record: formData, keepEditing: always });
        return;
      }
      const stored = await o.onSave(diff, { createAction, formData, baseline });
      if (!isNew) dispatch({ type: "saved", record: stored ?? formData, keepEditing: always });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const keys = matchErrorFields(msg, allFields.map((f) => f.key));
      dispatch(keys.length
        ? { type: "refused", errors: { ...latest.current.s.errors, ...Object.fromEntries(keys.map((k) => [k, msg])) }, saveError: null }
        : { type: "refused", saveError: msg });
    } finally {
      saving.current = false;
      dispatch({ type: "idle" });
    }
  };

  const cancel = async () => {
    if (dirty && !(await confirm({ title: t("UI_DISCARD_TITLE"), message: t("UI_DISCARD_RECORD"), actionText: t("UI_DISCARD"), destructive: true })))
      return;
    if (always) {
      // Asked already: the guard must not ask again on the way out.
      saving.current = true;
      try { await o.onLeave?.(); } finally { saving.current = false; }
      return;
    }
    dispatch({ type: "cancel" });
  };

  const validated = showIssues ? issues! : {};
  return {
    sections,
    /** the sections the record's state shows (their `visible` rule) */
    visible,
    formData: s.formData,
    baseline: s.baseline,
    isNew,
    /** editing for good: Save rebases, Cancel leaves */
    alwaysEdit: !!o.alwaysEdit,
    isEditMode,
    dirty,
    saving: s.saving,
    readonly: !!o.readonly,
    constraints: o.constraints,
    errors: { ...(o.validate ? validated.fields : s.errors), ...s.existence },
    cellErrors: { ...s.cellErrors, ...validated.cells },
    other: validated.other ?? [],
    /** the record's own rules are on screen: a loaded record, or a new one after its first Save */
    showsIssues: showIssues,
    saveError: s.saveError,
    refused: s.refused,
    isEditable,
    isTableEditable,
    updateField,
    update,
    onExistenceError: (key: string, message: string | null) => dispatch({ type: "existence", key, message }),
    onCheckStarted: (p: Promise<unknown>) => { pending.current.push(p); },
    onRowSelect: (f: FormField, row: Row) => {
      const patch = f.onRowSelect?.(row);
      if (patch) dispatch({ type: "edit", fn: (prev) => ({ ...prev, ...patch }) });
    },
    startEdit: () => dispatch({ type: "startEdit" }),
    save,
    cancel,
  };
}
