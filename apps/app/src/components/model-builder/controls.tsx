import { useQuery } from "@tanstack/react-query";
import { FlexBox, Input, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput, Text, TextArea } from "@ui5/webcomponents-react";
import { historyFields, historyKey, type ModelDef, type Param, type TableColumn } from "@confire/config-engine";
import { BatchInput } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import type { Control, ControlContext } from "@confire/ui/types.ts";
import { orpc } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { ExprInput } from "./ExprInput.tsx";
import { rowVars, type TableCols } from "./exprHelpers.ts";
import { MasterdataQuerySelect } from "./MasterdataQuerySelect.tsx";

// The builder's control kinds, named by `controlType` in its declarations (features/model/). One
// entry serves every field and grid cell of its kind; each reads the model it is checked against
// (`scope`) at render time, so an expression suggests what the record holds now.

type HistoryMapping = NonNullable<ModelDef["history"]>["mappings"][number];

const W = { width: "100%" } as const;
const HINT = { color: "var(--sapContent_LabelColor)" } as const;

/** Select hands back the option element; `value` is the string we put on it. */
const optValue = (e: { detail: { selectedOption: { value?: string } } }) => e.detail.selectedOption.value ?? "";

const shown = (v: unknown) => (v === null || v === undefined ? "" : String(v));

// Friendly name, glyph, and the one-line rule that decides when each control is the right one.
export const UI_META: Record<Param["ui"], { text: string; icon: string; hint: string }> = {
  input: { text: "MODEL_UI_INPUT", icon: "edit", hint: "MODEL_UI_INPUT_HINT" },
  textarea: { text: "MODEL_UI_TEXTAREA", icon: "document-text", hint: "MODEL_UI_TEXTAREA_HINT" },
  dropdown: { text: "MODEL_UI_DROPDOWN", icon: "slim-arrow-down", hint: "MODEL_UI_DROPDOWN_HINT" },
  select: { text: "MODEL_UI_SELECT", icon: "value-help", hint: "MODEL_UI_SELECT_HINT" },
  radio: { text: "MODEL_UI_RADIO", icon: "circle-task-2", hint: "MODEL_UI_RADIO_HINT" },
  checkbox: { text: "MODEL_UI_CHECK", icon: "accept", hint: "MODEL_UI_CHECK_HINT" },
  multicombo: { text: "MODEL_UI_MULTI", icon: "multiselect-all", hint: "MODEL_UI_MULTI_HINT" },
  slider: { text: "MODEL_UI_SLIDER", icon: "measure", hint: "MODEL_UI_SLIDER_HINT" },
};

// An item code is still an expression — the value help just writes the common case, a quoted
// literal. `asCode` reads that case back out so the picker can show what was picked; anything
// else (a ternary, a parameter) has no single code and is shown as the expression it is.
const LITERAL = /^\s*"([^"\\]*)"\s*$/;
const asCode = (expr: string): string | undefined => LITERAL.exec(expr)?.[1];
const ITEM = { dialogConfig: cfl.items() };

/** historyKey's inverse: a dot only ever separates the items grid from its column. */
const fromKey = (key: string): Pick<HistoryMapping, "param" | "table"> => {
  const [a, b] = key.split(".");
  return b ? { table: a, param: b } : { table: undefined, param: a! };
};

const text = (empty: (c: ControlContext) => string | undefined): Control => (c) =>
  c.editable ? (
    <Input style={W} value={shown(c.value)} placeholder={c.field.placeholder} accessibleName={c.field.label}
      valueState={c.error ? "Negative" : "None"} valueStateMessage={<div>{c.error}</div>}
      onInput={(e) => c.onChange(e.target.value || empty(c))} />
  ) : <Text>{shown(c.value)}</Text>;

/** An expression, checked against `scope`. `vars` are the names a field of this kind adds (a BOM
 *  line's `qty`, the price's `unitCost`, a grid row's own columns). */
const expr = (o: { scope: (c: ControlContext) => ModelDef; tables: TableCols[] }, vars: (c: ControlContext) => string[] | undefined, rows?: number): Control =>
  (c) => (
    <ExprInput value={c.value as string | undefined} model={o.scope(c)} tables={o.tables} extraVars={vars(c)} rows={rows}
      optional={!c.field.required} placeholder={c.field.placeholder} issue={c.error}
      fieldId={`expr-${c.table !== undefined ? `${c.table}[${c.rowIndex}].` : ""}${c.field.key}`}
      onChange={(v) => c.onChange(v)} />
  );

/** Every control kind the builder's pages name. `scope` is the model an expression is checked
 *  against: the record's, or the model with the parameter or table on screen (`c.formData`)
 *  spliced in. */
