import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, Dialog, FlexBox, Menu, MenuItem, MessageStrip, ObjectPage as Ui5ObjectPage, SplitButton, Tab, TabContainer,
} from "@ui5/webcomponents-react";
import { confirm } from "../../components/confirm.ts";
import { exists, notFoundMessage } from "../cfl/existence.ts";
import { validateCflCells } from "../list-report/EditGrid.tsx";
import { ColumnsTab, type ColumnItem } from "../list-report/GridSettingsDialog.tsx";
import { ViewTitle } from "../list-report/FilterHeader.tsx";
import { isFieldEditable, resolveSections, sectionFields, udfSection, type EntityConstraints } from "../metadata.ts";
import { evalDyn, getFieldValidationError, isEmptyValue, matchErrorFields, validateForm } from "../validation.ts";
import { sameState, useViews } from "../views.ts";
import { applyObjectView, resolveObjectState } from "./objectView.ts";
import { objectPageHeaderArea, objectPageTitle, type RecordNavigation } from "./ObjectPageHeader.tsx";
import { objectPageSection, type SectionContext, type Templates } from "./ObjectPageSection.tsx";
import type { FormField, HeaderConfig, ObjectViewState, Row, Section } from "../types.ts";

// app-object-page (LIST-REPORT-OBJECT-PAGE.md §4): a declared section tree over one record, merged
// with the entity's metadata. The lifecycle is Beas §4.7 — data is copied into formData, Edit takes
// a baseline, each edit re-validates, Save waits for value-help checks and validates before it
// hands the diff to the caller, and a failed save maps SAP's complaint onto the field it names.

export type CreateAction = "view" | "new" | "back";
const CREATE_TEXT: Record<CreateAction, string> = { view: "Create and view", new: "Create and new", back: "Create and back" };

/** Object views are stored under `<entity>::object` (OBJECT_TABLE_SUFFIX on the server). */
const objectTableId = (entity: string) => `${entity}::object`;

