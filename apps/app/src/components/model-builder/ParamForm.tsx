import { useMemo } from "react";
import {
  CheckBox, Form, FormGroup, FormItem, Label, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput,
} from "@ui5/webcomponents-react";
import { derivedColumns, displayColumns, type LookupRef, type Param } from "@confire/config-engine";
import { FORM_LAYOUT } from "@confire/ui/formLayout.ts";
import { EditGrid } from "@confire/ui/list-report/EditGrid.tsx";
import { GridForm } from "@confire/ui/list-report/Grid.tsx";
import { ownColumns } from "@confire/ui/metadata.ts";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { masterdataRef, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";

// The parameter page's Domain section (a template): its editor switches with the kind — a manual
// list, a masterdata source, a number range. The rest of the parameter is declared
// (features/model/parameter.ts).

export const W = { width: "100%" } as const;

const label = (text: string, required?: boolean) => <Label required={required} showColon>{text}</Label>;

/** Select hands back the option element; `value` is the string we put on it. Option's own
 *  `selected` prop is deprecated since 2.20 — the parent's `value` is the whole selection API. */
export const optValue = (e: { detail: { selectedOption: { value?: string } } }) =>
  e.detail.selectedOption.value ?? "";

/** "Nothing picked". Not `""`: Select matches an option by `value || textContent`, so an empty
 *  value falls through to the label, nothing matches, and the box renders blank instead of the
 *  placeholder line. A sentinel no table or column can be called is the whole fix. */
export const NONE = "(none)";

// One masterdata namespace, one entry: whether a source is maintained here or read live from
// B1/Beas is a property of the masterdata row, not a choice the model author re-states.
const DOMAIN_KINDS = [
  ["none", "MODEL_DOMAIN_FREE"], ["manual", "MODEL_DOMAIN_MANUAL"], ["masterdata", "MODEL_DOMAIN_MASTERDATA"],
  ["range", "MODEL_DOMAIN_RANGE"],
] as const;

/** Which DOMAIN_KINDS entry the current domain is. */
const domainKind = (d: Param["domain"]) =>
  d === undefined ? "none" : d.kind === "range" ? "range" : d.ref.source === "manual" ? "manual" : "masterdata";

/** A fresh domain of the chosen kind, seeded so it is usable straight away. */
function newDomain(kind: string, tables: TableCols[]): Param["domain"] {
  if (kind === "range") return { kind: "range", min: 0, max: 100, step: 1 };
  if (kind === "manual") return { kind: "options", ref: { source: "manual", options: [] } };
  if (kind === "masterdata") return { kind: "options", ref: masterdataRef(tables[0]) };
  return undefined;
}

export function ParamDomain({ p, set, tables }: {
  p: Param;
  set: (patch: Partial<Param>) => void;
  tables: TableCols[];
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const ref = p.domain?.kind === "options" ? p.domain.ref : null;
  const manualRef = ref?.source === "manual" ? ref : null;
  const sourceRef = ref && ref.source !== "manual" ? ref : null;
  const rangeDomain = p.domain?.kind === "range" ? p.domain : undefined;
  return (
    <>
      <Form layout={FORM_LAYOUT} accessibleMode="Edit" accessibleName={t("MODEL_DOMAIN")}>
        <FormGroup>
          <FormItem labelContent={label(t("MODEL_DOMAIN_FROM"))}>
            <Select accessibleName={t("MODEL_DOMAIN")} value={domainKind(p.domain)} style={W}
              onChange={(e) => set({ domain: newDomain(optValue(e), tables) })}>
              {DOMAIN_KINDS.map(([v, l]) => <Option key={v} value={v}>{t(l)}</Option>)}
            </Select>
          </FormItem>
          {/* About the domains of the *other* parameters, so it belongs here rather than among the flags. */}
          <FormItem labelContent={label(t("MODEL_EXCLUDE"))}>
            <CheckBox accessibleName={t("MODEL_EXCLUDE")} checked={!!p.excludeFromDomains}
              onChange={(e) => set({ excludeFromDomains: e.target.checked || undefined })} />
          </FormItem>
          {rangeDomain ? <RangeEditor value={rangeDomain} onChange={(domain) => set({ domain })} /> : null}
          {sourceRef ? (
            <SourceRefEditor ref_={sourceRef} tables={tables} onChange={(r) => set({ domain: { kind: "options", ref: r } })} />
          ) : null}
        </FormGroup>
      </Form>
      {/* A list of records is a table, in a Form of its own like every grid. */}
      {manualRef ? <ManualOptions ref_={manualRef} onChange={(r) => set({ domain: { kind: "options", ref: r } })} /> : null}
    </>
  );
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
      <FormItem labelContent={label(t("MODEL_MINIMUM"))}>
        <StepInput style={W} value={value.min} accessibleName={t("MODEL_MINIMUM")} onChange={(e) => onChange({ ...value, min: e.target.value ?? 0 })} />
      </FormItem>
      <FormItem labelContent={label(t("MODEL_MAXIMUM"))}>
        <StepInput style={W} value={value.max} accessibleName={t("MODEL_MAXIMUM")}
          valueState={value.max > value.min ? "None" : "Negative"} valueStateMessage={<div>{t("MODEL_MAXIMUM_ERR")}</div>}
          onChange={(e) => onChange({ ...value, max: e.target.value ?? 0 })} />
      </FormItem>
      <FormItem labelContent={label(t("MODEL_STEP"))}>
        <StepInput style={W} value={value.step ?? 1} min={0} accessibleName={t("MODEL_STEP")}
          onChange={(e) => onChange({ ...value, step: e.target.value || undefined })} />
      </FormItem>
    </>
  );
}

// One editor for every masterdata source: pick the table and which extra columns to expose
// (default: all). Key and label columns are convention (refKeyCols), not two more questions —
// the Masterdata page is where a source says which column is its key.
function SourceRefEditor({ ref_, tables, onChange }: {
  ref_: Extract<LookupRef, { source: "table" | "query" }>;
  tables: TableCols[];
  onChange: (r: LookupRef) => void;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const cols = tables.find((table) => table.name === ref_.table)?.columns ?? [];
  const extra = derivedColumns(ref_, cols);
  const displayed = displayColumns(ref_, cols);

  return (
    <>
      <FormItem labelContent={label(t("MODEL_DOMAIN_MASTERDATA"), true)}>
        <Select style={W} value={ref_.table || NONE} accessibleName={t("MODEL_DOMAIN_MASTERDATA")}
          onChange={(e) => onChange(masterdataRef(tables.find((table) => table.name === optValue(e))))}>
          <Option value={NONE}>{tables.length === 0 ? t("MODEL_NONE_DEFINED_PAREN") : t("MODEL_NOT_SELECTED")}</Option>
          {/* Where the rows live rides along as secondary text: a query source reads SAP or Beas
              on demand and opens the paged value help, so it is worth seeing before picking. */}
          {tables.map((table) => (
            <Option key={table.name} value={table.name} additionalText={sourceBadge(table, t)}>{table.name}</Option>
          ))}
        </Select>
      </FormItem>
      <FormItem labelContent={label(t("MODEL_COLS_SHOWN"))}>
        <MultiComboBox style={W} accessibleName={t("MODEL_COLS_SHOWN")}
          onSelectionChange={(e) => {
            const sel = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            onChange({ ...ref_, columns: sel.length === extra.length ? undefined : sel });
          }}>
          {extra.map((c) => <MultiComboBoxItem key={c} text={c} selected={displayed.includes(c)} />)}
        </MultiComboBox>
      </FormItem>
    </>
  );
}

function ManualOptions({ ref_, onChange }: {
  ref_: Extract<LookupRef, { source: "manual" }>;
  onChange: (r: LookupRef) => void;
}) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const columns = useMemo<ListColumn[]>(() => ownColumns([
    { key: "value", label: t("MODEL_COL_VALUE") },
    { key: "label", label: t("MODEL_COL_LABEL"), placeholder: t("MODEL_OPTIONAL") },
  ]), [i18n]);
  const rows = useMemo<Row[]>(() => ref_.options.map((o) => ({ value: o.value === null ? "" : String(o.value), label: o.label })), [ref_.options]);
  return (
    <GridForm name={t("MODEL_OPTIONS")}>
      <EditGrid title={t("MODEL_OPTIONS")} columns={columns} rows={rows} newRow={() => ({ value: "" })}
        onChange={(next) => onChange({
          ...ref_,
          options: next.map((r) => {
            const raw = String(r.value ?? "");
            // numbers stay numbers so table constraints compare correctly
            return { value: raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw, label: (r.label as string | null) || undefined };
          }),
        })} />
    </GridForm>
  );
}