export function builderControls(o: { scope: (c: ControlContext) => ModelDef; tables: TableCols[] }): Record<string, Control> {
  const e = o;
  const none = () => undefined;
  const qty = () => ["qty"];
  return {
    text: text(() => ""),
    optionalText: text(() => undefined),
    note: (c) => (
      <TextArea rows={3} style={W} value={shown(c.value)} placeholder={c.field.placeholder} accessibleName={c.field.label}
        onInput={(ev) => c.onChange(ev.target.value || undefined)} />
    ),
    count: (c) => (
      <StepInput style={W} min={0} value={(c.value as number | undefined) ?? 0} accessibleName={c.field.label}
        onChange={(ev) => c.onChange(ev.target.value || undefined)} />
    ),
    weight: (c) => (
      <StepInput style={W} value={(c.value as number | undefined) ?? 1} min={0.5} step={0.5} valuePrecision={1} accessibleName={c.field.label}
        onChange={(ev) => c.onChange(ev.target.value ?? 1)} />
    ),
    expr: expr(e, none),
    exprArea: expr(e, none, 3),
    lineExpr: expr(e, qty),
    // A grid row's formula: the model's names plus this table's own columns.
    rowExpr: expr(e, (c) => rowVars((c.formData.columns as TableColumn[] | undefined) ?? [], o.tables), 2),
    batches: (c) => (
      <BatchInput batches={(c.value as number[] | undefined) ?? []} label={c.field.label}
        valueState={c.error ? "Negative" : "None"} onChange={(v) => c.onChange(v)} />
    ),
    masterdataQuery: (c) => (
      <FlexBox direction="Column" gap="0.25rem" style={W}>
        <MasterdataQuerySelect value={c.value as string | undefined} required={!!c.field.required} issue={c.error}
          accessibleName={c.field.label ?? c.field.key} onChange={(v) => c.onChange(v)} />
      </FlexBox>
    ),
    // Picking fills the description too; both stay editable afterwards.
    itemCode: (c) => {
      const v = String(c.value ?? "");
      return (
        <CflField config={ITEM} accessibleName={c.field.label} value={asCode(v) ?? (v.trim() || null)} error={c.error}
          onValueChange={(code) => c.onChange(code === null || code === "" ? '""' : JSON.stringify(String(code)))}
          onRowSelect={(row) => { if (row.ItemName != null) c.patch({ desc: String(row.ItemName) }); }} />
      );
    },
    paramUi: (c) => <ParamUi c={c} />,
    historyDisplay: (c) => <HistoryDisplay c={c} table={o.scope(c).history?.table} />,
    historyColumn: (c) => <HistoryColumn c={c} table={o.scope(c).history?.table} />,
    // Parameters, then the items grid's columns as `<table>.<column>`.
    historyField: (c) => (
      <Select style={W} value={historyKey(c.formData as Pick<HistoryMapping, "param" | "table">)} accessibleName={c.field.label}
        valueState={c.error ? "Negative" : "None"} valueStateMessage={<div>{c.error}</div>}
        onChange={(ev) => c.patch(fromKey(optValue(ev)))}>
        {c.formData.param ? null : <Option value="" />}
        {[...historyFields(o.scope(c)).keys()].map((k) => <Option key={k} value={k}>{k}</Option>)}
      </Select>
    ),
  };
}

/** Seven controls is past what a segmented button should carry, and the hint belongs under the
 *  field rather than in seven tooltips nobody hovers. */
function ParamUi({ c }: { c: ControlContext }) {
  const i18n = useI18n();
  const ui = c.value as Param["ui"];
  return (
    <FlexBox direction="Column" gap="0.25rem" style={W}>
      <Select accessibleName={c.field.label} value={ui} style={W} onChange={(e) => c.onChange(optValue(e))}>
        {(Object.keys(UI_META) as Param["ui"][]).map((u) => (
          <Option key={u} value={u} icon={UI_META[u].icon}>{i18n.getText(UI_META[u].text)}</Option>
        ))}
      </Select>
      <Text style={HINT}>{i18n.getText(UI_META[ui].hint)}</Text>
    </FlexBox>
  );
}

/** The columns of the history query, read off its masterdata row. TanStack dedupes the list. */
function useQueryColumns(table: string | undefined) {
  const md = useQuery(orpc.masterdata.list.queryOptions());
  return (md.data ?? []).find((t) => t.kind === "query" && t.name === table)?.query?.columns ?? [];
}

function HistoryDisplay({ c, table }: { c: ControlContext; table: string | undefined }) {
  const cols = useQueryColumns(table);
  return (
    <MultiComboBox style={W} accessibleName={c.field.label} selectedValues={(c.value as string[] | undefined) ?? []}
      valueState={c.error ? "Negative" : "None"} valueStateMessage={<div>{c.error}</div>}
      onSelectionChange={(e) => c.onChange(e.detail.items.flatMap((it) => (it.value ? [it.value] : [])))}>
      {cols.map((col) => <MultiComboBoxItem key={col} text={col} value={col} />)}
    </MultiComboBox>
  );
}

function HistoryColumn({ c, table }: { c: ControlContext; table: string | undefined }) {
  const cols = useQueryColumns(table);
  return (
    <Select style={W} value={shown(c.value)} accessibleName={c.field.label}
      valueState={c.error ? "Negative" : "None"} valueStateMessage={<div>{c.error}</div>}
      onChange={(e) => c.onChange(optValue(e))}>
      {c.value ? null : <Option value="" />}
      {cols.map((col) => <Option key={col} value={col}>{col}</Option>)}
    </Select>
  );
}
