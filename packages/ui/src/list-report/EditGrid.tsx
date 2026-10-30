import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { useUiI18n } from "../i18n.ts";
import { FormField } from "../object-page/FormField.tsx";
import { allExist, notFoundMessage } from "../cfl/existence.ts";
import type { UiSource } from "../source.tsx";
import { Grid, type CellTemplate, type GridState, type Selection } from "./Grid.tsx";
import type { Control, FormField as Field, ListColumn, Row } from "../types.ts";

// Every editable grid (§3.4, value-help doc §8) on Grid: a document's lines, a declared table, a
// template's own list. Read mode is Grid's own formatted cells and links; edit mode makes every
// editable column an inline FormField — or the page's control kind the column names — with Add line
// / Delete on the toolbar instead of Beas' auto-added draft row.
//
// Typing in an AnalyticalTable keeps focus only while each column's Cell component survives the
// edit — ConfigTable's pattern: templates built once per column set, reading this render's lines
// through a ref.

/** Cell errors are keyed `<row index>:<column key>`. */
export const cellKey = (i: number, col: string) => `${i}:${col}`;

/** A column as the form field its editor is. */
const asField = (c: ListColumn): Field => ({
  key: c.key,
  label: c.label,
  type: c.type,
  ...(c.required ? { required: true } : {}),
  ...(c.controlType ? { controlType: c.controlType } : {}),
  ...(c.placeholder ? { placeholder: c.placeholder } : {}),
  ...(c.options ? { options: c.options } : {}),
  ...(c.maxLength ? { validators: { maxLength: c.maxLength } } : {}),
  ...(c.cflConfig ? { cfl: { dialogConfig: c.cflConfig } } : {}),
  ...(c.linkConfig ? { link: c.linkConfig } : {}),
  ...(c.yesNo ? { yesNo: true } : {}),
  ...(c.integer ? { integer: true } : {}),
});

/** A cell is editable when the collection is writable and the column itself is (metadata Editable,
 *  not declared readonly). */
const cellEditable = (c: ListColumn) => !!c.metaEditable && !c.readonly;

/**
 * validateCflCells(): every value-help column's distinct values probed once, every cell holding a
 * missing one marked. A failed probe counts as existing, as everywhere else.
 */
export async function validateCflCells(
  qc: QueryClient, client: UiSource["client"], columns: ListColumn[], rows: Row[],
  t?: (key: string, ...params: Array<string | number>) => string,
): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const c of columns) {
    if (!c.cflConfig || !cellEditable(c)) continue;
    const cfg = { dialogConfig: c.cflConfig };
    const missing = await allExist(qc, client, cfg, rows.map((r) => r[c.key]));
    rows.forEach((r, i) => {
      if (missing.has(String(r[c.key] ?? "").trim())) errors[cellKey(i, c.key)] = notFoundMessage(cfg, t);
    });
  }
  return errors;
}

/** An editor owns its keys: AnalyticalTable's keyboard navigation takes Arrow/Home/End off any
 *  focused cell — caret moves and the value help's type-ahead included — and Enter selects the row.
 *  Grid has no useF2CellEdit (the hook that turns that off while editing), so a cell stops them
 *  before they reach the table. */
const ownKeys = (e: KeyboardEvent) => e.stopPropagation();

/** The array position each grid row carries, so a cell and the selection name the line they mean. */
const IDX = "#i";

/** Shallow: a layout copies a column with a spread, so its values are the declared ones. */
const sameColumn = (a: ListColumn, b: ListColumn) => {
  const ks = Object.keys(a) as (keyof ListColumn)[];
  return ks.length === Object.keys(b).length && ks.every((k) => a[k] === b[k]);
};

/** B1's "#": VisualOrder counts from 0, and a line not yet in SAP has none — its place is its number. */
const lineNo: CellTemplate = (row) => <span>{Number(row.VisualOrder ?? row[IDX]) + 1}</span>;

