import { useMemo, useState } from "react";
import {
  Bar, Button, CheckBox, Dialog, FlexBox, Form, FormGroup, FormItem, Icon, Input, Label,
  MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, TextArea,
} from "@ui5/webcomponents-react";
import { checkModel, derivedColumns, displayColumns } from "@confire/config-engine";
import type { LookupRef, ModelDef, Param } from "@confire/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { masterdataRef, modelWithParam, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

type Tables = TableCols[];

// labelSpan 12 = labels on top, the shape ConfiguratorForm uses, so a field looks identical here
// and on the real form. A group flows its items across the columns its form spans, so PAIRS puts
// two fields per row, FULL one and TRIPLE three — one Form per group is what makes that hold,
// because a Form with more groups than columns gives every group a single column instead.
// FormItem's own `columnSpan` is not the way out: a documented no-op since UI5 2.23.
//
// The fill is column-major — items 1,2,3 go down the first column, then 4,5,6 down the second —
// so neighbours in the source are stacked, not side by side. Order items by column, not by row.
export const PAIRS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;
export const FULL = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M1 L1 XL1", headerLevel: "H5" } as const;
const TRIPLE = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M3 L3 XL3", headerLevel: "H5" } as const;
export const W = { width: "100%" } as const;
const ICON = { marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" } as const;
const HINT = { color: "var(--sapContent_LabelColor)" } as const;
const PAD = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" } as const;

/** Select hands back the option element; `value` is the string we put on it. Option's own
 *  `selected` prop is deprecated since 2.20 — the parent's `value` is the whole selection API. */
export const optValue = (e: { detail: { selectedOption: { value?: string } } }) =>
  e.detail.selectedOption.value ?? "";

/** "Nothing picked". Not `""`: Select matches an option by `value || textContent`, so an empty
 *  value falls through to the label, nothing matches, and the box renders blank instead of the
 *  placeholder line. A sentinel no table or column can be called is the whole fix. */
export const NONE = "(none)";

// Every dialog pads its own content column, so the part's default padding is off for all of them.
// Shared with TableDialog and FormulaDialog — both wear `confire-pd` too.
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
  input: { text: "Input field", icon: "edit", hint: "A plain field the salesperson types into — text or a number, whichever the type says. Anything typed is accepted unless a rule rejects it." },
  select: { text: "Dropdown", icon: "slim-arrow-down", hint: "One value from the list — the safest default whenever a domain exists." },
  radio: { text: "Radio", icon: "circle-task-2", hint: "One value with every option on screen; best for three or four choices." },
  checkbox: { text: "Checkbox", icon: "accept", hint: "A single true/false. Needs a boolean type." },
  multicombo: { text: "Multi-select", icon: "multiselect-all", hint: "Several values at once. Options ruled out are hidden rather than greyed." },
  step: { text: "Stepper", icon: "number-sign", hint: "A number with plus and minus. Needs a number type, and honours a range." },
};

// One masterdata namespace, one entry: whether a source is maintained here or read live from
// B1/Beas is a property of the masterdata row, not a choice the model author re-states.
const DOMAIN_KINDS = [
  ["none", "Free entry"], ["manual", "Manual list"], ["masterdata", "Master data"],
  ["range", "Number range"],
] as const;

/** Blocks Save: the domain is half-built and would resolve to no options at all. A source with no
 *  columns is checkModel's to report — the key column is convention now, not a field here. */
function domainIssue(p: Param): string | undefined {
  if (p.domain?.kind !== "options") return undefined;
  const ref = p.domain.ref;
  if (ref.source !== "manual" && !ref.table) return "Choose a master data source.";
  return undefined;
}

/** Doesn't block Save — the model still checks out, the type/control pairing just won't behave. */
function controlIssue(p: Param): string | undefined {
  if (p.ui === "checkbox" && p.type !== "boolean") return "A checkbox stores true or false — set the type to boolean.";
  if (p.ui === "step" && p.type !== "number") return "A stepper counts — set the type to number.";
  if ((p.ui === "select" || p.ui === "radio" || p.ui === "multicombo") && !p.domain && p.type !== "boolean")
    return "This control needs something to list — give it a manual list or a master data source under Value domain.";
  return undefined;
}

