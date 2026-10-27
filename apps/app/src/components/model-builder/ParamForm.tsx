import { useMemo } from "react";
import {
  Button, CheckBox, FlexBox, Form, FormGroup, FormItem, Icon, Input, Label,
  MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput, Text, TextArea,
} from "@ui5/webcomponents-react";
import { checkModel, derivedColumns, displayColumns } from "@confire/config-engine";
import type { LookupRef, ModelDef, Param } from "@confire/config-engine";
import { Grid, TABLE_ITEM } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn } from "@confire/ui/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import { masterdataRef, modelWithParam, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { DeleteRows, useEditGrid } from "./useEditGrid.tsx";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";

type Tables = TableCols[];

// labelSpan 12 = labels on top, the shape ConfiguratorForm uses, so a field looks identical here
// and on the real form. A group fills its columns top to bottom (CSS column-count), so neighbours
// in the source are stacked: order a column's fields together.
// The block headings are ObjectPageSections on the page, so a form here has no headerText.
// Value domain is one form. A form hands each group one column when it has as many groups as
// columns, so every group sets colSpan to the width it keeps: kind and exclude share two, a
// masterdata source shares two, and min/max/step take three — the form widens to three so that
// range stays one row. colSpan is per breakpoint; columnSpan is a single number and would stay
// wide on a phone. FormItem's columnSpan is a documented no-op since UI5 2.23.
export const PAIRS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;
const SPAN2 = PAIRS.layout;
// Three columns from M up so min, max and step stay one row. Two columns would stack the step.
const SPAN3 = "S1 M3 L3 XL3";
export const W = { width: "100%" } as const;
const ICON = { marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" } as const;
const HINT = { color: "var(--sapContent_LabelColor)" } as const;

/** Select hands back the option element; `value` is the string we put on it. Option's own
 *  `selected` prop is deprecated since 2.20 — the parent's `value` is the whole selection API. */
export const optValue = (e: { detail: { selectedOption: { value?: string } } }) =>
  e.detail.selectedOption.value ?? "";

/** "Nothing picked". Not `""`: Select matches an option by `value || textContent`, so an empty
 *  value falls through to the label, nothing matches, and the box renders blank instead of the
 *  placeholder line. A sentinel no table or column can be called is the whole fix. */
export const NONE = "(none)";

// Every dialog pads its own content column, so the part's default padding is off for all of them.
// Shared with TableDialog and TitleDialog — both wear `confire-pd` too.
if (typeof document !== "undefined") {
  let el = document.getElementById("confire-pd-style");
  if (!el) { el = document.createElement("style"); el.id = "confire-pd-style"; document.head.appendChild(el); }
  el.textContent = `.confire-pd::part(content){padding:0;}`;
}

/** Label + the ⓘ carrying the field's explanation — the only help a field gets. */
export const lbl = (text: string, help: string, required?: boolean) => (
  <Label required={required}>
    {text}
    <Icon name="message-information" title={help} accessibleName={help} style={ICON} />
  </Label>
);

// Friendly name, glyph, and the one-line rule that decides when each control is the right one.
const UI_META: Record<Param["ui"], { text: string; icon: string; hint: string }> = {
  input: { text: "MODEL_UI_INPUT", icon: "edit", hint: "MODEL_UI_INPUT_HINT" },
  select: { text: "MODEL_UI_SELECT", icon: "slim-arrow-down", hint: "MODEL_UI_SELECT_HINT" },
  radio: { text: "MODEL_UI_RADIO", icon: "circle-task-2", hint: "MODEL_UI_RADIO_HINT" },
  checkbox: { text: "MODEL_UI_CHECK", icon: "accept", hint: "MODEL_UI_CHECK_HINT" },
  multicombo: { text: "MODEL_UI_MULTI", icon: "multiselect-all", hint: "MODEL_UI_MULTI_HINT" },
  step: { text: "MODEL_UI_STEP", icon: "number-sign", hint: "MODEL_UI_STEP_HINT" },
};

// One masterdata namespace, one entry: whether a source is maintained here or read live from
// B1/Beas is a property of the masterdata row, not a choice the model author re-states.
const DOMAIN_KINDS = [
  ["none", "MODEL_DOMAIN_FREE"], ["manual", "MODEL_DOMAIN_MANUAL"], ["masterdata", "MODEL_DOMAIN_MASTERDATA"],
  ["range", "MODEL_DOMAIN_RANGE"],
] as const;

/** Blocks Save: the domain is half-built and would resolve to no options at all. A source with no
 *  columns is checkModel's to report — the key column is convention now, not a field here. */
function domainIssue(p: Param, t: Translate): string | undefined {
  if (p.domain?.kind !== "options") return undefined;
  const ref = p.domain.ref;
  if (ref.source !== "manual" && !ref.table) return t("MODEL_CHOOSE_MASTERDATA");
  return undefined;
}

/** Doesn't block Save — the model still checks out, the type/control pairing just won't behave. */
function controlIssue(p: Param, t: Translate): string | undefined {
  if (p.ui === "checkbox" && p.type !== "boolean") return t("MODEL_CHECKBOX_TYPE");
  if (p.ui === "step" && p.type !== "number") return t("MODEL_STEP_TYPE");
  if ((p.ui === "select" || p.ui === "radio" || p.ui === "multicombo") && !p.domain && p.type !== "boolean")
    return t("MODEL_CONTROL_DOMAIN");
  return undefined;
}

const keyOk = (key: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);

/** Save stays enabled until the first click. These are the problems that click reveals instead of writing. */
export function paramBlocked(p: Param, draft: ModelDef, isNew: boolean, t: Translate): boolean {
  const taken = isNew && draft.parameters.some((x) => x.key === p.key);
  return !keyOk(p.key) || taken || !p.label || !!domainIssue(p, t);
}

export function useParamFields({ draft, tables, p, set, tried, isNew }: {
  draft: ModelDef; tables: Tables; p: Param; isNew: boolean; tried: boolean;
  set: (patch: Partial<Param>) => void;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);

  const ok = keyOk(p.key);
  const keyTaken = isNew && draft.parameters.some((x) => x.key === p.key);
  const dIssue = domainIssue(p, t);
  const cIssue = controlIssue(p, t);

  // The draft with this parameter's own derived keys in scope — both the expression suggestions
  // and checkModel are read against it, so an unsaved rename resolves the way it will once saved.
  const scope = modelWithParam(draft, p);
  const at = scope.parameters.findIndex((x) => x.key === p.key);
  const issues = useMemo(() => checkModel(scope, tables), [scope, tables]);
  const mine = at < 0 ? [] : issues.filter((x) => x.path.startsWith(`parameters[${at}]`));
  const exprIssue = (field: string) =>
    tried && at >= 0 ? issueFor(issues, `parameters[${at}].${field}`) : undefined;

  const errors = tried
    ? [...new Set([
        ...(ok ? [] : [t("MODEL_KEY_INVALID")]),
        ...(keyTaken ? [t("MODEL_KEY_TAKEN")] : []),
        ...(p.label ? [] : [t("MODEL_LABEL_REQUIRED")]),
        ...(dIssue ? [dIssue] : []),
        ...mine.map((x) => x.message),
      ])]
    : [];

  const ref = p.domain?.kind === "options" ? p.domain.ref : null;
  const manualRef = ref?.source === "manual" ? ref : null;
  const sourceRef = ref && ref.source !== "manual" ? ref : null;
  const rangeDomain = p.domain?.kind === "range" ? p.domain : undefined;

  return {
    tables, p, set, tried, isNew, t, ok, keyTaken, cIssue, scope, at, exprIssue, errors,
    manualRef, sourceRef, rangeDomain,
  };
}

type Fields = ReturnType<typeof useParamFields>;

const FORM = { accessibleMode: "Edit" as const, labelSpan: PAIRS.labelSpan };

export function ParamDefinition({ f }: { f: Fields }) {
  const { t, p, set, tried, isNew, ok, keyTaken, errors, cIssue } = f;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {errors.length ? (
        <MessageStrip design="Negative" hideCloseButton>{errors.join(" · ")}</MessageStrip>
      ) : null}
      {cIssue ? <MessageStrip design="Critical" hideCloseButton>{cIssue}</MessageStrip> : null}

      <Form {...FORM} accessibleName={t("MODEL_DEFINITION")} layout={SPAN2}>
        <FormGroup accessibleName={t("MODEL_DEFINITION")}>
          <FormItem labelContent={lbl(t("MODEL_KEY"), t("MODEL_PARAM_KEY_HELP"), true)}>
            {/* An untouched new parameter isn't an error yet — only complain once Save is pressed. */}
            <Input value={p.key} disabled={!isNew} style={W}
              valueState={!tried || (ok && !keyTaken) ? "None" : "Negative"}
              valueStateMessage={<div>{keyTaken ? t("MODEL_KEY_TAKEN") : t("MODEL_KEY_RULE")}</div>}
              onInput={(e) => set({ key: e.target.value })} />
          </FormItem>

          <FormItem labelContent={lbl(t("MODEL_COL_LABEL"), t("MODEL_LABEL_HELP"), true)}>
            <Input value={p.label} style={W} valueState={!tried || p.label ? "None" : "Negative"}
              valueStateMessage={<div>{t("MODEL_LABEL_ERR")}</div>}
              onInput={(e) => set({ label: e.target.value })} />
          </FormItem>

          {/* The help text annotates the label, so it closes the first column rather than sitting
              in the second: this column is everything the salesperson reads. */}
          <FormItem labelContent={lbl(t("MODEL_HELP"), t("MODEL_HELP_HELP"))}>
            <TextArea rows={3} value={p.help ?? ""} style={W}
              onInput={(e) => set({ help: e.target.value || undefined })} />
          </FormItem>

          {/* Second column starts here: what the field holds and how it is asked. Type leads it
              because it decides which controls are legal — see controlIssue. */}
          <FormItem labelContent={lbl(t("MODEL_TYPE"), t("MODEL_TYPE_HELP"))}>
            <Select value={p.type} style={W}
              onChange={(e) => set({ type: optValue(e) as Param["type"] })}>
              {(["string", "number", "boolean"] as const).map((type) => <Option key={type} value={type}>{type}</Option>)}
            </Select>
          </FormItem>

          <FormItem labelContent={lbl(t("MODEL_UNIT"), t("MODEL_UNIT_HELP"))}>
            <Input value={p.unit ?? ""} placeholder={t("MODEL_UNIT_PH")} style={W}
              onInput={(e) => set({ unit: e.target.value || undefined })} />
          </FormItem>

          <FormItem labelContent={lbl(t("MODEL_CONTROL"), t("MODEL_CONTROL_HELP"))}>
            {/* Six controls is past what a segmented button should carry, and the hint belongs
                under the field rather than in six tooltips nobody hovers. */}
            <FlexBox direction="Column" gap="0.25rem" style={W}>
              <Select accessibleName={t("MODEL_CONTROL")} value={p.ui} style={W}
                onChange={(e) => set({ ui: optValue(e) as Param["ui"] })}>
                {(Object.keys(UI_META) as Param["ui"][]).map((u) => (
                  <Option key={u} value={u} icon={UI_META[u].icon}>{t(UI_META[u].text)}</Option>
                ))}
              </Select>
              <Text style={HINT}>{t(UI_META[p.ui].hint)}</Text>
            </FlexBox>
          </FormItem>
        </FormGroup>
      </Form>
    </div>
  );
}

