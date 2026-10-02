import { CheckBox, DatePicker, Input, Option, Select, Text, TextArea } from "@ui5/webcomponents-react";
import { decodeBool } from "@confire/b1";
import { CflField } from "../cfl/CflField.tsx";
import { EntityLink, useCanOpen } from "../EntityLink.tsx";
import { formatValue } from "../format.ts";
import { showLink } from "../navigation.ts";
import type { FormField as Field, Row } from "../types.ts";

// beas-form-field (LIST-REPORT-OBJECT-PAGE.md §4.6): one control per field, chosen by `cfl`,
// `controlType` and the metadata Type. The same component draws object page fields and the
// editable lines grid's cells (`inline`). Display mode is text — the Fiori form guideline, and
// what `Form accessibleMode="Display"` announces.

/** Strings past this length render as a TextArea: B1's long text fields (Comments) are 254+. */
const LONG_TEXT = 120;

export function FormField({
  field, value, formData, editable, disabled, error, inline, onChange, onRowSelect, onExistenceError, onCheckStarted,
}: {
  field: Field;
  value: unknown;
  formData: Row;
  editable: boolean;
  disabled?: boolean;
  error?: string;
  /** a grid cell: no label, full width */
  inline?: boolean;
  onChange: (v: unknown) => void;
  onRowSelect?: (row: Row) => void;
  onExistenceError?: (message: string | null) => void;
  onCheckStarted?: (p: Promise<unknown>) => void;
}) {
  const canOpen = useCanOpen();
  const width = { width: "100%" };
  const state = error ? ("Negative" as const) : ("None" as const);
  const message = error ? <div>{error}</div> : undefined;
  const label = field.label ?? field.key;

  if (field.cfl)
    return (
      <CflField config={field.cfl} value={value} onValueChange={onChange} onRowSelect={onRowSelect}
        onExistenceError={onExistenceError} onCheckStarted={onCheckStarted}
        editable={editable} disabled={disabled} error={error ?? null} maxLength={field.validators?.maxLength}
        link={field.link} formData={formData} accessibleName={label} />
    );

  if (!editable) {
    // A plain text field links only read-only, and only with a route or action of its own (§7b).
    const target = field.link && field.link !== true
      ? showLink({ link: field.link, value, row: formData, canOpen })
      : null;
    const text = formatValue(value, field.type, field.options);
    if (target)
      return (
        <EntityLink route={target.route} target={target.target} value={value}
          action={target.action ? (v) => target.action!(v, formData) : undefined}>
          {text}
        </EntityLink>
      );
    return <Text style={inline ? undefined : { whiteSpace: "pre-wrap" }}>{text}</Text>;
  }

  if (field.controlType === "checkbox" || field.type === "boolean")
    return (
      <CheckBox checked={decodeBool(value)} disabled={disabled} accessibleName={label}
        valueState={state}
        // BoYesNoEnum travels as tYES/tNO; Edm.Boolean as true/false.
        onChange={(e) => onChange(field.yesNo ? (e.target.checked ? "tYES" : "tNO") : e.target.checked)} />
    );

  if (field.options || field.controlType === "combobox")
    return (
      <Select style={width} disabled={disabled} accessibleName={label} valueState={state} valueStateMessage={message}
        onChange={(e) => {
          const v = (e.detail.selectedOption as HTMLElement).dataset.v;
          const o = field.options?.find((x) => String(x.value) === v);
          onChange(o ? o.value : null);
        }}>
        <Option data-v="" selected={value === null || value === undefined || value === ""}>—</Option>
        {(field.options ?? []).map((o) => (
          <Option key={String(o.value)} data-v={String(o.value)} selected={String(value) === String(o.value)}>{o.label}</Option>
        ))}
      </Select>
    );

  // Date only, both ways: B1's "2026-08-28T00:00:00Z" shows as 2026-08-28 and goes back the same,
  // which is also the literal its $filter and PATCH accept.
  if (field.type === "date")
    return (
      <DatePicker style={width} disabled={disabled} accessibleName={label} valueFormat="yyyy-MM-dd"
        valueState={state} valueStateMessage={message}
        value={value === null || value === undefined ? "" : String(value).slice(0, 10)}
        onChange={(e) => onChange(e.detail.value || null)} />
    );

  if (field.type === "number")
    return (
      <Input style={width} type="Number" disabled={disabled} accessibleName={label} valueState={state} valueStateMessage={message}
        value={value === null || value === undefined ? "" : String(value)}
        onInput={(e) => {
          const v = e.target.value ?? "";
          onChange(v === "" ? null : Number(v));
        }} />
    );

  const max = field.validators?.maxLength;
  if (!inline && (field.controlType === "textarea" || (max !== undefined && max > LONG_TEXT)))
    return (
      <TextArea growing growingMaxRows={5} rows={2} style={width} disabled={disabled} accessibleName={label}
        maxlength={max} valueState={state} valueStateMessage={message}
        value={value === null || value === undefined ? "" : String(value)}
        onInput={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
    );

  return (
    <Input style={width} disabled={disabled} accessibleName={label} maxlength={max} valueState={state} valueStateMessage={message}
      value={value === null || value === undefined ? "" : String(value)}
      onInput={(e) => onChange(e.target.value === "" ? null : e.target.value)} />
  );
}
