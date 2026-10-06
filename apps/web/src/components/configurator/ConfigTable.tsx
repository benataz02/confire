import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button, CheckBox, Input, Option, Select, Text } from "@ui5/webcomponents-react";
import {
  columnOptions, evalTableRows, COST_COL, PRICE_COL, typedPrice,
  type ResolvedLookups, type ResolvedTable, type TableColumn, type TableDef, type Val,
} from "@confire/config-engine";
import { CflField } from "../../shared/cfl/CflField.tsx";
import { cfl, type QueryScope } from "../../shared/cfl/cfl-configs.ts";
import { Grid, type CellTemplate, type GridState } from "../../shared/list-report/Grid.tsx";
import type { ListColumn } from "../../shared/types.ts";
import { displayValue, rowTable } from "./formHelpers.ts";
import { addRow, pasteRows, removeRows, setCell, type Row } from "./configTableOps.ts";
import { money as fmtMoney } from "../../lib/money.ts";
import { useCurrency } from "../../orpc.ts";
import { qtyLabel, type ItemMoney } from "./itemMoney.ts";

/** The stored row's position, carried on the grid row: Grid hands back row objects (a cell, the
 *  selection), and both have to name the stored row they mean. Not an identifier, so no column
 *  key can collide with it. */
const IDX = "#i";

/** An editor owns its keys. AnalyticalTable's keyboard navigation takes Arrow/Home/End off any
 *  focused cell — caret moves and the value help's type-ahead included — and Enter selects the
 *  row. Grid has no useF2CellEdit (the hook that turns that off while editing), so a cell stops
 *  them before they reach the table. */
const ownKeys = (e: KeyboardEvent) => e.stopPropagation();

/** Formula results are raw floats; trim the noise without pretending to a currency. */
const show = (v: Val): string =>
  v === null || v === undefined ? "—" : typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);

const header = (c: TableColumn) => c.label + (c.unit ? ` (${c.unit})` : "");

/**
 * The one table component for both roles. An `items` table becomes n quotation lines; a `calc`
 * table only feeds sums into the model's formulas — the difference is entirely in what the server
 * does with the rows, so the editing surface is identical.
 *
 * Controlled, like ConfiguratorForm: rows in, rows out, every computed cell re-derived here rather
 * than stored. The cell controls follow ConfiguratorForm.control()'s branch order so a column and a
 * parameter of the same type look and behave the same.
 */