export function ParamDialog({ draft, tables, initial, isNew, onOk, onCancel }: {
  draft: ModelDef; tables: Tables; initial: Param; isNew: boolean;
  onOk: (p: Param) => void; onCancel: () => void;
}) {
  const [p, setP] = useState<Param>(initial);
  // Like TableDialog: Save stays enabled and the first click on an invalid parameter reveals the
  // errors instead of saving, so the button never greys out without saying why.
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<Param>) => setP((x) => ({ ...x, ...patch }));

  const keyOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.key);
  const keyTaken = isNew && draft.parameters.some((x) => x.key === p.key);
  const dIssue = domainIssue(p);
  const cIssue = controlIssue(p);
  const blocked = !keyOk || keyTaken || !p.label || !!dIssue;

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
        ...(keyOk ? [] : ["The key must be a valid identifier."]),
        ...(keyTaken ? ["A parameter with this key already exists."] : []),
        ...(p.label ? [] : ["Give the parameter a label."]),
        ...(dIssue ? [dIssue] : []),
        ...mine.map((x) => x.message),
      ])]
    : [];

  const ref = p.domain?.kind === "options" ? p.domain.ref : null;
  const manualRef = ref?.source === "manual" ? ref : null;
  const sourceRef = ref && ref.source !== "manual" ? ref : null;

  return (
    <Dialog open onClose={onCancel} className="confire-pd"
      headerText={isNew ? "New parameter" : `Parameter · ${initial.label || initial.key}`}
      accessibleName={isNew ? "Add parameter" : `Edit parameter ${initial.key}`}
      style={{ width: "min(76rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized"
              onClick={() => (blocked ? setTried(true) : onOk(p))}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }
    >
      <div style={PAD}>
        {errors.length ? (
          <MessageStrip design="Negative" hideCloseButton>{errors.join(" · ")}</MessageStrip>
        ) : null}
        {cIssue ? <MessageStrip design="Critical" hideCloseButton>{cIssue}</MessageStrip> : null}

        <Form {...PAIRS} accessibleMode="Edit" headerText="Definition">
          <FormGroup accessibleName="Definition">
            <FormItem labelContent={lbl("Key", "The name formulas use to refer to this parameter. Fixed once the parameter exists: renaming it would break every formula that mentions it.", true)}>
              {/* An untouched new dialog isn't an error yet — only complain once Save is pressed. */}
              <Input value={p.key} disabled={!isNew} style={W}
                valueState={!tried || (keyOk && !keyTaken) ? "None" : "Negative"}
                valueStateMessage={<div>{keyTaken ? "A parameter with this key already exists." : "Letters, digits and underscore only, and it cannot start with a digit."}</div>}
                onInput={(e) => set({ key: e.target.value })} />
            </FormItem>

            <FormItem labelContent={lbl("Label", "What the salesperson sees above the field on the configuration form. The unit, if set, is appended in brackets.", true)}>
              <Input value={p.label} style={W} valueState={!tried || p.label ? "None" : "Negative"}
                valueStateMessage={<div>The salesperson needs something to read above the field.</div>}
                onInput={(e) => set({ label: e.target.value })} />
            </FormItem>

            <FormItem labelContent={lbl("Type", "How the value is stored and compared. Numbers compare and add up in formulas; text does not.")}>
              <Select value={p.type} style={W}
                onChange={(e) => set({ type: optValue(e) as Param["type"] })}>
                {(["string", "number", "boolean"] as const).map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Select>
            </FormItem>

            <FormItem labelContent={lbl("Unit", "Appended to the label in brackets. Display only — it never converts anything.")}>
              <Input value={p.unit ?? ""} placeholder="mm, kg, pcs…" style={W}
                onInput={(e) => set({ unit: e.target.value || undefined })} />
            </FormItem>

            {/* Second column starts here: what the field does, next to what the field is. */}
            <FormItem labelContent={lbl("Control", "Which input the salesperson gets on the configuration form.")}>
              {/* Six controls is past what a segmented button should carry, and the hint belongs
                  under the field rather than in six tooltips nobody hovers. */}
              <FlexBox direction="Column" gap="0.25rem" style={W}>
                <Select accessibleName="Control" value={p.ui} style={W}
                  onChange={(e) => set({ ui: optValue(e) as Param["ui"] })}>
                  {(Object.keys(UI_META) as Param["ui"][]).map((u) => (
                    <Option key={u} value={u} icon={UI_META[u].icon}>{UI_META[u].text}</Option>
                  ))}
                </Select>
                <Text style={HINT}>{UI_META[p.ui].hint}</Text>
              </FlexBox>
            </FormItem>

            <FormItem labelContent={lbl("Default value", "Filled in automatically and marked “auto”, recalculating whenever its inputs change, until the salesperson edits it by hand.")}>
              <ExprInput optional rows={3} value={p.defaultExpr} model={scope} tables={tables}
                fieldId={`expr-parameters[${at}].defaultExpr`} issue={exprIssue("defaultExpr")}
                onChange={(v) => set({ defaultExpr: v })} />
            </FormItem>

            <FormItem labelContent={lbl("Help text", "Becomes the information icon next to this field’s label on the form. One sentence is plenty.")}>
              <TextArea rows={3} value={p.help ?? ""} style={W}
                onInput={(e) => set({ help: e.target.value || undefined })} />
            </FormItem>

            <FormItem labelContent={lbl("Restrictions", "Read-only: the salesperson sees the value but cannot change it — right for anything a default formula owns. Exclude from domains: this parameter stops narrowing other parameters’ options, for when it is an outcome rather than a choice.")}>
              <FlexBox direction="Column" gap="0.5rem">
                <CheckBox text="Read-only" checked={!!p.readonly}
                  onChange={(e) => set({ readonly: e.target.checked || undefined })} />
                <CheckBox text="Exclude from domains" checked={!!p.excludeFromDomains}
                  onChange={(e) => set({ excludeFromDomains: e.target.checked || undefined })} />
              </FlexBox>
            </FormItem>
          </FormGroup>
        </Form>

        <Form {...FULL} accessibleMode="Edit" headerText="Value domain">
          <FormGroup accessibleName="Value domain">
            <FormItem labelContent={lbl("Where the values come from", "The set of values this parameter may take before any rule narrows it. Free entry constrains nothing — combination rules on the Rules tab still apply.")}>
              <Select accessibleName="Value domain" value={domainKind(p.domain)} style={W}
                onChange={(e) => set({ domain: newDomain(optValue(e), tables) })}>
                {DOMAIN_KINDS.map(([v, l]) => <Option key={v} value={v}>{l}</Option>)}
              </Select>
            </FormItem>
          </FormGroup>
        </Form>

        {/* Min/max/step is one row of three: reading a range down a column hides the pairing. */}
        {p.domain?.kind === "range" ? (
          <Form {...TRIPLE} accessibleMode="Edit">
            <FormGroup accessibleName="Number range">
              <RangeEditor value={p.domain} onChange={(domain) => set({ domain })} />
            </FormGroup>
          </Form>
        ) : null}

        {sourceRef ? (
          <Form {...PAIRS} accessibleMode="Edit">
            <FormGroup accessibleName="Source">
              <SourceRefEditor ref_={sourceRef} tried={tried} tables={tables}
                onChange={(ref) => set({ domain: { kind: "options", ref } })} />
            </FormGroup>
          </Form>
        ) : null}

        {/* Outside the Form: a list of records is a table, and a table is not a form field. */}
        {manualRef ? (
          <ManualOptions ref_={manualRef} onChange={(ref) => set({ domain: { kind: "options", ref } })} />
        ) : null}

        <Form {...PAIRS} accessibleMode="Edit" headerText="Behavior">
          <FormGroup accessibleName="Behavior">
            <FormItem labelContent={lbl("Price formula", "This parameter’s contribution to the quote line. The result appears at the top right of the field, in the model currency.")}>
              <ExprInput optional rows={3} value={p.priceExpr} model={scope} tables={tables}
                fieldId={`expr-parameters[${at}].priceExpr`} issue={exprIssue("priceExpr")}
                onChange={(v) => set({ priceExpr: v })} />
            </FormItem>

            <FormItem labelContent={lbl("Visible when", "Hides the field when this is false; a hidden field keeps the value it already had. Empty means always visible.")}>
              <ExprInput optional rows={3} placeholder="always visible" value={p.visibleWhen} model={scope}
                tables={tables} fieldId={`expr-parameters[${at}].visibleWhen`} issue={exprIssue("visibleWhen")}
                onChange={(v) => set({ visibleWhen: v })} />
            </FormItem>

            <FormItem labelContent={lbl("Required when", "Blocks the quote until the field has a value. Never fires while the field is hidden; empty means never required.")}>
              <ExprInput optional rows={3} placeholder="never required" value={p.requiredWhen} model={scope}
                tables={tables} fieldId={`expr-parameters[${at}].requiredWhen`} issue={exprIssue("requiredWhen")}
                onChange={(v) => set({ requiredWhen: v })} />
            </FormItem>
          </FormGroup>
        </Form>
      </div>
    </Dialog>
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
  return (
    <>
      <FormItem labelContent={lbl("Minimum", "A range only makes sense on a number type. The stepper enforces the bounds; a “required when” formula can still narrow them.")}>
        <StepInput style={W} value={value.min} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
      </FormItem>
      <FormItem labelContent={lbl("Maximum", "The top of the range, inclusive. It has to sit above the minimum.")}>
        <StepInput style={W} value={value.max} valueState={value.max > value.min ? "None" : "Negative"}
          valueStateMessage={<div>The maximum has to be above the minimum.</div>}
          onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
      </FormItem>
      <FormItem labelContent={lbl("Step", "How far one press of plus or minus moves. Leave it at 1 for whole units.")}>
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
  const cols = tables.find((t) => t.name === ref_.table)?.columns ?? [];
  const extra = derivedColumns(ref_, cols);
  const displayed = displayColumns(ref_, cols);

  return (
    <>
      <FormItem labelContent={lbl("Master data",
        `Rows maintained in Confire, or a live B1/Beas read paged on demand — whichever the Masterdata page defines. Key = 1st column${cols[1] ? `, label = 2nd (${cols[0]} / ${cols[1]})` : ""}.`,
        true)}>
        <Select style={W} value={ref_.table || NONE}
          valueState={!tried || ref_.table ? "None" : "Negative"}
          valueStateMessage={<div>{tables.length === 0
            ? "No master data is defined yet — add a table or a query on the Masterdata page."
            : "Choose a master data source."}</div>}
          onChange={(e) => onChange(masterdataRef(tables.find((t) => t.name === optValue(e))))}>
          <Option value={NONE}>{tables.length === 0 ? "(none defined)" : "(not selected)"}</Option>
          {/* Where the rows live rides along as secondary text: a query source reads SAP or Beas
              on demand and opens the paged value help, so it is worth seeing before picking. */}
          {tables.map((t) => (
            <Option key={t.name} value={t.name} additionalText={sourceBadge(t)}>{t.name}</Option>
          ))}
        </Select>
      </FormItem>

      <FormItem labelContent={lbl("Columns shown in the picker",
        `Only changes what the salesperson sees: every column of ${ref_.table || "this source"} stays usable in formulas as <param>_<column>.`)}>
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

function ManualOptions({ ref_, onChange }: {
  ref_: Extract<LookupRef, { source: "manual" }>;
  onChange: (r: LookupRef) => void;
}) {
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

  return (
    <>
      <Table accessibleName="Options" noDataText="No options yet." rowActionCount={1} overflowMode="Popin"
        onRowActionClick={(e) => {
          const i = Number((e.detail.row as unknown as HTMLElement).dataset.idx);
          onChange({ ...ref_, options: ref_.options.filter((_, j) => j !== i) });
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="10rem"><span>Value</span></TableHeaderCell>
            <TableHeaderCell minWidth="10rem"><span>Label</span></TableHeaderCell>
          </TableHeaderRow>
        }>
        {ref_.options.map((o, i) => (
          <TableRow key={i} rowKey={`opt-${i}`} data-idx={String(i)}
            actions={<TableRowAction icon="delete" text="Remove option" />}>
            <TableCell>
              <Input value={String(o.value ?? "")} accessibleName="Value"
                onInput={(e) => setOpt(i, { value: e.target.value })} />
            </TableCell>
            <TableCell>
              <Input value={o.label ?? ""} placeholder="optional" accessibleName="Label"
                onInput={(e) => setOpt(i, { label: e.target.value })} />
            </TableCell>
          </TableRow>
        ))}
      </Table>
      <div>
        <Button icon="add"
          onClick={() => onChange({ ...ref_, options: [...ref_.options, { value: "" }] })}>Add option</Button>
      </div>
    </>
  );
}