export function ObjectPage(p: Templates & {
  /** the metadata entity — names the layout views and the remembered create action */
  entity: string;
  constraints: EntityConstraints;
  /** the record, or a create seed. Must be a stable object: a new one resets the form. */
  data: Row;
  isNew?: boolean;
  /** no Edit at all (the portal, a read-only entity) */
  readonly?: boolean;
  /** Edit is offered but disabled — no ETag came with the row */
  editDisabled?: boolean;
  sections: Section[];
  header: HeaderConfig;
  /** fields the page shows but never writes (the quote page's server-built lines) */
  lockedFields?: string[];
  /** layout views without server calls or save chrome */
  localViews?: boolean;
  /** one create button with this text, instead of the create-and-view/new/back split button */
  createLabel?: string;
  /** resolves when SAP took it; rejects with SAP's error, which the page maps onto fields */
  onSave: (diff: Row, opts: { createAction: CreateAction }) => Promise<void>;
  onCancelCreate?: () => void;
  navigation?: RecordNavigation;
  /** an informational strip above the first section */
  notice?: ReactNode;
}) {
  const { constraints, isNew = false } = p;
  const fields = constraints.fields;
  const qc = useQueryClient();

  // rg() + the auto UDF section, unless the feature declared its own `udf`.
  const resolved = useMemo(() => {
    const r = resolveSections(p.sections, fields);
    if (r.some((s) => s.id === "udf")) return r;
    const declared = r.flatMap((s) => [...sectionFields(s).map((f) => f.key), ...(s.table ? [s.table.key] : [])]);
    const udf = udfSection(fields, declared);
    return udf ? [...r, udf] : r;
  }, [p.sections, fields]);

  const [formData, setFormData] = useState<Row>(p.data);
  const [baseline, setBaseline] = useState<Row | null>(isNew ? p.data : null);
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  const isEditMode = isNew || editing;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [existence, setExistence] = useState<Record<string, string>>({});
  const [cellErrors, setCellErrors] = useState<Record<string, Record<string, string>>>({});
  const [pageError, setPageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<Promise<unknown>[]>([]);
  const touched = useRef(new Set<string>());

  // A new record from the caller (load, reload after save, record navigation) replaces the form —
  // except the same record arriving again (a background refetch) while there are unsaved edits:
  // those stay, as in Beas.
  const rowKey = (r: Row) => constraints.keys.map((k) => String(r[k] ?? "")).join("|");
  const lastKey = useRef(rowKey(p.data));
  useEffect(() => {
    const k = rowKey(p.data);
    const same = k === lastKey.current;
    lastKey.current = k;
    if (same && !isNew && editingRef.current && dirtyRef.current) return;
    setFormData(p.data);
    setBaseline(isNew ? p.data : null);
    setEditing(false);
    setErrors({});
    setExistence({});
    setCellErrors({});
    setPageError(null);
    touched.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.data]);

  const locked = useMemo(() => new Set(p.lockedFields ?? []), [p.lockedFields]);
  const isEditable = useCallback(
    (f: FormField) => !p.readonly && !locked.has(f.key) && isFieldEditable(f, isEditMode, isNew),
    [p.readonly, locked, isEditMode, isNew],
  );
  // Lines are written only with a new document: editing an existing one's lines needs B1's
  // ReplaceCollectionsOnPatch semantics, which nothing here does yet.
  const isTableEditable = useCallback(
    (key: string) => isNew && isEditMode && !p.readonly && !locked.has(key) && !!fields[key]?.Editable,
    [isNew, isEditMode, p.readonly, locked, fields],
  );

  // --- layout views ---------------------------------------------------------------------------
  const resolveLayout = useCallback((s: Partial<ObjectViewState> | null) => resolveObjectState(s, resolved), [resolved]);
  const layout = useViews<ObjectViewState>({ tableId: objectTableId(p.entity), resolve: resolveLayout, local: p.localViews });
  const [layoutOpen, setLayoutOpen] = useState(false);
  // Whatever the layout says, edit mode shows what it can write and what it must send.
  const mustShow = useCallback(
    (f: FormField) => isEditMode && (isEditable(f) || !!evalDyn(f.required, formData, isEditMode, isNew)),
    [isEditMode, isEditable, formData, isNew],
  );
  const shown = useMemo(
    () => (layout.state ? applyObjectView(resolved, layout.state, mustShow) : resolved)
      .filter((s) => evalDyn(s.visible, formData, isEditMode, isNew) !== false),
    [resolved, layout.state, mustShow, formData, isEditMode, isNew],
  );

  // Every field validation reads, plus each collection as a field of its own (Required = at least
  // one line).
  const allFields = useMemo<FormField[]>(
    () => shown.flatMap((s) => (s.table
      ? [{ key: s.table.key, label: s.label, type: "collection" as const, required: !!fields[s.table.key]?.Required, metaEditable: isTableEditable(s.table.key), metaRequired: !!fields[s.table.key]?.Required }]
      : sectionFields(s))),
    [shown, fields, isTableEditable],
  );
  const fieldByKey = useMemo(() => new Map(resolved.flatMap(sectionFields).map((f) => [f.key, f])), [resolved]);

  // Each edit re-validates the fields it touched and every field whose `required` is dynamic.
  useEffect(() => {
    if (!isEditMode) return;
    setErrors((prev) => {
      const next = { ...prev };
      for (const f of allFields) {
        if (!touched.current.has(f.key) && typeof f.required !== "function" && !(f.key in prev)) continue;
        const e = isEditable(f) || (f.type === "collection" && isTableEditable(f.key))
          ? getFieldValidationError(f, formData[f.key], formData, isEditMode, isNew)
          : null;
        if (e) next[f.key] = e;
        else delete next[f.key];
      }
      return sameState(next, prev) ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData]);

  const updateField = useCallback((key: string, value: unknown) => {
    touched.current.add(key);
    setFormData((prev) => {
      const next = { ...prev, [key]: value };
      const extra = fieldByKey.get(key)?.onChange?.(value, next);
      return extra ? { ...next, ...extra } : next;
    });
  }, [fieldByKey]);

  const dirty = isEditMode && baseline !== null && !sameState(formData, baseline);

  // --- unsaved-changes guard ------------------------------------------------------------------
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const savingRef = useRef(false);
  const isNewRef = useRef(isNew);
  isNewRef.current = isNew;
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      // Same record page (a search param, the section anchor): not leaving. Not so for create
      // mode: it lives on the list's own path (`/b1/X#create`), so going to `/b1/X` IS leaving.
      if (!isNewRef.current && current.pathname === next.pathname) return false;
      if (!dirtyRef.current || savingRef.current) return false;
      return !(await confirm({
        title: "Discard changes?",
        message: "This record has unsaved changes. Leave without saving?",
        actionText: "Discard",
        destructive: true,
      }));
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  // --- save -----------------------------------------------------------------------------------
  const writable = (key: string) => {
    const m = fields[key];
    return !locked.has(key) && !!(isNew ? m?.Editable || m?.Required : m?.Editable);
  };

  /** What goes to SAP: the writable fields that differ from the baseline. A cleared text field is
   *  sent as "" (B1 keeps a value it is sent null for); a new document's lines lose their empty
   *  cells, and a create skips what was never filled. */
  const diffOf = (): Row => {
    const out: Row = {};
    for (const [k, v] of Object.entries(formData)) {
      if (!writable(k) || sameState(v, baseline?.[k])) continue;
      if (isNew && isEmptyValue(v)) continue;
      if (Array.isArray(v))
        out[k] = (v as Row[]).map((line) => Object.fromEntries(Object.entries(line).filter(([, x]) => !isEmptyValue(x))));
      else out[k] = v === null && fields[k]?.Type === "string" ? "" : v;
    }
    return out;
  };

  const reportSaveFailed = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    const keys = matchErrorFields(msg, allFields.map((f) => f.key));
    if (keys.length) {
      setErrors((prev) => ({ ...prev, ...Object.fromEntries(keys.map((k) => [k, msg])) }));
      setPageError(null);
    } else setPageError(msg);
  };

  const save = async (createAction: CreateAction) => {
    setSaving(true);
    savingRef.current = true;
    setPageError(null);
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
        if (isEmptyValue(v) || sameState(v, baseline?.[f.key])) continue;
        if (!(await exists(qc, f.cfl, v))) ex[f.key] = notFoundMessage(f.cfl);
      }
      // 3. the lines grid's value-help cells
      const cells: Record<string, Record<string, string>> = {};
      for (const s of shown) {
        if (!s.table || !isTableEditable(s.table.key)) continue;
        const ce = await validateCflCells(qc, s.table.columns, (formData[s.table.key] as Row[] | undefined) ?? []);
        if (Object.keys(ce).length) cells[s.table.key] = ce;
      }
      // 4. the field rules
      const errs = validateForm(
        allFields.map((f) => (f.type === "collection" ? { ...f, metaEditable: isTableEditable(f.key) } : f)).filter((f) => !locked.has(f.key)),
        formData, { baseline, isNew },
      );
      const allEx = { ...Object.fromEntries(Object.entries(existence).filter(([k]) => !(k in ex))), ...ex };
      setErrors(errs);
      setExistence(allEx);
      setCellErrors(cells);
      if (Object.keys(errs).length || Object.keys(allEx).length || Object.keys(cells).length) {
        setPageError("Check the highlighted fields.");
        return;
      }
      const diff = diffOf();
      if (!isNew && !Object.keys(diff).length) {
        setEditing(false);
        setBaseline(null);
        return;
      }
      dirtyRef.current = false;
      await p.onSave(diff, { createAction });
      if (!isNew) {
        setEditing(false);
        setBaseline(null);
      }
    } catch (e) {
      reportSaveFailed(e);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  const cancel = async () => {
    if (dirty && !(await confirm({ title: "Discard changes?", message: "Discard your changes to this record?", actionText: "Discard", destructive: true })))
      return;
    if (isNew) {
      dirtyRef.current = false;
      p.onCancelCreate?.();
      return;
    }
    setFormData(baseline ?? p.data);
    setEditing(false);
    setBaseline(null);
    setErrors({});
    setExistence({});
    setPageError(null);
  };

  // --- create action --------------------------------------------------------------------------
  const storageKey = `confire.createAction.${p.entity}`;
  const [createAction, setCreateAction] = useState<CreateAction>(
    () => (localStorage.getItem(storageKey) as CreateAction | null) ?? "view",
  );
  const [createMenu, setCreateMenu] = useState(false);
  const menuId = `confire-create-${p.entity}`;

  // --- render ---------------------------------------------------------------------------------
  const ctx: SectionContext = {
    formData, isEditMode, isNew, updateField,
    errors: { ...errors, ...existence },
    cellErrors,
    isEditable,
    isTableEditable,
    onExistenceError: (key, m) => setExistence((e) => {
      if (!m) {
        if (!(key in e)) return e;
        const { [key]: _gone, ...rest } = e;
        return rest;
      }
      return { ...e, [key]: m };
    }),
    onCheckStarted: (pr) => { pending.current.push(pr); },
    onRowSelect: (f, row) => {
      const patch = f.onRowSelect?.(row);
      if (patch) setFormData((prev) => ({ ...prev, ...patch }));
    },
    templates: p,
  };

  const banner = p.notice || pageError ? (
    <FlexBox direction="Column" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
      {pageError ? <MessageStrip design="Negative" hideCloseButton>{pageError}</MessageStrip> : null}
      {p.notice}
    </FlexBox>
  ) : null;

  const layoutControl = p.localViews ? undefined : (
    <FlexBox alignItems="Center" style={{ gap: "0.25rem" }}>
      <ViewTitle title="Layout" views={layout} size="H6" />
      <Button design="Transparent" icon="action-settings" tooltip="Adapt layout" accessibleName="Adapt layout"
        disabled={!layout.state} onClick={() => setLayoutOpen(true)} />
    </FlexBox>
  );

  return (
    <>
      <Ui5ObjectPage
        hidePinButton
        titleArea={objectPageTitle({
          header: p.header, formData, label: constraints.label,
          ctx: { formData, isEditMode, isNew, constraints },
          onEdit: !p.readonly && constraints.writable ? () => { setBaseline(formData); setEditing(true); } : undefined,
          editDisabled: p.editDisabled,
          navigation: p.navigation,
          layout: layoutControl,
        })}
        headerArea={objectPageHeaderArea(p.header.facets, formData, fields)}
        footerArea={isEditMode ? (
          <Bar design="FloatingFooter" endContent={
            <>
              {!isNew ? (
                <Button design="Emphasized" disabled={saving || !dirty} onClick={() => void save("view")}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              ) : p.createLabel ? (
                <Button design="Emphasized" disabled={saving} onClick={() => void save("view")}>
                  {saving ? "Creating…" : p.createLabel}
                </Button>
              ) : (
                <SplitButton id={menuId} design="Emphasized" disabled={saving}
                  accessibilityAttributes={{ arrowButton: { hasPopup: "menu", expanded: createMenu } }}
                  onClick={() => void save(createAction)} onArrowClick={() => setCreateMenu(true)}>
                  {saving ? "Creating…" : CREATE_TEXT[createAction]}
                </SplitButton>
              )}
              <Button disabled={saving} onClick={() => void cancel()}>Cancel</Button>
            </>
          } />
        ) : undefined}
      >
        {shown.map((s, i) => objectPageSection(s, { ...ctx, banner: i === 0 ? banner : undefined }))}
      </Ui5ObjectPage>
      {createMenu ? (
        <Menu open opener={menuId} onClose={() => setCreateMenu(false)}
          onItemClick={(e) => {
            const a = (e.detail.item as HTMLElement).dataset.action as CreateAction;
            setCreateMenu(false);
            setCreateAction(a);
            localStorage.setItem(storageKey, a);
            void save(a);
          }}>
          {(Object.keys(CREATE_TEXT) as CreateAction[]).map((a) => (
            <MenuItem key={a} data-action={a} text={CREATE_TEXT[a]} icon={a === createAction ? "accept" : undefined} />
          ))}
        </Menu>
      ) : null}
      {layoutOpen && layout.state ? (
        <LayoutDialog sections={resolved} state={layout.state} mustShow={mustShow}
          onClose={() => setLayoutOpen(false)}
          onConfirm={(next) => { layout.setState(next); setLayoutOpen(false); }} />
      ) : null}
    </>
  );
}

/** "Adapt layout": the GridSettingsDialog Columns tab, once for the sections and once per section
 *  for its fields (or its table's columns). */
function LayoutDialog({ sections, state, mustShow, onConfirm, onClose }: {
  sections: Section[];
  state: ObjectViewState;
  mustShow: (f: FormField) => boolean;
  onConfirm: (next: ObjectViewState) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(state);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const labelOf = (s: Section, key: string) =>
    (s.table?.columns.find((c) => c.key === key)?.label ?? sectionFields(s).find((f) => f.key === key)?.label) ?? key;
  const fieldOf = (s: Section, key: string) => sectionFields(s).find((f) => f.key === key);

  const sectionItems: ColumnItem[] = draft.sections.map((v) => {
    const s = byId.get(v.id);
    return { key: v.id, label: s?.label ?? v.id, visible: v.visible };
  });

  return (
    <Dialog open onClose={onClose} headerText="Adapt layout" resizable className="confire-flush"
      style={{ width: "min(56rem, 95vw)", height: "min(40rem, 85vh)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" onClick={() => onConfirm(draft)}>OK</Button>
            <Button design="Transparent" onClick={onClose}>Cancel</Button>
          </>
        } />
      }>
      <TabContainer className="confire-flush" style={{ height: "100%" }}>
        <Tab text="Sections" selected>
          <ColumnsTab items={sectionItems}
            onChange={(items) => setDraft((d) => ({
              sections: items.map((it) => ({ ...d.sections.find((x) => x.id === it.key)!, visible: it.visible })),
            }))} />
        </Tab>
        {draft.sections.map((v) => {
          const s = byId.get(v.id);
          if (!s) return null;
          const items: ColumnItem[] = v.fields.map((f) => {
            const field = fieldOf(s, f.key);
            return { key: f.key, label: labelOf(s, f.key), visible: f.visible, locked: field ? mustShow(field) : false };
          });
          return (
            <Tab key={v.id} text={s.label}>
              <ColumnsTab items={items}
                onChange={(next) => setDraft((d) => ({
                  sections: d.sections.map((x) => (x.id !== v.id ? x : {
                    ...x,
                    fields: next.map((it) => ({ key: it.key, visible: it.visible })),
                  })),
                }))} />
            </Tab>
          );
        })}
      </TabContainer>
    </Dialog>
  );
}
