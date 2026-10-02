import type { ReactElement, ReactNode } from "react";
import {
  Form, FormGroup, FormItem, Label, ObjectPageSection, ObjectPageSubSection, type ObjectPageSectionPropTypes,
} from "@ui5/webcomponents-react";
import { EditGrid } from "../list-report/EditGrid.tsx";
import { evalDyn } from "../validation.ts";
import { FormField } from "./FormField.tsx";
import type { FieldTemplate, FormContext, FormField as Field, Group, Row, Section, SectionTemplate } from "../types.ts";

// app-object-page-section (LIST-REPORT-OBJECT-PAGE.md §4.5): a section's fields, then its groups,
// then its subsections — or its one collection as a grid — unless a template replaces any of them.
//
// A function returning the ObjectPageSection element, not a component: ObjectPage builds its anchor
// bar by reading its children's props (and each section's ObjectPageSubSection children), and a
// component in between hides them.

export type Templates = {
  sectionTemplates?: Record<string, SectionTemplate>;
  groupTemplates?: Record<string, SectionTemplate>;
  subsectionTemplates?: Record<string, SectionTemplate>;
  fieldTemplates?: Record<string, FieldTemplate>;
};

export type SectionContext = FormContext & {
  errors: Record<string, string>;
  /** per table key: cell errors keyed `<row>:<column>` */
  cellErrors: Record<string, Record<string, string>>;
  isEditable: (f: Field) => boolean;
  isTableEditable: (key: string) => boolean;
  onExistenceError: (key: string, message: string | null) => void;
  onCheckStarted: (p: Promise<unknown>) => void;
  onRowSelect: (f: Field, row: Row) => void;
  templates: Templates;
  /** page messages, drawn at the top of the first section */
  banner?: ReactNode;
};

function fieldItem(f: Field, ctx: SectionContext): ReactNode {
  if (evalDyn(f.visible, ctx.formData, ctx.isEditMode, ctx.isNew) === false) return null;
  const disabled = !!evalDyn(f.disabled, ctx.formData, ctx.isEditMode, ctx.isNew);
  const control = (x: Field) => {
    const editable = ctx.isEditable(x);
    const tpl = ctx.templates.fieldTemplates?.[x.key];
    const value = ctx.formData[x.key];
    if (tpl) return tpl({ ...ctx, field: x, value, error: ctx.errors[x.key], isEditable: editable });
    return (
      <FormField key={x.key} field={x} value={value} formData={ctx.formData} editable={editable} disabled={disabled}
        error={ctx.errors[x.key]}
        onChange={(v) => ctx.updateField(x.key, v)}
        onRowSelect={x.onRowSelect ? (row) => ctx.onRowSelect(x, row) : undefined}
        onExistenceError={(m) => ctx.onExistenceError(x.key, m)}
        onCheckStarted={ctx.onCheckStarted} />
    );
  };
  // An inline field group: one label, several controls side by side.
  const children = f.controlType === "fieldGroup" ? (f.fields ?? []).filter((x) => evalDyn(x.visible, ctx.formData, ctx.isEditMode, ctx.isNew) !== false) : [f];
  const required = children.some((x) => ctx.isEditable(x) && !!evalDyn(x.required, ctx.formData, ctx.isEditMode, ctx.isNew));
  return (
    <FormItem key={f.key} labelContent={<Label required={required} showColon>{f.label ?? f.key}</Label>}>
      {children.length === 1
        ? control(children[0]!)
        : <div style={{ display: "flex", gap: "0.5rem", width: "100%" }}>{children.map(control)}</div>}
    </FormItem>
  );
}

function groupBlock(g: Group, ctx: SectionContext): ReactNode {
  const tpl = ctx.templates.groupTemplates?.[g.id];
  const items = g.fields.map((f) => fieldItem(f, ctx)).filter(Boolean);
  if (!tpl && !items.length) return null; // a group with no visible field is not drawn
  return (
    <FormGroup key={g.id} headerText={g.label}>
      {tpl ? <FormItem>{tpl({ ...ctx, content: items })}</FormItem> : items}
    </FormGroup>
  );
}

const formOf = (ctx: SectionContext, fields: Field[] | undefined, groups: Group[] | undefined) => {
  const direct = (fields ?? []).map((f) => fieldItem(f, ctx)).filter(Boolean);
  return (
    <Form layout="S1 M2 L3 XL3" labelSpan="S12 M4 L4 XL4"
      accessibleMode={ctx.isEditMode ? "Edit" : "Display"} itemSpacing={ctx.isEditMode ? "Normal" : "Large"}>
      {direct.length ? <FormGroup>{direct}</FormGroup> : null}
      {(groups ?? []).map((g) => groupBlock(g, ctx))}
    </Form>
  );
};

export function objectPageSection(s: Section, ctx: SectionContext): ReactElement<ObjectPageSectionPropTypes> {
  let content: ReactNode;
  if (s.table) {
    const key = s.table.key;
    const rows = Array.isArray(ctx.formData[key]) ? (ctx.formData[key] as Row[]) : [];
    const editable = ctx.isTableEditable(key);
    content = (
      <>
        {ctx.errors[key] ? <Label style={{ color: "var(--sapNegativeTextColor)" }}>{ctx.errors[key]}</Label> : null}
        <EditGrid columns={s.table.columns} rows={rows} readOnly={!editable} errors={ctx.cellErrors[key]}
          onChange={(next) => ctx.updateField(key, next)} />
      </>
    );
  } else if (s.fields?.length || s.groups?.length) {
    content = formOf(ctx, s.fields, s.groups);
  }

  const tpl = ctx.templates.sectionTemplates?.[s.id];
  const subsections = (s.subsections ?? []).map((sub) => {
    const subTpl = ctx.templates.subsectionTemplates?.[sub.id];
    const subContent = formOf(ctx, undefined, sub.groups);
    return (
      <ObjectPageSubSection key={sub.id} id={`${s.id}-${sub.id}`} titleText={sub.label}>
        {subTpl ? subTpl({ ...ctx, content: subContent }) : subContent}
      </ObjectPageSubSection>
    );
  });

  return (
    <ObjectPageSection key={s.id} id={s.id} titleText={s.label}>
      {ctx.banner}
      {tpl ? tpl({ ...ctx, content }) : content}
      {subsections}
    </ObjectPageSection>
  );
}
