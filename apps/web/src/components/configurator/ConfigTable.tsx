import { useMemo } from "react";
import {
  CheckBox, Input, Option, Select, Table, TableCell, TableHeaderCell,
  TableHeaderRow, TableRow, TableRowAction, Text, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import {
  columnOptions, evalTableRows, PRICE_COL,
  type ResolvedLookups, type ResolvedTable, type TableColumn, type TableDef, type Val,
} from "@confire/config-engine";
import { QueryValueHelp, type QuerySource } from "../ValueHelp.tsx";
import { displayValue } from "./formHelpers.ts";
import { addRow, pasteRows, removeRow, setCell, type Row } from "./configTableOps.ts";
import { money as fmtMoney } from "../../lib/money.ts";
import { useCurrency } from "../../orpc.ts";
import { qtyLabel, type ItemMoney } from "./itemMoney.ts";
import { colMinWidth } from "./tableWidths.ts";

const rowIndex = (row: unknown) => Number((row as { rowKey: string }).rowKey.split("-")[1]);

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
  querySource: QuerySource;
  /** Derived cost/price per row for an `items` grid. Absent = no money columns at all, which is how
   *  the portal stays free of cost data: PortalRequestPage simply does not pass it. */
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
  // colMinWidth measures positionally, so hand it the grid rather than the keyed rows.
  const grid = useMemo(() => evaluated.map((r) => def.columns.map((c) => r[c.key])), [evaluated, def]);

  // An items grid is never capped and never empty: its rows are the quotation's lines.
  const maxRows = def.role === "calc" ? def.maxRows : undefined;
  const atMax = maxRows !== undefined && rows.length >= maxRows;
  const atMin = rows.length <= (def.role === "calc" ? (def.minRows ?? 0) : 1);

  // Two runtime columns on an items grid: what the row costs and what it sells for, per unit, so
  // margin is readable without arithmetic. Neither is a declared column — the cost is never stored
  // and the price is stored only once someone types over it.
  const showMoney = def.role === "items" && !!money;
  // The quantity the two figures were priced at — see qtyLabel.
  const at = qtyLabel(money?.batchQty);
  const costHeader = `Unit cost${at}`;
  const priceHeader = `Unit price${at}`;
  const moneyHeaders = [costHeader, priceHeader];
  const moneyText = (n: number | undefined) => (n === undefined ? "—" : fmtMoney(n, currency));
  // Same positional sizing every other column gets, over the text these two actually render.
  const moneyGrid = useMemo(
    () => (money?.rows ?? []).map((m) => [moneyText(m?.unitCost), moneyText(m?.unitPrice)]),
    [money, currency],
  );

  const priceCell = (ri: number) => {
    const stored = rows[ri]?.[PRICE_COL];
    // Same contract a formula cell's override follows: the split until someone types, absence (not
    // a sentinel) is what "left alone" looks like, and the clear icon hands it back. The test is
    // the one buildQuoteLines applies, so the cell cannot show a number the quotation will reject.
    const overridden = typeof stored === "number" && Number.isFinite(stored) && stored >= 0;
    const value = overridden ? stored : money?.rows[ri]?.unitPrice;
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
      return (
        <QueryValueHelp source={querySource} canonicalTable={lookups.tables[ref.table]} lookupRef={ref}
          value={stored ?? undefined} headerText={header(c)} disabled={disabled}
          showValue={def.role === "items"}
          onPick={(t) => onQueryPick?.(pickKey, ref.table, t)}
          onChange={(nv) => {
            if (nv === undefined || nv === null) onQueryPick?.(pickKey, ref.table, undefined);
            set(nv ?? null);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {readOnly ? null : (
      <Toolbar design="Transparent" accessibleName={`${def.title} actions`}>
        <ToolbarButton icon="add" design="Transparent" text="Add row" disabled={disabled || atMax}
          onClick={() => onChange(addRow(rows))} />
      </Toolbar>
      )}
      <div
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          // Only a grid becomes new rows; a single value belongs in the cell being pasted into.
          if (!/[\t\n]/.test(text) || disabled || readOnly) return;
          e.preventDefault();
          onChange(pasteRows(rows, def, text, maxRows));
        }}>
        <Table
          // noDataText, not an IllustratedMessage: the illustration needs its own side-effect
          // import to register a loader, and this is a small inline grid, not an empty page.
          noDataText="No rows yet. Add one, or paste a block of cells straight from a spreadsheet."
          rowActionCount={disabled || readOnly || atMin ? 0 : 1}
          onRowActionClick={(e) => onChange(removeRow(rows, rowIndex(e.detail.row)))}
          headerRow={
            <TableHeaderRow>
              {def.columns.map((c, i) => (
                <TableHeaderCell key={c.key} minWidth={colMinWidth(header(c), grid, i)}>
                  <span>{header(c)}</span>
                </TableHeaderCell>
              ))}
              {showMoney
                ? moneyHeaders.map((h, i) => (
                    <TableHeaderCell key={h} minWidth={colMinWidth(h, moneyGrid, i)}>
                      <span>{h}</span>
                    </TableHeaderCell>
                  ))
                : null}
            </TableHeaderRow>
          }>
          {rows.map((_, ri) => (
            <TableRow key={ri} rowKey={`row-${ri}`}
              actions={disabled || readOnly || atMin ? undefined : <TableRowAction icon="delete" text="Delete" />}>
              {def.columns.map((c) => (
                <TableCell key={c.key}>{cell(ri, c)}</TableCell>
              ))}
              {/* an array, not a fragment: every other cell list here is one, and nothing has to
                  wonder whether the row component walks its children */}
              {showMoney ? [
                <TableCell key="cost"><Text>{moneyText(money?.rows[ri]?.unitCost)}</Text></TableCell>,
                <TableCell key="price">{priceCell(ri)}</TableCell>,
              ] : null}
            </TableRow>
          ))}
        </Table>
      </div>
    </div>
  );
}