export function EditGrid({
  title, table, columns, rows, onChange, readOnly, fixedRows, newRow, errors, controls, toolbarActions, onColumnsChange,
}: {
  title?: string;
  /** the collection's key, handed to a control kind with the line's position */
  table?: string;
  columns: ListColumn[];
  rows: Row[];
  onChange: (rows: Row[]) => void;
  readOnly?: boolean;
  /** Delete but no Add line */
  fixedRows?: boolean;
  /** what Add line starts with; default an empty line */
  newRow?: (rows: Row[]) => Row;
  /** the page's control kinds, for the columns that name one */
  controls?: Record<string, Control>;
  errors?: Record<string, string>;
  /** the caller's buttons, ahead of Add/Delete */
  toolbarActions?: (selection: Selection) => ReactNode;
  /** enables the settings gear: the columns to show, in order (the rest are hidden) */
  onColumnsChange?: (keys: string[]) => void;
}) {
  const i18n = useUiI18n();
  // The page re-applies its layout on every keystroke, which hands over a new column array (and a
  // new copy of a column the layout shows against its declared `hidden`). Keep the last array while
  // its columns are equal: Grid builds one Cell component per column off it, and a new one remounts
  // the input under the cursor.
  const prev = useRef<ListColumn[]>([]);
  const shownCols = columns.filter((c) => !c.hidden);
  const visible = shownCols.length === prev.current.length && shownCols.every((c, i) => sameColumn(c, prev.current[i]!))
    ? prev.current
    : (prev.current = shownCols);
  // The hidden ones too, for the settings dialog — by key, as their objects are new on every apply.
  const hidden = columns.filter((c) => c.hidden);
  const hiddenKeys = hidden.map((c) => c.key).join(" ");

  const gridColumns = useMemo(
    () => [...visible, ...hidden].map((c) => ({ ...c, sortable: false })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, hiddenKeys],
  );
  const state = useMemo<GridState>(() => ({ columns: visible.map((c) => c.key), sortBy: [], groupBy: [] }), [visible]);
  // `errors` too: the templates read them through the ref, and only new data re-renders the cells.
  const data = useMemo(() => rows.map((r, i) => ({ ...r, [IDX]: i })), [rows, errors]);

  // A value-help pick sets the key and then patches the line from the row in the same tick, before
  // the parent re-renders — so each edit builds on the last one, not on the rows this render got.
  const latest = useRef({ rows, errors, onChange, controls });
  latest.current = { rows, errors, onChange, controls };
  const setCell = (i: number, patch: Row) => {
    const next = [...latest.current.rows];
    next[i] = { ...next[i], ...patch };
    latest.current.rows = next;
    latest.current.onChange(next);
  };

  // Stable for the column set (see `visible`); this render's lines and errors come through the ref.
  const cellTemplates = useMemo(
    () => ({
      VisualOrder: lineNo,
      ...(readOnly ? {} : Object.fromEntries(visible.filter(cellEditable).map((c): [string, CellTemplate] => [c.key, (row) => {
        const i = row[IDX] as number;
        const r = latest.current.rows[i] ?? {};
        return (
          <div style={{ width: "100%" }} onKeyDown={ownKeys}>
            <FormField inline field={asField(c)} value={r[c.key]} formData={r} editable
              controls={latest.current.controls} table={table} rowIndex={i}
              error={latest.current.errors?.[cellKey(i, c.key)]}
              onChange={(v) => setCell(i, { [c.key]: v })}
              onPatch={(values) => setCell(i, values)}
              onRowSelect={c.onRowSelect ? (picked) => setCell(i, c.onRowSelect!(picked)) : undefined} />
          </div>
        );
      }]))),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, readOnly, table],
  );

  return (
    <Grid title={title} columns={gridColumns} state={state} rows={data} fill={false} statusRows
      showSettings={!!onColumnsChange}
      // Only the column set is the layout's; widths stay the table's own, as before.
      onStateChange={onColumnsChange ? (patch) => { if (patch.columns) onColumnsChange(patch.columns); } : undefined}
      exportName={title} noDataText={i18n.getText("UI_NO_LINES")} cellTemplates={cellTemplates}
      selectionMode={readOnly ? "None" : "Multiple"}
      toolbarActions={readOnly && !toolbarActions ? undefined : (sel) => (
        <>
          {toolbarActions?.(sel)}
          {readOnly ? null : (
            <>
              {fixedRows ? null : (
                <Button icon="add" design="Transparent" onClick={() => onChange([...rows, newRow?.(rows) ?? {}])}>{i18n.getText("UI_ADD_LINE")}</Button>
              )}
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={() => {
                  const gone = new Set(sel.rows.map((r) => r[IDX] as number));
                  // row ids are positions, so a kept selection would land on the lines that moved up
                  sel.clear();
                  onChange(rows.filter((_, j) => !gone.has(j)));
                }}>{i18n.getText("UI_DELETE")}</Button>
            </>
          )}
        </>
      )} />
  );
}
