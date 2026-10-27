import {
  CheckBox, Form, FormGroup, FormItem, Icon, Input, Label, MultiComboBox, MultiComboBoxItem, MultiInput,
  ObjectPageSection, ObjectStatus, Option, RadioButton, SegmentedButton, SegmentedButtonItem, Select, StepInput, Text, Token,
} from "@ui5/webcomponents-react";
import {
  isTableGroup, placedTables,
  type FieldOption, type FormState, type Group, type LookupRef, type ModelDef, type ResolvedTable, type RowMoney, type TableRows, type Val,
} from "@confire/config-engine";
import { CflField } from "../cfl/CflField.tsx";
import { cfl, type QueryScope } from "../cfl/cfl-configs.ts";
import { TABLE_ITEM } from "../list-report/Grid.tsx";
import { ConfigTable } from "./ConfigTable.tsx";
import type { Row } from "./configTableOps.ts";
import { addBatch, BATCHES_PARAM, displayValue } from "./formHelpers.ts";
import { money } from "../money.ts";
import { useUiI18n } from "../i18n.ts";
import { useUiSource } from "../source.tsx";

// The one form the builder preview, the configuration page and the portal render: one
// ObjectPageSection per model section, so the caller's anchor bar navigates the model. It draws a
// form state (config-engine's formState: values, options, visibility, requiredness, badges, broken
// rules) and reports each change; it computes nothing. The ObjectPage, its other sections, footers
// and consistency stay with the caller.

/** The items grid's money at the quantity the section shows. */
export type ItemMoney = { batchQty: number; rows: (RowMoney | null)[] };

/** The signature answer to "is this consistent and how big is it?" — one component so the
 *  string stays identical in the page footer and the preview. */
export function ConsistencyStatus({ form }: { form: Pick<FormState, "conflicts" | "open"> }) {
  const i18n = useUiI18n();
  const conflict = form.conflicts.length ? form.conflicts.map((c) => c.message).join(" · ") : null;
  const open = form.open;
  return (
    <ObjectStatus state={conflict ? "Negative" : "Positive"}>
      {conflict ?? (open === 1 ? i18n.getText("UI_CONSISTENT_ONE") : i18n.getText("UI_CONSISTENT", String(open)))}
    </ObjectStatus>
  );
}

/** Key of the synthetic section that catches tables the author never placed. */
export const UNPLACED_TABLES_SECTION = "__tables";

/** The sections the form renders: the model's own, plus a trailing one holding any table the
 *  author forgot to place. A table nobody can reach is a table whose sums are permanently zero —
 *  and for an items table it would be the quotation's lines going missing. */
function formSections(model: ModelDef): { key: string; title: string; groups: Group[] }[] {
  const defined = new Set((model.tables ?? []).map((t) => t.key));
  // A group left behind by a deleted table is dropped, so it is neither an empty titleless
  // FormGroup nor counted as a second group.
  const own = model.structure.sections.map((s) => ({
    key: s.key, title: s.title, groups: s.groups.filter((g) => !isTableGroup(g) || defined.has(g.table)),
  }));
  const placed = new Set(placedTables(model));
  const orphans = (model.tables ?? []).filter((t) => !placed.has(t.key));
  if (!orphans.length) return own;
  // The catch-all section owns no structure: its orphans become table groups, so they go through
  // the very same Form/FormGroup path a placed table does.
  return [...own, {
    key: UNPLACED_TABLES_SECTION, title: orphans.map((t) => t.title || t.key).join(", "),
    groups: orphans.map((t) => ({ table: t.key })),
  }];
}

// labelSpan 12 everywhere = labels on top of their fields (natively left-aligned), field takes the full column.
const FORM_PROPS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2" } as const;

// A table group holds exactly one FormItem, and it must not be one column wide: the group spans
// the whole Form (colSpan mirrors FORM_PROPS.layout) and the item breaks out of the column flow
// (TABLE_ITEM). ConfigTable's Grid toolbar names the table, with its row count, and carries Add/Delete.

