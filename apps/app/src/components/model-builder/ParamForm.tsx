import type { CSSProperties } from "react";
import {
  CheckBox, Form, FormGroup, FormItem, Label, MultiComboBox, MultiComboBoxItem, MultiInput, Option, Select, StepInput, Token,
} from "@ui5/webcomponents-react";
import { derivedColumns, displayColumns, type LookupRef, type Param } from "@confire/config-engine";
import { FORM_LAYOUT } from "@confire/ui/formLayout.ts";
import { columnCaption, masterdataRef, sourceBadge, type TableCols } from "./exprHelpers.ts";
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
    <Form layout={FORM_LAYOUT} accessibleMode="Edit" accessibleName={t("MODEL_DOMAIN")}>
      {/* Spans the Form: beside the options group it would otherwise get one column of two. */}
      <FormGroup colSpan={FORM_LAYOUT}>
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
        {manualRef ? (
          <FormItem labelContent={label(t("MODEL_OPTIONS"))}>
            <ManualList ref_={manualRef} type={p.type} accessibleName={t("MODEL_OPTIONS")}
              onChange={(r) => set({ domain: { kind: "options", ref: r } })} />
          </FormItem>
        ) : null}
        {rangeDomain ? <RangeEditor value={rangeDomain} onChange={(domain) => set({ domain })} /> : null}
        {sourceRef ? (
          <SourceRefEditor ref_={sourceRef} tables={tables} onChange={(r) => set({ domain: { kind: "options", ref: r } })} />
        ) : null}
      </FormGroup>
    </Form>
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
  const source = tables.find((row) => row.name === ref_.table);
  const cols = source?.columns ?? [];
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
        <MultiComboBox style={W} accessibleName={t("MODEL_COLS_SHOWN")} selectedValues={displayed}
          onSelectionChange={(e) => {
            const sel = e.detail.items.flatMap((i) => (i.value ? [i.value] : []));
            onChange({ ...ref_, columns: sel.length === extra.length ? undefined : sel });
          }}>
          {extra.map((c) => {
            const cap = columnCaption(c, source?.labels);
            return <MultiComboBoxItem key={c} value={c} text={cap.text} additionalText={cap.additionalText} />;
          })}
        </MultiComboBox>
      </FormItem>
      {/* One masterdata, each parameter its own rows of it (LookupRef.where). */}
      <FormItem labelContent={label(t("MODEL_ROWS_WHERE"))}>
        <Select style={W} value={ref_.where?.col ?? NONE} accessibleName={t("MODEL_ROWS_WHERE")}
          onChange={(e) => {
            const col = optValue(e);
            const { where: _, ...rest } = ref_;
            onChange(col === NONE ? rest : { ...rest, where: { col, values: ref_.where?.values ?? [] } });
          }}>
          <Option value={NONE}>{t("MODEL_ROWS_ALL")}</Option>
          {cols.map((c) => {
            const cap = columnCaption(c, source?.labels);
            return <Option key={c} value={c} additionalText={cap.additionalText}>{cap.text}</Option>;
          })}
        </Select>
      </FormItem>
      {ref_.where ? (
        <FormItem labelContent={label(t("MODEL_ROWS_VALUES"), true)}>
          {/* Typed rather than picked: a query table's preview is only its first rows. Compared as
              text, so a number column takes "10" as well as 10. */}
          <ManualList type="string" accessibleName={t("MODEL_ROWS_VALUES")}
            error={ref_.where.values.length ? undefined : t("MODEL_ROWS_VALUES_ERR")}
            ref_={{ source: "manual", options: ref_.where.values.map((value) => ({ value })) }}
            onChange={(r) => onChange({ ...ref_, where: { col: ref_.where!.col, values: r.options.map((o) => o.value) } })} />
        </FormItem>
      ) : null}
    </>
  );
}

type ManualRef = Extract<LookupRef, { source: "manual" }>;

/** A manual list as tokens: type a value and Enter (or leave the field) adds it, a pasted
 *  "a, b, c" adds each. Values are the field's type, so constraints compare like with like. A value
 *  that stays keeps the label it had; a list worth labelling belongs in masterdata.
 *  Uncontrolled text, so it is cleared by hand (as BatchInput). */
export function ManualList({ ref_, type, accessibleName, error, style, onChange }: {
  ref_: ManualRef;
  type: Param["type"];
  accessibleName: string;
  error?: string;
  style?: CSSProperties;
  onChange: (r: ManualRef) => void;
}) {
  const i18n = useI18n();
  const coerce = (v: string) => (type === "number" ? Number(v) : type === "boolean" ? v === "true" : v);
  return (
    <MultiInput style={style ?? W} accessibleName={accessibleName} placeholder={i18n.getText("MODEL_MANUAL_PH")}
      valueState={error ? "Negative" : "None"} valueStateMessage={<div>{error}</div>}
      tokens={ref_.options.map((o, i) => <Token key={`${i}:${String(o.value)}`} data-i={i} text={String(o.value)} />)}
      onChange={(e) => {
        const options = [...ref_.options];
        for (const raw of (e.target.value ?? "").split(",").map((v) => v.trim())) {
          const value = coerce(raw);
          if (raw && !Number.isNaN(value) && !options.some((o) => o.value === value)) options.push({ value });
        }
        e.target.value = "";
        if (options.length > ref_.options.length) onChange({ ...ref_, options });
      }}
      onTokenDelete={(e) => {
        const gone = new Set(e.detail.tokens.map((tk) => Number((tk as HTMLElement).dataset.i)));
        onChange({ ...ref_, options: ref_.options.filter((_, i) => !gone.has(i)) });
      }} />
  );
}
