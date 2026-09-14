import { useMemo, useRef } from "react";
import {
  Button, CheckBox, Form, FormGroup, FormItem, Icon, Input, Label, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, RadioButton, Select, StepInput, Text, Title, Token, Tokenizer,
  type StepInputDomRef,
} from "@ui5/webcomponents-react";
import {
  displayColumns, domainOf, placedTables, refKeyCols,
  type DomainOption, type Entries, type LookupRef, type ModelDef, type Propagation, type ResolvedLookups, type ResolvedTable, type TableRows, type Val,
} from "@hera/config-engine";
import { QueryValueHelp, type QuerySource } from "../ValueHelp.tsx";
import { ConfigTable } from "./ConfigTable.tsx";
import { setEntry } from "./formHelpers.ts";
import { addBatch } from "./configProcessState.ts";
import { money, paramPrices } from "./costElements.ts";

/** The ref's display columns for one option value, joined — shown next to the option. */
function extraOf(ref: LookupRef, t: ResolvedTable | undefined, val: Val): string | undefined {
  if (!t) return undefined;
  const vi = t.columns.indexOf(refKeyCols(ref, t.columns).valueCol);
  const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === val);
  if (!row) return undefined;
  const s = displayColumns(ref, t.columns).map((c) => String(row[t.columns.indexOf(c)] ?? "")).filter(Boolean).join(" · ");
  return s || undefined;
}

// The one form both the builder preview and the wizard render. Fully controlled:
// entries in, entries out; all engine work happens in propagate(). Batch quantities are a field in
// here too (BATCHES_SECTION) rather than a component of their own, so the internal ObjectPage and
// the portal wizard cannot drift apart; scrolling, footers and consistency stay with the caller.

/** The signature answer to "is this consistent and how big is it?" — one component so the
 *  string stays identical in the wizard bar, the preview footer and the portal step. */
export function ConsistencyStatus({ prop }: { prop: Propagation }) {
  const conflict = prop.conflicts.length ? prop.conflicts.map((c) => c.message).join(" · ") : null;
  return (
    <ObjectStatus state={conflict ? "Negative" : "Positive"}>
      {conflict ?? `✓ Consistent · ${prop.open.length} open · ~${prop.candidateEstimate} candidate${prop.candidateEstimate === 1 ? "" : "s"}`}
    </ObjectStatus>
  );
}

/** Key of the synthetic section that catches tables the author never placed. */
export const UNPLACED_TABLES_SECTION = "__tables";

/** Key of the synthetic section holding batch quantities. Not in formSections(): it is not part of
 *  the model, so a caller asks for it by name (the ObjectPage subsection, the portal wizard step)
 *  and nothing renders it by accident. */
export const BATCHES_SECTION = "__batches";

/** The sections the form renders: the model's own, plus a trailing one holding any table the
 *  author forgot to place. A table nobody can reach is a table whose sums are permanently zero —
 *  and for an items table it would be the quotation's lines going missing. ConfigProcessPage
 *  renders one section at a time, so it needs the same list this does. */
export function formSections(model: ModelDef): { key: string; title: string; tables: string[] }[] {
  const placed = new Set(placedTables(model));
  const orphans = (model.tables ?? []).filter((t) => !placed.has(t.key));
  // A placed table renders inside its group, in the group's own order, so a section's own list
  // only ever holds orphans.
  const own = model.structure.sections.map((s) => ({ key: s.key, title: s.title, tables: [] as string[] }));
  if (!orphans.length) return own;
  const title = orphans.length === 1 ? orphans[0]!.title : "Tables";
  return [...own, { key: UNPLACED_TABLES_SECTION, title, tables: orphans.map((t) => t.key) }];
}

// labelSpan 12 everywhere = labels on top of their fields (natively left-aligned), field takes the full column.
const FORM_PROPS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;

// A table is a FormItem like any other field, so it sorts among them — but it must not be one
// column wide. Form.css lays a group's items with `column-count: <the group's colSpan>`, so a
// group holding a table spans the whole Form (colSpan mirrors FORM_PROPS.layout) and the table
// item breaks out of that column flow with the native `column-span: all`. Its label part is
// hidden: ConfigTable draws its own title and Add-row toolbar.
if (typeof document !== "undefined" && !document.getElementById("hera-table-item")) {
  const el = document.createElement("style");
  el.id = "hera-table-item";
  el.textContent = `.hera-table-item{column-span:all}.hera-table-item::part(label){display:none}`;
  document.head.appendChild(el);
}

