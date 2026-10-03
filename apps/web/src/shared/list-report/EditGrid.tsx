import { useRef } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
} from "@ui5/webcomponents-react";
import { FormField } from "../object-page/FormField.tsx";
import { allExist } from "../cfl/existence.ts";
import type { FormField as Field, ListColumn, Row } from "../types.ts";

// beas-grid in edit mode (§3.4, value-help doc §8): array data only, every editable column an
// inline FormField, and a draft row at the end that becomes a real one on its first edit
// (edit.autoAddRow). Used for a new document's lines.
//
// The UI5 Table, not AnalyticalTable: AnalyticalTable re-creates its cells when the data array
// changes, and an input re-created under the cursor loses focus on every keystroke — the ui5 Table
// keeps its rows (the pattern ItemStructureTabs and ConfigTable already use).

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
export async function validateCflCells(qc: QueryClient, columns: ListColumn[], rows: Row[]): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const c of columns) {
    if (!c.cflConfig || !cellEditable(c)) continue;
    const cfg = { dialogConfig: c.cflConfig };
    const missing = await allExist(qc, cfg, rows.map((r) => r[c.key]));
    rows.forEach((r, i) => {
      if (missing.has(String(r[c.key] ?? "").trim())) errors[cellKey(i, c.key)] = `${c.cflConfig!.title} not found`;
    });
  }
  return errors;
}

/** Is a line still the untouched draft? Every editable cell empty. */
const isBlankRow = (r: Row) => Object.values(r).every((v) => v === null || v === undefined || v === "");

export function EditGrid({ columns, rows, onChange, readOnly, errors }: {
  columns: ListColumn[];
  rows: Row[];
  onChange: (rows: Row[]) => void;
  readOnly?: boolean;
  errors?: Record<string, string>;
}) {
  const visible = columns.filter((c) => !c.hidden);
  // The draft row: always one empty line after the real ones while editing.
  const shown = readOnly ? rows : [...rows, {}];
  // A value-help pick sets the key and then patches the line from the row in the same tick, before
  // the parent re-renders — so each edit builds on the last one, not on the rows this render got.
  const latest = useRef(rows);
  latest.current = rows;
  const setCell = (i: number, patch: Row) => {
    const cur = latest.current;
    const next = [...cur];
    next[i] = { ...(cur[i] ?? {}), ...patch };
    latest.current = next.filter((r, j) => j < cur.length || !isBlankRow(r));
    onChange(latest.current);
  };

  return (
    <Table overflowMode="Popin" noDataText="No lines." rowActionCount={readOnly ? 0 : 1}
      onRowActionClick={(e) => {
        const i = Number((e.detail.row as unknown as HTMLElement).dataset.idx);
        if (i < rows.length) onChange(rows.filter((_, j) => j !== i));
      }}
      headerRow={
        <TableHeaderRow>
          {visible.map((c) => (
            <TableHeaderCell key={c.key} minWidth={c.width ? `${c.width}px` : "8rem"}>
              <span>{c.label ?? c.key}</span>
            </TableHeaderCell>
          ))}
        </TableHeaderRow>
      }>
      {shown.map((r, i) => (
        <TableRow key={i} rowKey={`line-${i}`} data-idx={String(i)}
          actions={readOnly || i >= rows.length ? undefined : <TableRowAction icon="delete" text="Delete line" />}>
          {visible.map((c) => (
            <TableCell key={c.key}>
              <FormField inline field={asField(c)} value={r[c.key]} formData={r}
                editable={!readOnly && cellEditable(c)}
                error={errors?.[cellKey(i, c.key)]}
                onChange={(v) => setCell(i, { [c.key]: v })}
                onRowSelect={c.onRowSelect ? (row) => setCell(i, c.onRowSelect!(row)) : undefined} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </Table>
  );
}