/** A field's provenance mark: the assistant wrote it (with the source as its tip), or a question about
 *  it is open in the assistant. Drawn beside the rule's "Auto". */
export type FieldMark = { kind: "assistant"; tip: string } | { kind: "question" };

export type ConfiguratorProps = {
  model: ModelDef;
  form: FormState;
  /** The display tables: query value helps' first page, the table cells' options. */
  tables: Record<string, ResolvedTable>;
  /** the stored rows of the model's tables, by table key — what the user typed */
  rows?: TableRows;
  /** one field changed; undefined = cleared */
  onChange: (key: string, value: Val | undefined) => void;
  /** omit to render the tables read-only */
  onRowsChange?: (table: string, rows: Row[]) => void;
  disabled?: boolean;
  /** Locked (a quoted configuration). Form goes accessibleMode="Display" and fields render as
   *  Text — the UI5 display-form pattern. Not `disabled`: a pending save still shows inputs. */
  readOnly?: boolean;
  /** where a query field fetches its pages — nothing is fetched until the user opens or types */
  querySource: QueryScope;
  /** the staff app's assistant marks, by parameter key; the portal and the preview pass none */
  marks?: Record<string, FieldMark>;
  onMarkPress?: (key: string, opener: HTMLElement) => void;
  /** batch quantities, for the items grid's batch picker */
  batches?: number[];
  /** cost/price per items row at `itemBatch`; omit and the grid shows no money columns at all —
   *  which is how the builder preview and the portal stay free of cost data */
  itemMoney?: ItemMoney | null;
  /** the batch quantity `itemMoney` is priced at; omit onItemBatchChange and there is no picker */
  itemBatch?: number;
  onItemBatchChange?: (qty: number) => void;
  /** staff may type over a formula cell (a manual override); a client may not */
  formulaOverride?: boolean;
};

/** The model's sections for the caller's ObjectPage. A function, not a component: ObjectPage reads
 *  its sections (ids, titles, the anchor bar) off its own children, so a component in between would
 *  hide them. */
export function configuratorSections(props: ConfiguratorProps) {
  return formSections(props.model).map((sec) => (
    <ObjectPageSection key={sec.key} id={sec.key} titleText={sec.title}>
      <SectionForm {...props} title={sec.title} groups={sec.groups} />
    </ObjectPageSection>
  ));
}

