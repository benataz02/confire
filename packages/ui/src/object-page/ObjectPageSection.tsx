import type { ReactElement, ReactNode } from "react";
import {
  Form, FormGroup, FormItem, Icon, Label, ObjectPageSection, ObjectPageSubSection, type ObjectPageSectionPropTypes,
} from "@ui5/webcomponents-react";
import { EditGrid } from "../list-report/EditGrid.tsx";
import { GridForm, type Selection } from "../list-report/Grid.tsx";
import { FORM_LAYOUT } from "../formLayout.ts";
import { evalDyn } from "../validation.ts";
import { FormField } from "./FormField.tsx";
import type {
  Control, FieldTemplate, FormContext, FormField as Field, Group, Row, Section, SectionTable, SectionTemplate,
} from "../types.ts";

// app-object-page-section (LIST-REPORT-OBJECT-PAGE.md §4.5): a section's fields, then its groups,
// then its subsections — or its one collection as a grid — unless a template replaces any of them.
// A subsection is a block of the same kinds: a form or a grid.
//
// A function returning the ObjectPageSection element, not a component: ObjectPage builds its anchor
// bar by reading its children's props (and each section's ObjectPageSubSection children), and a
// component in between hides them.

export type Templates = {
  sectionTemplates?: Record<string, SectionTemplate>;
  groupTemplates?: Record<string, SectionTemplate>;
  subsectionTemplates?: Record<string, SectionTemplate>;
  fieldTemplates?: Record<string, FieldTemplate>;
  /** control kinds by `controlType`, for every field and grid cell that names one */
  controls?: Record<string, Control>;
  /** buttons in a grid's toolbar, keyed by the id of the section or subsection holding it */
  tableActions?: Record<string, (selection: Selection) => ReactNode>;
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
  /** a table section's grid settings, written to the page layout; absent while it loads */
  onTableColumns?: (sectionId: string, keys: string[]) => void;
  templates: Templates;
  /** the anchor or tab title, its Negative messages counted in */
  titleOf: (s: Section) => string;
  /** an informational strip, drawn at the top of the first section */
  banner?: ReactNode;
};

const HELP = { marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_NonInteractiveIconColor)" } as const;

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
        error={ctx.errors[x.key]} controls={ctx.templates.controls}
        onChange={(v) => ctx.updateField(x.key, v)}
        onPatch={(values) => ctx.update((r) => ({ ...r, ...values }))}
        onRowSelect={x.onRowSelect ? (row) => ctx.onRowSelect(x, row) : undefined}
        onExistenceError={(m) => ctx.onExistenceError(x.key, m)}
        onCheckStarted={ctx.onCheckStarted} />
    );
  };
  // An inline field group: one label, several controls side by side.
  const children = f.controlType === "fieldGroup" ? (f.fields ?? []).filter((x) => evalDyn(x.visible, ctx.formData, ctx.isEditMode, ctx.isNew) !== false) : [f];
  const required = children.some((x) => ctx.isEditable(x) && !!evalDyn(x.required, ctx.formData, ctx.isEditMode, ctx.isNew));
  // data-field is what a message in the page's popover scrolls to.
  return (
    <FormItem key={f.key} data-field={f.key} className={f.wide ? "confire-wide-item" : undefined} labelContent={
      <Label required={required} showColon>
        {f.label ?? f.key}
        {f.help ? <Icon name="message-information" title={f.help} accessibleName={f.help} style={HELP} /> : null}
      </Label>
    }>
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
    <Form layout={FORM_LAYOUT} accessibleMode={ctx.isEditMode ? "Edit" : "Display"} itemSpacing={ctx.isEditMode ? "Normal" : "Large"}>
      {direct.length ? <FormGroup>{direct}</FormGroup> : null}
      {(groups ?? []).map((g) => groupBlock(g, ctx))}
    </Form>
  );
};

/** A collection as a grid; `blockId` keys its toolbar actions and its layout. */
function tableOf(t: SectionTable, label: string, blockId: string, ctx: SectionContext) {
  const rows = Array.isArray(ctx.formData[t.key]) ? (ctx.formData[t.key] as Row[]) : [];
  return (
    <div data-field={t.key}>
      {ctx.errors[t.key] ? <Label style={{ color: "var(--sapNegativeTextColor)" }}>{ctx.errors[t.key]}</Label> : null}
      {/* a Form of its own for the card padding a field section gets from formOf */}
      <GridForm name={label}>
        <EditGrid title={label} table={t.key} columns={t.columns} rows={rows} readOnly={!ctx.isTableEditable(t.key)}
          fixedRows={t.fixedRows} newRow={t.newRow} errors={ctx.cellErrors[t.key]} controls={ctx.templates.controls}
          toolbarActions={ctx.templates.tableActions?.[blockId]}
          onColumnsChange={ctx.onTableColumns ? (keys) => ctx.onTableColumns!(blockId, keys) : undefined}
          onChange={(next) => ctx.updateField(t.key, next)} />
      </GridForm>
    </div>
  );
}

type Block = { fields?: Field[]; groups?: Group[]; table?: SectionTable };
const blockOf = (b: Block, label: string, id: string, ctx: SectionContext): ReactNode =>
  b.table ? tableOf(b.table, label, id, ctx)
  : b.fields?.length || b.groups?.length ? formOf(ctx, b.fields, b.groups)
  : undefined;

export function objectPageSection(s: Section, ctx: SectionContext): ReactElement<ObjectPageSectionPropTypes> {
  const content = blockOf(s, s.label, s.id, ctx);
  const tpl = ctx.templates.sectionTemplates?.[s.id];
  const subsections = (s.subsections ?? []).map((sub) => {
    const subTpl = ctx.templates.subsectionTemplates?.[sub.id];
    const subContent = blockOf(sub, sub.label, sub.id, ctx);
    return (
      <ObjectPageSubSection key={sub.id} id={`${s.id}-${sub.id}`} titleText={sub.label}>
        {subTpl ? subTpl({ ...ctx, content: subContent }) : subContent}
      </ObjectPageSubSection>
    );
  });

  return (
    <ObjectPageSection key={s.id} id={s.id} titleText={ctx.titleOf(s)} fitContent={s.fitContent}>
      {ctx.banner}
      {tpl ? tpl({ ...ctx, content }) : content}
      {subsections}
    </ObjectPageSection>
  );
}
