import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { useUiI18n } from "../i18n.ts";
import { FormField } from "../object-page/FormField.tsx";
import { allExist, notFoundMessage } from "../cfl/existence.ts";
import type { UiSource } from "../source.tsx";
import { Grid, type CellTemplate, type GridState, type Selection } from "./Grid.tsx";
import type { FormField as Field, ListColumn, Row } from "../types.ts";

// A document's lines (§3.4, value-help doc §8) on Grid: read mode is Grid's own formatted cells and
// links; edit mode (a new document's lines) makes every editable column an inline FormField, with
// Add line / Delete on the toolbar instead of Beas' auto-added draft row.
//
// Typing in an AnalyticalTable keeps focus only while each column's Cell component survives the
// edit — ConfigTable's and useEditGrid's pattern: templates built once per column set, reading this
// render's lines through a ref.

/** Cell errors are keyed `<row index>:<column key>`. */
export const cellKey = (i: number, col: string) => `${i}:${col}`;

/** A column as the form field its editor is. */
const asField = (c: ListColumn): Field => ({
  key: c.key,
  label: c.label,
  type: c.type,
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
 *  focused cell and Enter selects the row (useEditGrid's rule). */
const ownKeys = (e: KeyboardEvent) => e.stopPropagation();

/** The array position each grid row carries, so a cell and the selection name the line they mean. */
const IDX = "#i";

export function EditGrid({ title, columns, rows, onChange, readOnly, errors, toolbarActions }: {
  title?: string;
  columns: ListColumn[];
  rows: Row[];
  onChange: (rows: Row[]) => void;
  readOnly?: boolean;
  errors?: Record<string, string>;
  /** the caller's buttons, ahead of Add/Delete */
  toolbarActions?: (selection: Selection) => ReactNode;
}) {
  const i18n = useUiI18n();
  // The page re-applies its layout on every keystroke, which hands over a new column array whose
  // shown columns are the same objects. Keep the last array while they are: Grid builds one Cell
  // component per column off it, and a new one remounts the input under the cursor.
  const prev = useRef<ListColumn[]>([]);
  const shownCols = columns.filter((c) => !c.hidden);
  const visible = shownCols.length === prev.current.length && shownCols.every((c, i) => c === prev.current[i])
    ? prev.current
    : (prev.current = shownCols);

  const gridColumns = useMemo(() => visible.map((c) => ({ ...c, sortable: false })), [visible]);
  const state = useMemo<GridState>(() => ({ columns: visible.map((c) => c.key), sortBy: [], groupBy: [] }), [visible]);
  // `errors` too: the templates read them through the ref, and only new data re-renders the cells.
  const data = useMemo(() => rows.map((r, i) => ({ ...r, [IDX]: i })), [rows, errors]);

  // A value-help pick sets the key and then patches the line from the row in the same tick, before
  // the parent re-renders — so each edit builds on the last one, not on the rows this render got.
  const latest = useRef({ rows, errors, onChange });
  latest.current = { rows, errors, onChange };
  const setCell = (i: number, patch: Row) => {
    const next = [...latest.current.rows];
    next[i] = { ...next[i], ...patch };
    latest.current.rows = next;
    latest.current.onChange(next);
  };

  // Stable for the column set (see `visible`); this render's lines and errors come through the ref.
  const cellTemplates = useMemo(
    () => (readOnly ? undefined : Object.fromEntries(visible.filter(cellEditable).map((c): [string, CellTemplate] => [c.key, (row) => {
      const i = row[IDX] as number;
      const r = latest.current.rows[i] ?? {};
      return (
        <div style={{ width: "100%" }} onKeyDown={ownKeys}>
          <FormField inline field={asField(c)} value={r[c.key]} formData={r} editable
            error={latest.current.errors?.[cellKey(i, c.key)]}
            onChange={(v) => setCell(i, { [c.key]: v })}
            onRowSelect={c.onRowSelect ? (picked) => setCell(i, c.onRowSelect!(picked)) : undefined} />
        </div>
      );
    }]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, readOnly],
  );

  return (
    <Grid title={title} columns={gridColumns} state={state} rows={data} fill={false} showSettings={false}
      exportName={title} noDataText={i18n.getText("UI_NO_LINES")} cellTemplates={cellTemplates}
      selectionMode={readOnly ? "None" : "Multiple"}
      toolbarActions={readOnly && !toolbarActions ? undefined : (sel) => (
        <>
          {toolbarActions?.(sel)}
          {readOnly ? null : (
            <>
              <Button icon="add" design="Transparent" onClick={() => onChange([...rows, {}])}>{i18n.getText("UI_ADD_LINE")}</Button>
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
