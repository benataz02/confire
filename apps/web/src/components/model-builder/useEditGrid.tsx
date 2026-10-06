import { useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Form, FormGroup, FormItem } from "@ui5/webcomponents-react";
import type { CellTemplate, GridState } from "../../shared/list-report/Grid.tsx";
import type { ListColumn, Row } from "../../shared/types.ts";

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

/** The FormItem class that holds a table in a `FormGroup colSpan={layout}`, the way ConfiguratorForm
 *  places ConfigTable: the Form lays a group's items in `column-count` columns, so the item breaks
 *  out with `column-span: all` (FormItem's columnSpan is deprecated since UI5 2.23 and does nothing),
 *  and its label part is hidden — the Grid's toolbar names the table. Same rule and style id as
 *  ConfiguratorForm's, so whichever module loads first injects it. */
const TABLE_ITEM = "confire-table-item";
if (typeof document !== "undefined" && !document.getElementById(TABLE_ITEM)) {
  const el = document.createElement("style");
  el.id = TABLE_ITEM;
  el.textContent = `.${TABLE_ITEM}{column-span:all}.${TABLE_ITEM}::part(label){display:none}`;
  document.head.appendChild(el);
}

// ConfiguratorForm's FORM_PROPS, so a grid sits in the builder the way ConfigTable sits in a section.
const GRID_FORM = { accessibleMode: "Edit", labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2" } as const;

/** A grid in a Form of its own: one full-width headerless group, as ConfiguratorForm places a table. */
export function GridForm({ name, children }: { name: string; children: ReactNode }) {
  return (
    <Form {...GRID_FORM} accessibleName={name}>
      <FormGroup colSpan={GRID_FORM.layout}>
        <FormItem className={TABLE_ITEM}>{children}</FormItem>
      </FormGroup>
    </Form>
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
