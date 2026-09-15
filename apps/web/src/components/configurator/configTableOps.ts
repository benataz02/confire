import type { TableColumn, TableDef, Val } from "@confire/config-engine";

/** One stored row: the author-declared input/option cells, plus any computed cell the user typed
 *  over — an absent formula cell is the normal case and means "follow the formula". */
export type Row = Record<string, Val>;

/** Coerce raw text to the column's type — same rule as the masterdata editor's `typed`. */
export const typedCell = (type: TableColumn["type"], raw: string): Val =>
  type === "number" ? (raw === "" ? null : Number(raw)) : type === "boolean" ? raw === "true" : raw;

/** The columns a pasted block fills, in declaration order.
 *  ponytail: a computed column is overridable by hand but stays out of a paste — pasting the
 *  page's own numbers back in would freeze every formula at once. Include them if authors ask. */
export const inputColumns = (def: TableDef): TableColumn[] => def.columns.filter((c) => c.cell.kind !== "formula");

export const addRow = (rows: Row[]): Row[] => [...rows, {}];
export const removeRow = (rows: Row[], i: number): Row[] => rows.filter((_, j) => j !== i);
export const setCell = (rows: Row[], i: number, key: string, v: Val): Row[] =>
  rows.map((r, j) => (j === i ? { ...r, [key]: v } : r));

/** Excel/Sheets clipboard is TSV. Columns map positionally onto the *editable* columns, so a
 *  pasted block lines up with what the user sees minus the computed cells. */
export function pasteRows(rows: Row[], def: TableDef, text: string, maxRows?: number): Row[] {
  const cols = inputColumns(def);
  if (!cols.length) return rows;
  const parsed = text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => l.split("\t"));
  if (!parsed.length) return rows;
  const added = parsed.map((cells) =>
    Object.fromEntries(cols.map((c, i) => [c.key, typedCell(c.type, cells[i] ?? "")])),
  );
  const next = [...rows, ...added];
  return maxRows === undefined ? next : next.slice(0, maxRows);
}