export function ParamDomain({ f }: { f: Fields }) {
  const { t, p, set, tried, tables, manualRef, sourceRef, rangeDomain } = f;
  return (
    <Form {...FORM} accessibleName={t("MODEL_DOMAIN")} layout={rangeDomain ? SPAN3 : SPAN2}>
      <FormGroup accessibleName={t("MODEL_DOMAIN")} colSpan={SPAN2}>
        <FormItem labelContent={lbl(t("MODEL_DOMAIN_FROM"), t("MODEL_DOMAIN_HELP"))}>
          <Select accessibleName={t("MODEL_DOMAIN")} value={domainKind(p.domain)} style={W}
            onChange={(e) => set({ domain: newDomain(optValue(e), tables) })}>
            {DOMAIN_KINDS.map(([v, l]) => <Option key={v} value={v}>{t(l)}</Option>)}
          </Select>
        </FormItem>

        {/* Second column: the same subject seen from the other side — this one is about the
            domains of the *other* parameters, so it belongs here rather than among the flags. */}
        <FormItem labelContent={lbl(t("MODEL_EXCLUDE"), t("MODEL_EXCLUDE_HELP"))}>
          <CheckBox text={t("MODEL_EXCLUDE_TEXT")} checked={!!p.excludeFromDomains}
            onChange={(e) => set({ excludeFromDomains: e.target.checked || undefined })} />
        </FormItem>
      </FormGroup>

      {rangeDomain ? (
        <FormGroup accessibleName={t("MODEL_DOMAIN_RANGE")} colSpan={SPAN3}>
          <RangeEditor value={rangeDomain} onChange={(domain) => set({ domain })} />
        </FormGroup>
      ) : null}

      {sourceRef ? (
        <FormGroup accessibleName={t("MODEL_SOURCE")} colSpan={SPAN2}>
          <SourceRefEditor ref_={sourceRef} tried={tried} tables={tables}
            onChange={(ref) => set({ domain: { kind: "options", ref } })} />
        </FormGroup>
      ) : null}

      {/* A list of records is a table. TABLE_ITEM spans the group's columns and hides the label
          slot, so the grid's toolbar is the only heading and the row still lives in this form. */}
      {manualRef ? (
        <FormGroup accessibleName={t("MODEL_OPTIONS")} colSpan={SPAN2}>
          <FormItem className={TABLE_ITEM}>
            <ManualOptions ref_={manualRef} onChange={(ref) => set({ domain: { kind: "options", ref } })} />
          </FormItem>
        </FormGroup>
      ) : null}
    </Form>
  );
}