// One headerless Form per section. The ObjectPageSection is the container — the model section's
// one title, and its anchor; the Form only lays out label/field pairs, and supports exactly one
// level of grouping (Form > FormGroup), so section→ObjectPageSection+Form / group→FormGroup keeps
// both titles. A section's only group drops its own header, which would just repeat the section's.
//
// A section's groups are of two kinds: a table group renders as one full-width, headerless
// FormGroup — the Grid's toolbar titles it from its TableDef (so a rename in TableDialog cannot
// leave a stale heading), and a group header would only say it twice — a field group as the
// ordinary label-and-field group.
function SectionForm({ model, form, tables, rows, onChange, onRowsChange, disabled, readOnly, querySource, batches, itemMoney, itemBatch, onItemBatchChange, formulaOverride, marks, onMarkPress, title, groups }: ConfiguratorProps & {
  title: string;
  groups: Group[];
}) {
  const i18n = useUiI18n();
  const currency = useUiSource().useCurrency();
  const formMode = {
    accessibleMode: readOnly ? "Display" : "Edit",
    itemSpacing: readOnly ? "Large" : "Normal",
  } as const;
  const fieldOf = (key: string) => form.fields[key] ?? { visible: true, required: false };

  // A change that leaves the field as it was is not one — re-picking a default is, it makes the
  // value the user's own.
  const set = (key: string, v: Val | undefined) => {
    const f = fieldOf(key);
    if (!f.defaulted && JSON.stringify(f.value) === JSON.stringify(v)) return;
    onChange(key, v);
  };

  const control = (key: string) => {
    const p = model.parameters.find((x) => x.key === key)!;
    const f = fieldOf(key);
    const dom: FieldOption[] = f.options ?? [];
    const v = f.value;
    if (readOnly || p.readonly) return <Text>{displayValue(v, dom)}</Text>;

    // The asterisk on the label says the field is required. While it is still empty the control is
    // Critical — unfinished, not wrong — and carries no value-state message. A broken rule outranks
    // that: Negative, and the rule text is the message. `v` is the propagated value, so a field an
    // auto-default filled already counts as answered.
    // Radio and checkbox get the asterisk only: a checkbox is never empty (false is an answer), and
    // painting every radio in a group would read as "these options are wrong".
    // f.required, not p.mandatory: it also holds requiredWhen — what the server's `missing` gates on.
    const req = f.required;
    const empty = v === undefined || v === null || v === "";
    const rule = f.conflicts;
    const ruleState = rule ? "Negative" : "None";
    const ruleMessage = rule ? <div>{rule.join(" · ")}</div> : undefined;
    const valueState = rule ? "Negative" : req && empty ? "Critical" : "None";
    const reqProps = {
      required: req,
      valueState,
      // Only a broken rule names itself. An empty mandatory field has no message of its own.
      ...(ruleMessage ? { valueStateMessage: ruleMessage } : {}),
    } as const;

    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {dom.map((o, i) => (
            // Only the picked one goes red: it is the value that breaks the rule, not the group.
            <RadioButton key={i} name={`cfg-${key}`} text={o.label} checked={v === o.value}
              valueState={v === o.value ? ruleState : "None"}
              disabled={disabled || !!o.unavailable}
              // tooltip is a runtime ui5 prop the React typing omits (like Option's disabled).
              {...(o.unavailable ? ({ tooltip: i18n.getText("UI_UNAVAILABLE", o.unavailable) } as Record<string, unknown>) : {})}
              onChange={() => set(key, o.value)} />
          ))}
        </div>
      );

    if (p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select")) {
      // a checkbox can only be toggled if flipping it isn't eliminated — that reason is also the tooltip.
      const blocked = dom.find((o) => o.value === (v !== true))?.unavailable;
      return (
        <CheckBox checked={v === true} disabled={disabled || !!blocked} valueState={ruleState}
          // tooltip is a runtime ui5 prop the React typing omits.
          {...(blocked ? ({ tooltip: i18n.getText("UI_UNAVAILABLE", blocked) } as Record<string, unknown>) : {})}
          onChange={(e) => set(key, e.target.checked)} />
      );
    }

    if (p.ui === "multicombo")
      return (
        // MultiComboBoxItem has no disabled prop -> eliminated options are filtered out.
        <MultiComboBox style={{ width: "100%" }} disabled={disabled} {...reqProps}
          onSelectionChange={(e) => {
            const texts = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            set(key, texts.length ? texts : undefined);
          }}>
          {dom.filter((o) => !o.unavailable).map((o, i) => (
            <MultiComboBoxItem key={i} text={String(o.value)} selected={Array.isArray(v) && v.includes(String(o.value))} />
          ))}
        </MultiComboBox>
      );

    if (p.ui === "step") {
      const r = p.domain?.kind === "range" ? p.domain : undefined;
      return (
        <StepInput value={typeof v === "number" ? v : undefined} min={r?.min} max={r?.max} step={r?.step ?? 1}
          style={{ width: "100%" }} disabled={disabled} required={req}
          valueState={valueState} valueStateMessage={ruleMessage}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (p.domain?.kind === "options" && p.domain.ref.source === "query") {
      const ref: LookupRef = p.domain.ref;
      const canonical = tables[ref.table];
      // Label mode: the option's label shows, its key is the entry. The server binds the picked
      // row's `<param>_<column>` values from the stored entry, even off the first page.
      return (
        <CflField config={{ dialogConfig: cfl.masterdataQuery(querySource, ref, canonical, { title: p.label }) }}
          value={v ?? null} disabled={disabled} required={req} requiredState="Critical" accessibleName={p.label} commitOnly
          error={rule?.join(" · ")}
          onValueChange={(nv) => set(key, nv === null || nv === "" ? undefined : (nv as Val))} />
      );
    }

    if (dom.length) { // select (and boolean-with-select)
      return (
        <Select value={v === undefined ? "" : JSON.stringify(v)} style={{ width: "100%" }} disabled={disabled}
          {...reqProps}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(key, j === undefined || j === "" ? undefined : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {dom.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}
              tooltip={o.unavailable ? i18n.getText("UI_UNAVAILABLE", o.unavailable) : undefined}
              additionalText={o.unavailable ? i18n.getText("UI_UNAVAILABLE_SHORT") : o.extra}
              // Option supports disabled at runtime (ListItemBase); the React typing omits it.
              {...(o.unavailable ? ({ disabled: true } as Record<string, unknown>) : {})}>
              {o.label}
            </Option>
          ))}
        </Select>
      );
    }

    return (
      <Input type={p.type === "number" ? "Number" : "Text"} value={v === undefined || v === null ? "" : String(v)}
        style={{ width: "100%" }} disabled={disabled} {...reqProps}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  const defOf = (k: string) => (model.tables ?? []).find((t) => t.key === k);
  const tableRows = rows ?? {};
  const head = (t: string) => (groups.length === 1 ? undefined : t);
  // The items grid prices one batch quantity at a time (one cost and one price column), so its
  // toolbar says which, and lets the user switch. One quantity has nothing to pick.
  const bs = batches ?? [];
  const batchPick = onItemBatchChange && bs.length > 1 ? (
    <SegmentedButton accessibleName={i18n.getText("UI_BATCH_PRICED_AT")} itemsFitContent
      onSelectionChange={(e) => {
        const q = Number((e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.qty);
        if (q) onItemBatchChange(q);
      }}>
      {bs.map((b) => (
        <SegmentedButtonItem key={b} data-qty={b} selected={b === itemBatch}>{i18n.getText("UI_QTY", String(b))}</SegmentedButtonItem>
      ))}
    </SegmentedButton>
  ) : undefined;

  return (
    <Form accessibleName={title} {...FORM_PROPS} {...formMode}>
      {groups.map((g, gi) => {
      if (isTableGroup(g)) {
        const def = defOf(g.table)!;
        return (
          <FormGroup key={`${g.table}:${gi}`} colSpan={FORM_PROPS.layout}>
            {/* data-param: table keys share the parameters' namespace, so a missing-row message
                scrolls here the same way a parameter's does. */}
            <FormItem className={TABLE_ITEM} data-param={g.table}>
              <ConfigTable def={def} rows={tableRows[g.table] ?? []} evaluated={form.tables[g.table] ?? []}
                tables={tables} querySource={querySource}
                disabled={disabled || !onRowsChange} readOnly={readOnly} formulaOverride={formulaOverride}
                money={def.role === "items" ? itemMoney : undefined}
                actions={def.role === "items" ? batchPick : undefined}
                onChange={(next) => onRowsChange?.(g.table, next)} />
            </FormItem>
          </FormGroup>
        );
      }
      const content = g.params.filter((k) => fieldOf(k).visible);
      return (
        <FormGroup key={`${g.key}:${gi}`} headerText={head(g.title)}>
          {content.map((k) => {
            const p = model.parameters.find((x) => x.key === k);
            if (!p) return null;
            const f = fieldOf(k);
            const eliminated = (f.options ?? []).filter((o) => o.unavailable).length;
            // MultiComboBox filters eliminated options out (no per-item disabled in UI5 v2), so
            // unlike Select/Radio it can't show them greyed — explain the gap with a count instead.
            const showEliminatedNote = !readOnly && !p.readonly && p.ui === "multicombo" && eliminated > 0;
            // RadioButton and CheckBox take a valueState but have no valueStateMessage slot, so
            // the broken rule's message is spelled out under them instead.
            const ruleNote = !readOnly && !p.readonly && f.conflicts
              && (p.ui === "radio" || p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select"));
            return (
              <FormItem key={k} labelContent={
                // labelSpan is 12, so the label owns a full-width row above its control — its
                // right end IS the input's top-right corner, which is where the price belongs.
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", width: "100%" }}>
                  <Label required={f.required && !readOnly && !p.readonly}>
                    {p.label + (p.unit ? ` (${p.unit})` : "")}
                    {p.help ? <Icon name="message-information" accessibleName={p.help} title={p.help}
                      style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_IconColor)" }} /> : null}
                  </Label>
                  {f.price !== undefined ? (
                    <ObjectStatus style={{ marginInlineStart: "auto" }}>
                      {money(f.price, currency)}
                    </ObjectStatus>
                  ) : null}
                </div>
              }>
                {/* data-param is what a conflict message in the page's popover scrolls to —
                    the controls themselves vary too much to each carry an id. */}
                <div data-param={k} style={{ display: "flex", flexDirection: "column", gap: "0.125rem", width: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                    {control(k)}
                    {f.defaulted ? <ObjectStatus state="Information">{i18n.getText("UI_AUTO")}</ObjectStatus> : null}
                    {marks?.[k] ? <MarkIcon mark={marks[k]!} label={i18n.getText("UI_MARK_QUESTION")}
                      onPress={(el) => onMarkPress?.(k, el)} /> : null}
                  </div>
                  {showEliminatedNote ? (
                    <Text style={{ fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" }}>
                      {i18n.getText(eliminated === 1 ? "UI_OPTION_UNAVAILABLE" : "UI_OPTIONS_UNAVAILABLE", String(eliminated))}
                    </Text>
                  ) : null}
                  {ruleNote ? f.conflicts!.map((m, i) => (
                    <Text key={i} style={{ fontSize: "0.75rem", color: "var(--sapNegativeTextColor)" }}>{m}</Text>
                  )) : null}
                </div>
              </FormItem>
            );
          })}
        </FormGroup>
      );
      })}
    </Form>
  );
}

/** The batch quantities, as a FormItem in a page's General. Omit onChange to show them read-only. Type a quantity, Enter (or
 *  leaving the field) makes it a token; uncontrolled, so the typed text is cleared by hand. */
export function BatchField({ batches, onChange }: { batches: number[]; onChange?: (batches: number[]) => void }) {
  const i18n = useUiI18n();
  const label = i18n.getText("UI_BATCHES");
  return (
    <FormItem labelContent={<Label required={!!onChange}>{label}</Label>}>
      {onChange ? (
        <MultiInput type="Number" data-param={BATCHES_PARAM} style={{ width: "100%" }}
          placeholder={i18n.getText("UI_BATCHES_PLACEHOLDER")} accessibleName={label}
          valueState={batches.length ? "None" : "Negative"}
          valueStateMessage={<div>{i18n.getText("UI_BATCHES_HINT")}</div>}
          tokens={batches.map((b) => <Token key={b} text={String(b)} />)}
          onChange={(e) => {
            const next = addBatch(batches, e.target.value ?? "");
            if (next !== batches) onChange(next);
            e.target.value = "";
          }}
          onTokenDelete={(e) => {
            const gone = new Set(e.detail.tokens.map((tk) => Number((tk as HTMLElement).getAttribute("text"))));
            const left = batches.filter((b) => !gone.has(b));
            // Deleting the last quantity falls back to 1 rather than leaving nothing to price.
            onChange(left.length ? left : [1]);
          }} />
      ) : <Text>{batches.join(", ")}</Text>}
    </FormItem>
  );
}

/** ✦ (the AI colour, SAP blue) or 💬, pressable: its tip is the source (XAI level 1), a press opens
 *  the quote (level 2) or the question. */
function MarkIcon({ mark, label, onPress }: { mark: FieldMark; label: string; onPress: (el: HTMLElement) => void }) {
  const tip = mark.kind === "assistant" ? mark.tip : label;
  return (
    <Icon name={mark.kind === "assistant" ? "ai" : "discussion"} mode="Interactive" accessibleName={tip} title={tip}
      style={{ flex: "none", color: mark.kind === "assistant" ? "var(--sapBrandColor)" : "var(--sapContent_IconColor)" }}
      onClick={(e) => onPress(e.currentTarget as HTMLElement)} />
  );
}
