import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@ui5/webcomponents-react";
import type { CellTemplate, GridState, Selection } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn, Row } from "@confire/ui/types.ts";
import { useI18n } from "../../i18n.ts";

// Grid over a model array edited in place (BOM, routing, constraints, mappings) — ConfigTable's
// pattern, shared by the builder's tables: every cell is the caller's editor, and Grid only
// supplies the frame — toolbar, selection, resize, full screen.

/** The array position each grid row carries: a cell and the selection both hand back row objects,
 *  and they have to name the element they mean. Not an identifier, so no column key collides. */
const IDX = "#i";

/** The array position a grid row stands for. */
export const positionOf = (row: Row) => row[IDX] as number;
/** The array positions of the selected rows. */
export const positions = (rows: Row[]) => new Set(rows.map(positionOf));

/** The toolbar's Delete: hands over the selected positions. The selection goes first — row ids are
 *  positions, so a kept one would land on the rows that moved up. */
export function DeleteRows({ sel, onDelete }: { sel: Selection; onDelete: (gone: Set<number>) => void }) {
  const i18n = useI18n();
  return (
    <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
      onClick={() => {
        const gone = positions(sel.rows);
        sel.clear();
        onDelete(gone);
      }}>
      {i18n.getText("MODEL_DELETE")}
    </Button>
  );
}

/** An editor owns its keys. AnalyticalTable's keyboard navigation takes Arrow/Home/End off any
 *  focused cell — caret moves and the value help's type-ahead included — and Enter selects the
 *  row. Grid has no useF2CellEdit (the hook that turns that off while editing), so a cell stops
 *  them before they reach the table. */
const ownKeys = (e: KeyboardEvent) => e.stopPropagation();

/**
 * Grid's props for `items`, one `cells` renderer per column; spread the result into Grid.
 *
 * `columns` must be stable (a module constant or memoized): Grid builds one Cell component per
 * column off `cellTemplates`, so a new template is a new component type to React and remounts the
 * input under the cursor. The templates therefore live as long as the column set does and read
 * this render's items and renderers through a ref. Not sortable: row order is the array's, and
 * Grid's sort is a server's job it would only ask the view to do.
 */
export function useEditGrid<T>(
  items: readonly T[],
  columns: ListColumn[],
  cells: Record<string, (item: T, i: number) => ReactNode>,
) {
  const latest = useRef({ items, cells });
  latest.current = { items, cells };
  return {
    columns: useMemo(() => columns.map((c) => ({ ...c, sortable: false })), [columns]),
    state: useMemo<GridState>(() => ({ columns: columns.map((c) => c.key), sortBy: [], groupBy: [] }), [columns]),
    rows: useMemo(() => items.map((_, i): Row => ({ [IDX]: i })), [items]),
    cellTemplates: useMemo(
      () => Object.fromEntries(columns.map((c): [string, CellTemplate] => [c.key, (row) => {
        const i = positionOf(row);
        const { items: now, cells: render } = latest.current;
        return <div style={{ width: "100%" }} onKeyDown={ownKeys}>{render[c.key]?.(now[i]!, i)}</div>;
      }])),
      [columns],
    ),
  };
}