export function ConfigTable({ def, rows, scopeVars, lookups, onChange, onQueryPick, disabled, readOnly, querySource, money }: {
  def: TableDef;
  rows: Row[];
  /** the model's current values — row formulas read these, and row cells shadow them */
  scopeVars: Record<string, Val>;
  lookups: ResolvedLookups;
  onChange: (rows: Row[]) => void;
  /** an off-page query pick, so its `<column>_<source column>` values bind before the next
   *  recalculate. Keyed per cell — two rows of the same column pick independently. */
  onQueryPick?: (key: string, table: string, selected: ResolvedTable | undefined) => void;
  disabled?: boolean;
  /** quoted/locked: cells are Text, add/delete are gone. See ConfiguratorForm. */
  readOnly?: boolean;
  querySource: QueryScope;
  /** Derived cost/price per row for an `items` grid; null = the columns with nothing in them yet.
   *  Absent = no money columns at all, which is how the portal stays free of cost data:
   *  PortalRequestPage simply does not pass it. */
  money?: ItemMoney | null;
}) {
  // Off `me`, not off a prop: the currency is the tenant's, identical for every table on the page,
  // so threading it down from the model was carrying a constant through four components.
  const currency = useCurrency();
  // Same function the server runs, so a computed cell cannot disagree with the quote.
  const evaluated = useMemo(
    () => evalTableRows(def, rows, scopeVars, lookups.tables),
    [def, rows, scopeVars, lookups],
  );
  // An items grid is never capped and never empty: its rows are the quotation's lines.
  const maxRows = def.role === "calc" ? def.maxRows : undefined;
  const atMax = maxRows !== undefined && rows.length >= maxRows;
  const minRows = def.role === "calc" ? (def.minRows ?? 0) : 1;

  // Two runtime columns on an items grid: what the row costs and what it sells for, per unit, so
  // margin is readable without arithmetic. Neither is a declared column — the cost is never stored
  // and the price is stored only once someone types over it. Shown while `money` is null too (as
  // "—"): a column appearing when the first calculation lands would rebuild every Grid cell, and
  // take the focus out of whatever input the salesperson is typing in.
  const showMoney = def.role === "items" && money !== undefined;
  // The quantity the two figures were priced at — see qtyLabel.
  const at = qtyLabel(money?.batchQty);
  const costHeader = `Unit cost${at}`;
  const priceHeader = `Unit price${at}`;
  const moneyText = (n: number | undefined) => (n === undefined ? "—" : fmtMoney(n, currency));

  const priceCell = (ri: number) => {
    // Same contract a formula cell's override follows: the split until someone types, and the
    // clear icon hands it back. typedPrice is the test buildQuoteLines applies, so the cell cannot
    // show a number the quotation will reject.
    const typed = typedPrice(rows[ri]);
    const overridden = typed !== undefined;
    const value = typed ?? money?.rows[ri]?.unitPrice;
    if (readOnly) return <Text>{moneyText(value)}</Text>;
    return (
      <Input style={{ width: "100%" }} type="Number" accessibleName={priceHeader}
        value={value === undefined ? "" : show(value)}
        showClearIcon={overridden} valueState={overridden ? "Information" : "None"}
        valueStateMessage={<div>Typed by hand. Clear the field to go back to the calculated price.</div>}
        disabled={disabled}
        onInput={(e) => {
          const raw = e.target.value ?? "";
          onChange(setCell(rows, ri, PRICE_COL, raw === "" ? null : Number(raw)));
        }} />
    );
  };

  const cell = (ri: number, c: TableColumn) => {
    const stored = rows[ri]?.[c.key];
    const set = (v: Val) => onChange(setCell(rows, ri, c.key, v));
    // A computed column is an override, not a lock: the cell shows what the formula says until
    // someone types over it, and clearing it hands the row back to the formula. Both states live
    // in the same cell, so `stored != null` is the whole "is this one overridden" question —
    // evalTableRows applies the same rule server-side, which is what makes the quote agree.
    const computed = c.cell.kind === "formula";
    const overridden = computed && stored !== undefined && stored !== null;
    const value = computed ? (evaluated[ri]?.[c.key] ?? null) : stored;

    if (readOnly) {
      if (computed) return <Text>{show(value ?? null)}</Text>;
      if (c.type === "boolean")
        return <Text>{displayValue(stored, [{ value: true, label: "Yes" }, { value: false, label: "No" }])}</Text>;
      if (c.cell.kind === "options") {
        // Items grid: the stored code is what rides to SAP; don't swap it for the lookup label.
        const opts = def.role === "items" ? [] : columnOptions(c, lookups);
        return <Text>{displayValue(stored, opts)}</Text>;
      }
      return <Text>{displayValue(stored, [])}</Text>;
    }

    if (c.type === "boolean")
      return (
        // ponytail: a computed boolean has no "clear" — a checkbox cannot hold three states. Ticking
        // one overrides it for good; give it a Select if a model ever needs to un-override.
        <CheckBox checked={value === true} disabled={disabled} accessibleName={header(c)}
          onChange={(e) => set(e.target.checked)} />
      );

    if (c.cell.kind === "options" && c.cell.ref.source === "query") {
      const ref = c.cell.ref;
      const pickKey = `${def.key}.${c.key}.${ri}`;
      const canonical = lookups.tables[ref.table];
      // An items grid shows the code (plain mode): the stored code is what rides to SAP.
      return (
        <CflField
          config={{ dialogConfig: cfl.masterdataQuery(querySource, ref, canonical, { title: header(c), showValue: def.role === "items" }) }}
          value={stored ?? null} disabled={disabled} accessibleName={header(c)}
          onRowSelect={(row) => onQueryPick?.(pickKey, ref.table, rowTable(row, canonical))}
          onValueChange={(nv) => {
            if (nv === undefined || nv === null || nv === "") onQueryPick?.(pickKey, ref.table, undefined);
            set(nv === undefined || nv === "" ? null : (nv as Val));
          }} />
      );
    }

    if (c.cell.kind === "options") {
      const opts = columnOptions(c, lookups);
      return (
        <Select style={{ width: "100%" }} disabled={disabled}
          value={stored === undefined || stored === null ? "" : JSON.stringify(stored)}
          onChange={(e) => {
            const j = (e.detail.selectedOption as HTMLElement).dataset.j;
            set(j === undefined || j === "" ? null : (JSON.parse(j) as Val));
          }}>
          <Option value="" data-j="">—</Option>
          {opts.map((o, i) => (
            <Option key={i} value={JSON.stringify(o.value)} data-j={JSON.stringify(o.value)}>{o.label}</Option>
          ))}
        </Select>
      );
    }

    return (
      <Input style={{ width: "100%" }} type={c.type === "number" ? "Number" : "Text"}
        accessibleName={header(c)}
        value={value === undefined || value === null ? "" : computed ? show(value) : String(value)}
        // The clear icon IS the revert, and the value state is how a hand-typed number is told
        // apart from a calculated one at a glance.
        showClearIcon={overridden} valueState={overridden ? "Information" : "None"}
        valueStateMessage={<div>Overridden by hand. Clear the field to go back to the formula.</div>}
        disabled={disabled}
        onInput={(e) => {
          const raw = e.target.value ?? "";
          set(raw === "" ? null : c.type === "number" ? Number(raw) : raw);
        }} />
    );
  };

  // The declared columns, then the two money ones. Not sortable: row order is the quotation's line
  // order, and Grid's sort is a server's job it would only ask the view to do.
  // ponytail: no widths — AnalyticalTable shares the row evenly (the user can drag a column wider).
  // A width off the cell text would change per keystroke and rebuild every cell; size from the
  // headers if narrow columns become a complaint.
  const columns = useMemo<ListColumn[]>(() => [
    ...def.columns.map((c) => ({ key: c.key, label: header(c), type: c.type, sortable: false })),
    ...(showMoney ? [
      { key: COST_COL, label: costHeader, type: "number" as const, sortable: false },
      { key: PRICE_COL, label: priceHeader, type: "number" as const, sortable: false },
    ] : []),
  ], [def, showMoney, costHeader, priceHeader]);
  const state = useMemo<GridState>(() => ({ columns: columns.map((c) => c.key), sortBy: [], groupBy: [] }), [columns]);
  const data = useMemo(() => rows.map((r, i) => ({ ...r, [IDX]: i })), [rows]);

  // Grid builds one Cell component per column off `cellTemplates`, so a new template is a new
  // component type to React and remounts the input under the cursor. The templates therefore live
  // as long as the column set does and read this render's cells through the ref.
  const render = useRef<(ri: number, key: string) => ReactNode>(null);
  render.current = (ri, key) =>
    key === COST_COL ? <Text>{moneyText(money?.rows[ri]?.unitCost)}</Text>
    : key === PRICE_COL ? priceCell(ri)
    : cell(ri, def.columns.find((c) => c.key === key)!);
  const cellTemplates = useMemo(
    () => Object.fromEntries(columns.map((c): [string, CellTemplate] => [c.key, (row) => (
      <div style={{ width: "100%" }} onKeyDown={ownKeys}>{render.current?.(row[IDX] as number, c.key)}</div>
    )])),
    [columns],
  );

  const editable = !readOnly && !disabled;
  return (
    <div
      onPaste={(e) => {
        const text = e.clipboardData.getData("text");
        // Only a grid becomes new rows; a single value belongs in the cell being pasted into.
        if (!/[\t\n]/.test(text) || disabled || readOnly) return;
        e.preventDefault();
        onChange(pasteRows(rows, def, text, maxRows));
      }}>
      <Grid title={def.title || def.key} columns={columns} state={state} rows={data} fill={false}
        cellTemplates={cellTemplates}
        noDataText="No rows yet. Add one, or paste a block of cells straight from a spreadsheet."
        // Delete works on the selection — the Grid idiom — so a read-only grid has none to make.
        selectionMode={editable ? "Multiple" : "None"}
        toolbarActions={readOnly ? undefined : (sel) => (
          <>
            <Button icon="add" design="Transparent" disabled={disabled || atMax}
              onClick={() => onChange(addRow(rows))}>Add row</Button>
            {/* Copies land at the end, like a new row: positions above stay put, so the selection
                still names the rows it did. Stored cells only — a formula cell nobody typed over
                stays absent and the copy follows the formula too. */}
            <Button icon="copy" design="Transparent"
              disabled={!editable || !sel.rows.length || (maxRows !== undefined && rows.length + sel.rows.length > maxRows)}
              onClick={() => {
                const picked = sel.rows.map((r) => r[IDX] as number).sort((a, b) => a - b);
                onChange([...rows, ...picked.map((i) => ({ ...rows[i] }))]);
              }}>Duplicate</Button>
            <Button icon="delete" design="Transparent"
              disabled={!editable || !sel.rows.length || rows.length - sel.rows.length < minRows}
              onClick={() => {
                const gone = new Set(sel.rows.map((r) => r[IDX] as number));
                // row ids are positions, so a kept selection would land on the rows that moved up
                sel.clear();
                onChange(removeRows(rows, gone));
              }}>Delete</Button>
          </>
        )} />
    </div>
  );
}