export function ConfiguratorForm({ model, lookups, lk, prop, entries, onChange, onQueryPick, section, disabled, readOnly, querySource, tables, onTablesChange, batches, onBatchesChange }: {
  model: ModelDef;
  /** Canonical first-page snapshot — seeds query value help. */
  lookups: ResolvedLookups;
  /** Canonical tables plus the current off-page row per query param. */
  lk: ResolvedLookups;
  prop: Propagation;
  entries: Entries;
  onChange: (next: Entries) => void;
  onQueryPick: (paramKey: string, table: string, selected: ResolvedTable | undefined) => void;
  /** render only this section, without its own Form header — the caller shows the title (e.g. an ObjectPageSection) */
  section?: string;
  disabled?: boolean;
  /** Locked (a quoted configuration), which is NOT `disabled`: accessibleMode="Display" only
   *  changes the markup and ARIA the Form emits, it never blocks input. Fields go `readonly` so
   *  the values stay legible, focusable and copyable — the whole point of a quoted config. */
  readOnly?: boolean;
  /** where a query field fetches its pages — nothing is fetched until the user opens or types */
  querySource: QuerySource;
  /** per-project row data for the model's tables, by table key */
  tables?: TableRows;
  /** omit to render the tables read-only (builder preview) */
  onTablesChange?: (next: TableRows) => void;
  /** batch quantities, rendered only for section === BATCHES_SECTION */
  batches?: number[];
  /** omit to leave batch quantities out entirely (builder preview, portal Configure step) */
  onBatchesChange?: (next: number[]) => void;
}) {
  // Same source the rail's Costs card reads, so a badge and the card can never disagree.
  const priceOf = useMemo(
    () => new Map(paramPrices(model, prop, lk.tables).map((c) => [c.key, c.amount])),
    [model, prop, lk],
  );
  // The quantity being dialled in. StepInput owns its own value (it formats and clamps it), so
  // this is a ref, not state: nothing here re-renders when the number changes.
  const qty = useRef<StepInputDomRef>(null);

  // Batch quantities are a field, not a component: a StepInput for the number (numeric by
  // contract — spinner, min, keyboard up/down, no text to parse) and a Tokenizer for the ones
  // already added. Adding is an explicit action rather than StepInput's `change`, because change
  // also fires on every +/- click (`_modifyValue(step, true)`) — committing there would token
  // every step of the way up to 10.
  if (section === BATCHES_SECTION) {
    if (!onBatchesChange) return null;
    const bs = batches ?? [];
    // StepInput settles `value` on Enter (its own keydown handler), on blur and on each spin —
    // all of which run before our keydown listener and before the Add button's click (focusout
    // precedes click) — so the ref holds the committed number by the time we read it.
    const add = () => onBatchesChange(addBatch(bs, String(qty.current?.value ?? "")));
    return (
      <Form {...FORM_PROPS} accessibleMode={disabled || readOnly ? "Display" : "Edit"}>
        <FormGroup>
          <FormItem labelContent={<Label required>Batch quantities</Label>}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                {/* value is set once on mount (React only writes a prop that changed), so the field
                    keeps whatever the user last dialled in and they can spin on from it. */}
                <StepInput ref={qty} value={1} min={1} step={1} required disabled={disabled} readonly={readOnly}
                  accessibleName="Batch quantity" style={{ flex: "1 1 auto" }}
                  onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
                <Button icon="add" design="Transparent" disabled={disabled || readOnly}
                  accessibleName="Add quantity" tooltip="Add quantity" onClick={add} />
              </div>
              {bs.length ? (
                // multiLine: a quote can carry a dozen batch sizes and an n-more indicator would
                // hide the very list the user is checking. showClearAll needs it too.
                <Tokenizer multiLine showClearAll disabled={disabled} readonly={readOnly} accessibleName="Batch quantities"
                  onTokenDelete={(e) => {
                    const gone = new Set(e.detail.tokens.map((t) => Number((t as HTMLElement).getAttribute("text"))));
                    onBatchesChange(bs.filter((b) => !gone.has(b)));
                  }}>
                  {bs.map((b) => <Token key={b} text={String(b)} />)}
                </Tokenizer>
              ) : (
                // Fiori: a required field with nothing in it carries the negative state, not just
                // the asterisk. StepInput can't: it writes its own valueState in _updateValueState.
                <ObjectStatus state="Negative">Add at least one quantity</ObjectStatus>
              )}
            </div>
          </FormItem>
        </FormGroup>
      </Form>
    );
  }

  const set = (key: string, v: Val | undefined) => {
    if (v === undefined) {
      const ref = model.parameters.find((x) => x.key === key)?.domain;
      if (ref?.kind === "options" && ref.ref.source === "query") onQueryPick(key, ref.ref.table, undefined);
    }
    const next = setEntry(entries, key, v);
    if (next === entries) return;
    onChange(next);
  };

  const control = (key: string) => {
    const p = model.parameters.find((x) => x.key === key)!;
    const dom: DomainOption[] = prop.domains[key] ?? domainOf(model, lookups, key);
    const v = prop.values[key];
    // readonly, not disabled: a read-only field stays focusable, copyable and screen-reader
    // announced — and these fields exist precisely to be read. A locked form (a quoted
    // configuration) wants exactly that treatment for every param, not just the authored ones.
    const ro = !!p.readonly || !!readOnly;

    const ref = p.domain?.kind === "options" ? p.domain.ref : undefined;

    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {dom.map((o, i) => (
            <RadioButton key={i} name={`cfg-${key}`} text={o.label} checked={v === o.value} readonly={ro}
              disabled={disabled || !!o.eliminatedBy}
              // tooltip is a runtime ui5 prop the React typing omits (like Option's disabled).
              {...(o.eliminatedBy ? ({ tooltip: `Unavailable: ${o.eliminatedBy}` } as Record<string, unknown>) : {})}
              onChange={() => set(key, o.value)} />
          ))}
        </div>
      );

    if (p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select")) {
      // a checkbox can only be toggled if flipping it isn't eliminated — that reason is also the tooltip.
      const blocked = dom.find((o) => o.value === (v !== true))?.eliminatedBy;
      return (
        <CheckBox checked={v === true} readonly={ro} disabled={disabled || !!blocked}
          // tooltip is a runtime ui5 prop the React typing omits.
          {...(blocked ? ({ tooltip: `Unavailable: ${blocked}` } as Record<string, unknown>) : {})}
          onChange={(e) => set(key, e.target.checked)} />
      );
    }

    if (p.ui === "multicombo")
      return (
        // MultiComboBoxItem has no disabled prop -> eliminated options are filtered out.
        <MultiComboBox style={{ width: "100%" }} disabled={disabled} readonly={ro}
          onSelectionChange={(e) => {
            const texts = e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!);
            set(key, texts.length ? texts : undefined);
          }}>
          {dom.filter((o) => !o.eliminatedBy).map((o, i) => (
            <MultiComboBoxItem key={i} text={String(o.value)} selected={Array.isArray(v) && v.includes(String(o.value))} />
          ))}
        </MultiComboBox>
      );

    if (p.ui === "step") {
      const r = p.domain?.kind === "range" ? p.domain : undefined;
      return (
        <StepInput value={typeof v === "number" ? v : undefined} min={r?.min} max={r?.max} step={r?.step ?? 1}
          style={{ width: "100%" }} disabled={disabled} readonly={ro}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (p.domain?.kind === "options" && p.domain.ref.source === "query") {
      const ref: LookupRef = p.domain.ref;
      return (
        <QueryValueHelp source={querySource} canonicalTable={lookups.tables[ref.table]} lookupRef={ref}
          value={v} onChange={(nv) => set(key, nv)} headerText={p.label}
          disabled={disabled} readonly={ro}
          onPick={(t) => onQueryPick(key, ref.table, t)} />
      );
    }

    if (dom.length) { // select (and boolean-with-select)
      const tref = p.domain?.kind === "options" && p.domain.ref.source === "table" ? p.domain.ref : undefined;
      const tbl = tref ? lk.tables[tref.table] : undefined;
      return (
        <Select value={v === undefined ? "" : JSON.stringify(v)} style={{ width: "100%" }} disabled={disabled} readonly={ro}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(key, j === undefined || j === "" ? undefined : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {dom.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}
              tooltip={o.eliminatedBy ? `Unavailable: ${o.eliminatedBy}` : undefined}
              additionalText={o.eliminatedBy ? "unavailable" : tref ? extraOf(tref, tbl, o.value) : undefined}
              // Option supports disabled at runtime (ListItemBase); the React typing omits it.
              {...(o.eliminatedBy ? ({ disabled: true } as Record<string, unknown>) : {})}>
              {o.label}
            </Option>
          ))}
        </Select>
      );
    }

    return (
      <Input type={p.type === "number" ? "Number" : "Text"} value={v === undefined || v === null ? "" : String(v)}
        style={{ width: "100%" }} disabled={disabled} readonly={ro}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  // One Form per model section. UI5's Form is the layout container and supports exactly one level
  // of grouping (Form > FormGroup), so section→Form / group→FormGroup is the only mapping that keeps
  // both titles; a single Form for everything would flatten sections away. In the ObjectPage each
  // section already gets its own ObjectPageSubSection (which supplies the title and the anchor), so
  // headerText is only needed when we stack the whole model ourselves (builder preview, portal wizard).
  //
  // A group's content is one ordered list of parameter keys and table keys, so a table renders
  // where the author put it, between the fields. See the style block above for the width.
  const byKey = new Map(model.structure.sections.map((s) => [s.key, s]));
  const defOf = (k: string) => (model.tables ?? []).find((t) => t.key === k);
  const shown = formSections(model).filter((s) => !section || s.key === section);
  const tableRows = tables ?? {};
  const setRows = (key: string, rows: Record<string, Val>[]) =>
    onTablesChange?.({ ...tableRows, [key]: rows });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {shown.map((sec, si) => {
      const s = byKey.get(sec.key);
      return (
        <div key={`${sec.key}:${si}`} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {s ? (
        <Form headerText={section ? undefined : sec.title} {...FORM_PROPS}
          accessibleMode={disabled || readOnly ? "Display" : "Edit"}>
          {s.groups.map((g, gi) => {
          const content = g.params.filter((k) => defOf(k) || prop.visible[k]);
          return (
            <FormGroup key={`${g.key}:${gi}`} headerText={g.title}
              colSpan={content.some((k) => defOf(k)) ? FORM_PROPS.layout : undefined}>
              {content.map((k) => {
                const def = defOf(k);
                if (def)
                  return (
                    <FormItem key={k} className="hera-table-item">
                      <ConfigTable def={def} rows={tableRows[k] ?? []} scopeVars={prop.values}
                        lookups={lk} querySource={querySource} disabled={disabled || !onTablesChange} readOnly={readOnly}
                        onChange={(rows) => setRows(k, rows)} />
                    </FormItem>
                  );
                const p = model.parameters.find((x) => x.key === k);
                if (!p) return null;
                const dom: DomainOption[] = prop.domains[k] ?? domainOf(model, lookups, k);
                const eliminated = dom.filter((o) => o.eliminatedBy).length;
                // MultiComboBox filters eliminated options out (no per-item disabled in UI5 v2), so
                // unlike Select/Radio it can't show them greyed — explain the gap with a count instead.
                const showEliminatedNote = p.ui === "multicombo" && eliminated > 0;
                return (
                  <FormItem key={k} labelContent={
                    // labelSpan is 12, so the label owns a full-width row above its control — its
                    // right end IS the input's top-right corner, which is where the price belongs.
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", width: "100%" }}>
                      <Label>
                        {p.label + (p.unit ? ` (${p.unit})` : "")}
                        {p.help ? <Icon name="message-information" accessibleName={p.help} title={p.help}
                          style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_IconColor)" }} /> : null}
                      </Label>
                      {priceOf.has(k) ? (
                        <ObjectStatus style={{ marginInlineStart: "auto" }}>
                          {money(priceOf.get(k)!, model.pricing.currency)}
                        </ObjectStatus>
                      ) : null}
                    </div>
                  }>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", width: "100%" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                        {control(k)}
                        {prop.defaulted.has(k) ? <ObjectStatus state="Information">auto</ObjectStatus> : null}
                      </div>
                      {showEliminatedNote ? (
                        <Text style={{ fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" }}>
                          {eliminated} option{eliminated === 1 ? "" : "s"} unavailable due to rules
                        </Text>
                      ) : null}
                    </div>
                  </FormItem>
                );
              })}
            </FormGroup>
          );
          })}
        </Form>
        ) : section ? null : <Title level="H5">{sec.title}</Title>}
        {sec.tables.map((tk) => {
          const def = defOf(tk);
          if (!def) return null;
          return (
            <ConfigTable key={tk} def={def} rows={tableRows[tk] ?? []} scopeVars={prop.values}
              lookups={lk} querySource={querySource} disabled={disabled || !onTablesChange} readOnly={readOnly}
              onChange={(rows) => setRows(tk, rows)} />
          );
        })}
        </div>
      );
      })}
    </div>
  );
}
