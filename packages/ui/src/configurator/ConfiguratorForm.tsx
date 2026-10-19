import { useMemo } from "react";
import {
  CheckBox, Form, FormGroup, FormItem, Icon, Input, Label, MultiComboBox, MultiComboBoxItem,
  ObjectStatus, Option, Panel, RadioButton, SegmentedButton, SegmentedButtonItem, Select, StepInput, Text, Title,
} from "@ui5/webcomponents-react";
import {
  displayColumns, domainOf, isTableGroup, paramPrices, placedTables, refKeyCols,
  type DomainOption, type Entries, type Group, type LookupRef, type ModelDef, type Propagation, type ResolvedLookups, type ResolvedTable, type TableDef, type TableRows, type Val,
} from "@confire/config-engine";
import { CflField } from "../cfl/CflField.tsx";
import { cfl, type QueryScope } from "../cfl/cfl-configs.ts";
import { TABLE_ITEM } from "../list-report/Grid.tsx";
import { ConfigTable } from "./ConfigTable.tsx";
import { displayValue, rowTable, setEntry } from "./formHelpers.ts";
import { money, type ItemMoney } from "../money.ts";
import { useUiSource } from "../source.tsx";

/** The ref's display columns for one option value, joined — shown next to the option. */
function extraOf(ref: LookupRef, t: ResolvedTable | undefined, val: Val): string | undefined {
  if (!t) return undefined;
  const vi = t.columns.indexOf(refKeyCols(ref, t.columns).valueCol);
  const row = vi < 0 ? undefined : t.rows.find((r) => r[vi] === val);
  if (!row) return undefined;
  const s = displayColumns(ref, t.columns).map((c) => String(row[t.columns.indexOf(c)] ?? "")).filter(Boolean).join(" · ");
  return s || undefined;
}

// The one form both the builder preview and the configuration page render. Fully controlled:
// entries in, entries out; all engine work happens in propagate(). Scrolling, footers and
// consistency stay with the caller.

/** The signature answer to "is this consistent and how big is it?" — one component so the
 *  string stays identical in the page footer and the preview. */
export function ConsistencyStatus({ prop }: { prop: Propagation }) {
  const conflict = prop.conflicts.length ? prop.conflicts.map((c) => c.message).join(" · ") : null;
  return (
    <ObjectStatus state={conflict ? "Negative" : "Positive"}>
      {conflict ?? `✓ Consistent · ${prop.open.length} open`}
    </ObjectStatus>
  );
}

/** Key of the synthetic section that catches tables the author never placed. */
export const UNPLACED_TABLES_SECTION = "__tables";

/** The sections the form renders: the model's own, plus a trailing one holding any table the
 *  author forgot to place. A table nobody can reach is a table whose sums are permanently zero —
 *  and for an items table it would be the quotation's lines going missing. */
function formSections(model: ModelDef): { key: string; title: string; icon?: string; tables: string[] }[] {
  const placed = new Set(placedTables(model));
  const orphans = (model.tables ?? []).filter((t) => !placed.has(t.key));
  // A placed table renders inside its group, in the group's own order, so a section's own list
  // only ever holds orphans.
  const own = model.structure.sections.map((s) => ({ key: s.key, title: s.title, icon: s.icon, tables: [] as string[] }));
  if (!orphans.length) return own;
  const title = orphans.length === 1 ? orphans[0]!.title : "Tables";
  return [...own, { key: UNPLACED_TABLES_SECTION, title, tables: orphans.map((t) => t.key) }];
}