export function ParamBehavior({ f }: { f: Fields }) {
  const { t, p, set, tables, scope, at, exprIssue } = f;
  return (
    // Four editors of the same height, two per column, each beside the flag that answers the
    // same question without a formula.
    <Form {...FORM} accessibleName={t("MODEL_BEHAVIOR")} layout={SPAN2}>
      <FormGroup accessibleName={t("MODEL_BEHAVIOR")}>
        {/* First column: what the field is worth. Read-only sits under the default that owns it. */}
        <FormItem labelContent={lbl(t("MODEL_DEFAULT"), t("MODEL_DEFAULT_HELP"))}>
          <ExprInput optional rows={3} value={p.defaultExpr} model={scope} tables={tables}
            fieldId={`expr-parameters[${at}].defaultExpr`} issue={exprIssue("defaultExpr")}
            onChange={(v) => set({ defaultExpr: v })} />
        </FormItem>

        <FormItem labelContent={lbl(t("MODEL_READONLY"), t("MODEL_READONLY_HELP"))}>
          <CheckBox text={t("MODEL_READONLY_TEXT")} checked={!!p.readonly}
            onChange={(e) => set({ readonly: e.target.checked || undefined })} />
        </FormItem>

        <FormItem labelContent={lbl(t("MODEL_PRICE_FORMULA"), t("MODEL_PRICE_FORMULA_HELP"))}>
          <ExprInput optional rows={3} value={p.priceExpr} model={scope} tables={tables}
            fieldId={`expr-parameters[${at}].priceExpr`} issue={exprIssue("priceExpr")}
            onChange={(v) => set({ priceExpr: v })} />
        </FormItem>

        {/* Second column: when the field applies. The always-on flag sits directly above the
            conditional version of the same question, so an author reads one then the other. */}
        <FormItem labelContent={lbl(t("MODEL_VISIBLE_WHEN"), t("MODEL_VISIBLE_HELP"))}>
          <ExprInput optional rows={3} placeholder={t("MODEL_VISIBLE_PH")} value={p.visibleWhen} model={scope}
            tables={tables} fieldId={`expr-parameters[${at}].visibleWhen`} issue={exprIssue("visibleWhen")}
            onChange={(v) => set({ visibleWhen: v })} />
        </FormItem>

        <FormItem labelContent={lbl(t("MODEL_MANDATORY"), t("MODEL_MANDATORY_HELP"))}>
          <CheckBox text={t("MODEL_MANDATORY_TEXT")} checked={!!p.mandatory}
            onChange={(e) => set({ mandatory: e.target.checked || undefined })} />
        </FormItem>

        <FormItem labelContent={lbl(t("MODEL_REQUIRED_WHEN"), t("MODEL_REQUIRED_HELP"))}>
          <ExprInput optional rows={3} placeholder={t("MODEL_REQUIRED_PH")} value={p.requiredWhen} model={scope}
            tables={tables} fieldId={`expr-parameters[${at}].requiredWhen`} issue={exprIssue("requiredWhen")}
            onChange={(v) => set({ requiredWhen: v })} />
        </FormItem>
      </FormGroup>
    </Form>
  );
}