// labelSpan 12 everywhere = labels on top of their fields (natively left-aligned), field takes the full column.
const FORM_PROPS = { labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2" } as const;

// A table group holds exactly one FormItem, and it must not be one column wide: the group spans
// the whole Form (colSpan mirrors FORM_PROPS.layout) and the item breaks out of the column flow
// (TABLE_ITEM). ConfigTable's Grid toolbar names the table, with its row count, and carries Add/Delete.

export function ConfiguratorForm({ model, lookups, lk, prop, entries, onChange, onQueryPick, disabled, readOnly, querySource, tables, onTablesChange, batches, itemMoney, itemBatch, onItemBatchChange, badges, evaluated }: {
  model: ModelDef;
  /** Canonical first-page snapshot — seeds query value help. */
  lookups: ResolvedLookups;
  /** Canonical tables plus the current off-page row per query param. */
  lk: ResolvedLookups;
  prop: Propagation;
  entries: Entries;
  onChange: (next: Entries) => void;
  onQueryPick: (paramKey: string, table: string, selected: ResolvedTable | undefined) => void;
  disabled?: boolean;
  /** Locked (a quoted configuration). Form goes accessibleMode="Display" and fields render as
   *  Text — the UI5 display-form pattern. Not `disabled`: a pending save still shows inputs. */
  readOnly?: boolean;
  /** where a query field fetches its pages — nothing is fetched until the user opens or types */
  querySource: QueryScope;
  /** per-project row data for the model's tables, by table key */
  tables?: TableRows;
  /** omit to render the tables read-only (builder preview) */
  onTablesChange?: (next: TableRows) => void;
  /** batch quantities, for the items grid's batch picker */
  batches?: number[];
  /** derived cost/price per items row; omit and the grid shows no money columns at all — which is
   *  how the builder preview stays free of cost data */
  itemMoney?: ItemMoney | null;
  /** the batch quantity `itemMoney` is priced at; omit onItemBatchChange and there is no picker */
  itemBatch?: number;
  onItemBatchChange?: (qty: number) => void;
  /** Per-parameter price badges the server evaluated (the portal, spec §7.1): replaces the local
   *  paramPrices, so no priceExpr has to reach the browser. Omit to compute them here. */
  badges?: Record<string, number>;
  /** Table rows the server evaluated, by table key (the portal): replaces ConfigTable's local
   *  evalTableRows — the browser holds no formula to evaluate — and makes formula cells read-only. */
  evaluated?: Record<string, Record<string, Val>[]>;
}) {
  const currency = useUiSource().useCurrency();
  // Same source the rail's Costs card reads, so a badge and the card can never disagree.
  const priceOf = useMemo(
    () => new Map(badges ? Object.entries(badges) : paramPrices(model, prop, lk.tables).map((c) => [c.key, c.amount])),
    [badges, model, prop, lk],
  );
  const formMode = {
    accessibleMode: readOnly ? "Display" : "Edit",
    itemSpacing: readOnly ? "Large" : "Normal",
  } as const;
  // Every rule a parameter is part of and currently breaks — the same conflicts the page's message
  // list shows, so the field and the list cannot disagree. A rule over two fields marks both: either
  // side can be the one the user changes to fix it.
  const broken = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const c of prop.conflicts) for (const k of c.params) (m[k] ??= []).push(c.message);
    return m;
  }, [prop.conflicts]);

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
    if (readOnly || p.readonly) return <Text>{displayValue(v, dom)}</Text>;

    // Fiori: a mandatory field carries the asterisk on its label *and* a negative state while it is
    // empty — the asterisk alone says it will be asked for, not that it still is. `v` is the
    // propagated value, so a field an auto-default filled already counts as answered.
    // Radio and checkbox get the asterisk only: a checkbox is never empty (false is an answer), and
    // painting every radio in a group negative would read as "these options are wrong".
    // prop.required, not p.mandatory: it also holds requiredWhen — what missingInputs gates on.
    const req = !!prop.required[key];
    // A broken rule outranks an empty mandatory field: it is wrong now, not merely unfinished.
    const rule = broken[key];
    const ruleState = rule ? "Negative" : "None";
    const ruleMessage = rule ? <div>{rule.join(" · ")}</div> : undefined;
    const reqProps = {
      required: req,
      valueState: rule || (req && (v === undefined || v === null || v === "")) ? "Negative" : "None",
      // UI5's default message is "Invalid entry", which is the wrong complaint: nothing was
      // entered. Name the field instead — the popup can sit over a field scrolled away from its label.
      valueStateMessage: ruleMessage ?? <div>{`${p.label || p.key} has to be answered before this configuration can be quoted.`}</div>,
    } as const;

    if (p.ui === "radio")
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem 1rem" }}>
          {dom.map((o, i) => (
            // Only the picked one goes red: it is the value that breaks the rule, not the group.
            <RadioButton key={i} name={`cfg-${key}`} text={o.label} checked={v === o.value}
              valueState={v === o.value ? ruleState : "None"}
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
        <CheckBox checked={v === true} disabled={disabled || !!blocked} valueState={ruleState}
          // tooltip is a runtime ui5 prop the React typing omits.
          {...(blocked ? ({ tooltip: `Unavailable: ${blocked}` } as Record<string, unknown>) : {})}
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
          {dom.filter((o) => !o.eliminatedBy).map((o, i) => (
            <MultiComboBoxItem key={i} text={String(o.value)} selected={Array.isArray(v) && v.includes(String(o.value))} />
          ))}
        </MultiComboBox>
      );

    if (p.ui === "step") {
      const r = p.domain?.kind === "range" ? p.domain : undefined;
      return (
        <StepInput value={typeof v === "number" ? v : undefined} min={r?.min} max={r?.max} step={r?.step ?? 1}
          style={{ width: "100%" }} disabled={disabled} required={req}
          valueState={ruleState} valueStateMessage={ruleMessage}
          onChange={(e) => set(key, e.target.value ?? undefined)} />
      );
    }

    if (p.domain?.kind === "options" && p.domain.ref.source === "query") {
      const ref: LookupRef = p.domain.ref;
      const canonical = lookups.tables[ref.table];
      // Label mode: the option's label shows, its key is the entry. The picked row is bound
      // locally (onQueryPick) so its `<param>_<column>` values are there before the recalculate.
      return (
        <CflField config={{ dialogConfig: cfl.masterdataQuery(querySource, ref, canonical, { title: p.label }) }}
          value={v ?? null} disabled={disabled} required={req} accessibleName={p.label}
          error={rule?.join(" · ")}
          onValueChange={(nv) => set(key, nv === null || nv === "" ? undefined : (nv as Val))}
          onRowSelect={(row) => onQueryPick(key, ref.table, rowTable(row, canonical))} />
      );
    }

    if (dom.length) { // select (and boolean-with-select)
      const tref = p.domain?.kind === "options" && p.domain.ref.source === "table" ? p.domain.ref : undefined;
      const tbl = tref ? lk.tables[tref.table] : undefined;
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
        style={{ width: "100%" }} disabled={disabled} {...reqProps}
        onChange={(e) => {
          const raw = e.target.value ?? "";
          set(key, raw === "" ? undefined : p.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  // One Panel per model section, each holding one headerless Form. The Panel is the container — the
  // section's one title, and collapsible; the Form only lays out label/field pairs, and supports
  // exactly one level of grouping (Form > FormGroup), so section→Panel+Form / group→FormGroup keeps
  // both titles. A section's only group drops its own header, which would just repeat the Panel's.
  //
  // A section's groups are of two kinds: a table group renders as one full-width, headerless
  // FormGroup — the Grid's toolbar titles it from its TableDef (so a rename in TableDialog cannot
  // leave a stale heading), and a group header would only say it twice — a field group as the
  // ordinary label-and-field group.
  const byKey = new Map(model.structure.sections.map((s) => [s.key, s]));
  const defOf = (k: string) => (model.tables ?? []).find((t) => t.key === k);
  const shown = formSections(model);
  const tableRows = tables ?? {};
  const setRows = (key: string, rows: Record<string, Val>[]) =>
    onTablesChange?.({ ...tableRows, [key]: rows });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {shown.map((sec, si) => {
      // The catch-all section owns no structure: its orphans become table groups here, so they go
      // through the very same Form/FormGroup path a placed table does.
      // A group left behind by a deleted table is dropped (placedTables() already does), so it is
      // neither an empty titleless FormGroup nor counted as a second group.
      const groups: Group[] = (byKey.get(sec.key)?.groups ?? sec.tables.map((table) => ({ table })))
        .filter((g) => !isTableGroup(g) || defOf(g.table));
      const head = (t: string) => (groups.length === 1 ? undefined : t);
      // The items grid prices one batch quantity at a time (one cost and one price column), so the
      // section holding it says which, and lets the user switch. One quantity has nothing to pick.
      const bs = batches ?? [];
      const batchPick = onItemBatchChange && bs.length > 1
        && groups.some((g) => isTableGroup(g) && defOf(g.table)?.role === "items") ? (
          <SegmentedButton accessibleName="Batch quantity the items are priced at" itemsFitContent
            style={{ marginInlineStart: "auto" }}
            onSelectionChange={(e) => {
              const q = Number((e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.qty);
              if (q) onItemBatchChange(q);
            }}>
            {bs.map((b) => (
              <SegmentedButtonItem key={b} data-qty={b} selected={b === itemBatch}>{`Qty ${b}`}</SegmentedButtonItem>
            ))}
          </SegmentedButton>
        ) : null;
      return (
        // Unnamed on purpose: a Panel takes its aria-label from accessibleName only, and an unnamed
        // region is no landmark — the Form below is the named region, its groups the form roles.
        // A custom header is not clickable (only its arrow toggles), which lets the batch picker live in it.
        <Panel key={`${sec.key}:${si}`} accessibleRole="Region" headerText={sec.title} headerLevel="H5"
          header={sec.icon || batchPick ? (
            // flex: 1 — the header slot sits in a flex row, and the picker needs the room to sit right.
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flex: 1 }}>
              {sec.icon ? <Icon name={sec.icon} /> : null}
              <Title level="H5">{sec.title}</Title>
              {batchPick}
            </div>
          ) : undefined}>
        <Form accessibleName={sec.title} {...FORM_PROPS} {...formMode}>
          {groups.map((g, gi) => {
          if (isTableGroup(g)) {
            const def = defOf(g.table)!;
            return (
              <FormGroup key={`${g.table}:${gi}`} colSpan={FORM_PROPS.layout}>
                {/* data-param: table keys share the parameters' namespace, so a missing-row message
                    scrolls here the same way a parameter's does. */}
                <FormItem className={TABLE_ITEM} data-param={g.table}>
                  <ConfigTable def={def} rows={tableRows[g.table] ?? []}
                    scopeVars={prop.values} lookups={lk} querySource={querySource}
                    disabled={disabled || !onTablesChange} readOnly={readOnly}
                    money={def.role === "items" ? itemMoney : undefined}
                    evaluated={evaluated?.[g.table] ?? (evaluated ? [] : undefined)}
                    onQueryPick={onQueryPick} onChange={(rows) => setRows(g.table, rows)} />
                </FormItem>
              </FormGroup>
            );
          }
          const content = g.params.filter((k) => prop.visible[k]);
          return (
            <FormGroup key={`${g.key}:${gi}`} headerText={head(g.title)}>
              {content.map((k) => {
                const p = model.parameters.find((x) => x.key === k);
                if (!p) return null;
                const dom: DomainOption[] = prop.domains[k] ?? domainOf(model, lookups, k);
                const eliminated = dom.filter((o) => o.eliminatedBy).length;
                // MultiComboBox filters eliminated options out (no per-item disabled in UI5 v2), so
                // unlike Select/Radio it can't show them greyed — explain the gap with a count instead.
                const showEliminatedNote = !readOnly && !p.readonly && p.ui === "multicombo" && eliminated > 0;
                // RadioButton and CheckBox take a valueState but have no valueStateMessage slot, so
                // the broken rule's message is spelled out under them instead.
                const ruleNote = !readOnly && !p.readonly && broken[k]
                  && (p.ui === "radio" || p.ui === "checkbox" || (p.type === "boolean" && p.ui !== "select"));
                return (
                  <FormItem key={k} labelContent={
                    // labelSpan is 12, so the label owns a full-width row above its control — its
                    // right end IS the input's top-right corner, which is where the price belongs.
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", width: "100%" }}>
                      <Label required={!!prop.required[k] && !readOnly && !p.readonly}>
                        {p.label + (p.unit ? ` (${p.unit})` : "")}
                        {p.help ? <Icon name="message-information" accessibleName={p.help} title={p.help}
                          style={{ marginInlineStart: "0.375rem", cursor: "help", color: "var(--sapContent_IconColor)" }} /> : null}
                      </Label>
                      {priceOf.has(k) ? (
                        <ObjectStatus style={{ marginInlineStart: "auto" }}>
                          {money(priceOf.get(k)!, currency)}
                        </ObjectStatus>
                      ) : null}
                    </div>
                  }>
                    {/* data-param is what a conflict message in the page's popover scrolls to —
                        the controls themselves vary too much to each carry an id. */}
                    <div data-param={k} style={{ display: "flex", flexDirection: "column", gap: "0.125rem", width: "100%" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" }}>
                        {control(k)}
                        {prop.defaulted.has(k) ? <ObjectStatus state="Information">auto</ObjectStatus> : null}
                      </div>
                      {showEliminatedNote ? (
                        <Text style={{ fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" }}>
                          {eliminated} option{eliminated === 1 ? "" : "s"} unavailable due to rules
                        </Text>
                      ) : null}
                      {ruleNote ? broken[k]!.map((m, i) => (
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
        </Panel>
      );
      })}
    </div>
  );
}