/** Which DOMAIN_KINDS entry the current domain is. */
const domainKind = (d: Param["domain"]) =>
  d === undefined ? "none" : d.kind === "range" ? "range" : d.ref.source === "manual" ? "manual" : "masterdata";

/** A fresh domain of the chosen kind, seeded so it is usable straight away. */
function newDomain(kind: string, tables: Tables): Param["domain"] {
  if (kind === "range") return { kind: "range", min: 0, max: 100, step: 1 };
  if (kind === "manual") return { kind: "options", ref: { source: "manual", options: [] } };
  if (kind === "masterdata") return { kind: "options", ref: masterdataRef(tables[0]) };
  return undefined;
}

// Bare FormItems: the caller owns the Form and its group.
function RangeEditor({ value, onChange }: {
  value: Extract<NonNullable<Param["domain"]>, { kind: "range" }>;
  onChange: (d: Param["domain"]) => void;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  return (
    <>
      <FormItem labelContent={lbl(t("MODEL_MINIMUM"), t("MODEL_MINIMUM_HELP"))}>
        <StepInput style={W} value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
      </FormItem>
      <FormItem labelContent={lbl(t("MODEL_MAXIMUM"), t("MODEL_MAXIMUM_HELP"))}>
        <StepInput style={W} value={value.max} valueState={value.max > value.min ? "None" : "Negative"}
          valueStateMessage={<div>{t("MODEL_MAXIMUM_ERR")}</div>}
          onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
      </FormItem>
      <FormItem labelContent={lbl(t("MODEL_STEP"), t("MODEL_STEP_HELP"))}>
        <StepInput style={W} value={value.step ?? 1} min={0} onChange={(e) => onChange({ ...value, step: e.target.value || undefined })} />
      </FormItem>
    </>
  );
}

// One editor for every masterdata source: pick the table and which extra columns to expose
// (default: all). Key and label columns are convention (refKeyCols), not two more questions —
// the Masterdata page is where a source says which column is its key.
function SourceRefEditor({ ref_, tables, tried, onChange }: {
  ref_: Extract<LookupRef, { source: "table" | "query" }>;
  tables: Tables;
  tried: boolean;
  onChange: (r: LookupRef) => void;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const cols = tables.find((table) => table.name === ref_.table)?.columns ?? [];
  const extra = derivedColumns(ref_, cols);
  const displayed = displayColumns(ref_, cols);

  return (
    <>
      <FormItem labelContent={lbl(t("MODEL_DOMAIN_MASTERDATA"),
        cols[1] ? t("MODEL_MD_HELP_BOTH", cols[0] ?? "", cols[1]) : t("MODEL_MD_HELP"),
        true)}>
        <Select style={W} value={ref_.table || NONE}
          valueState={!tried || ref_.table ? "None" : "Negative"}
          valueStateMessage={<div>{tables.length === 0 ? t("MODEL_NO_MASTERDATA") : t("MODEL_CHOOSE_MASTERDATA")}</div>}
          onChange={(e) => onChange(masterdataRef(tables.find((table) => table.name === optValue(e))))}>
          <Option value={NONE}>{tables.length === 0 ? t("MODEL_NONE_DEFINED_PAREN") : t("MODEL_NOT_SELECTED")}</Option>
          {/* Where the rows live rides along as secondary text: a query source reads SAP or Beas
              on demand and opens the paged value help, so it is worth seeing before picking. */}
          {tables.map((table) => (
            <Option key={table.name} value={table.name} additionalText={sourceBadge(table, t)}>{table.name}</Option>
          ))}
        </Select>
      </FormItem>

      <FormItem labelContent={lbl(t("MODEL_COLS_SHOWN"),
        t("MODEL_COLS_SHOWN_HELP", ref_.table || t("MODEL_THIS_SOURCE")))}>
        <MultiComboBox style={W}
          onSelectionChange={(e) => {
            const sel = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            onChange({ ...ref_, columns: sel.length === extra.length ? undefined : sel });
          }}>
          {extra.map((c) => (
            <MultiComboBoxItem key={c} text={c} selected={displayed.includes(c)} />
          ))}
        </MultiComboBox>
      </FormItem>
    </>
  );
}

// A module constant: useEditGrid rebuilds its cell templates when the columns change.
function ManualOptions({ ref_, onChange }: {
  ref_: Extract<LookupRef, { source: "manual" }>;
  onChange: (r: LookupRef) => void;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const optionColumns = useMemo<ListColumn[]>(() => [
    { key: "value", label: t("MODEL_COL_VALUE") },
    { key: "label", label: t("MODEL_COL_LABEL") },
  ], [i18n]);
  const setOpt = (i: number, patch: { value?: string; label?: string }) =>
    onChange({
      ...ref_,
      options: ref_.options.map((o, j) => {
        if (j !== i) return o;
        const raw = patch.value;
        // numbers stay numbers so table constraints compare correctly
        const value = raw === undefined ? o.value : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
        return { value, label: patch.label !== undefined ? patch.label || undefined : o.label };
      }),
    });

  const grid = useEditGrid(ref_.options, optionColumns, {
    value: (o, i) => (
      <Input style={W} value={String(o.value ?? "")} accessibleName={t("MODEL_COL_VALUE")}
        onInput={(e) => setOpt(i, { value: e.target.value })} />
    ),
    label: (o, i) => (
      <Input style={W} value={o.label ?? ""} placeholder={t("MODEL_OPTIONAL")} accessibleName={t("MODEL_COL_LABEL")}
        onInput={(e) => setOpt(i, { label: e.target.value })} />
    ),
  });

  return (
    <Grid {...grid} title={t("MODEL_OPTIONS")} fill={false} selectionMode="Multiple"
      toolbarActions={(sel) => (
        <>
          <Button icon="add" design="Transparent"
            onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>{t("MODEL_ADD_OPTION")}</Button>
          <DeleteRows sel={sel} onDelete={(gone) => onChange({ ...ref_, options: ref_.options.filter((_, j) => !gone.has(j)) })} />
        </>
      )} />
  );
}
