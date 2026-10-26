import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import {
  AnalyticalTable, AnalyticalTableHooks, Bar, Button, Form, FormGroup, FormItem, IllustratedMessage, Label, ObjectStatus, Title,
  type AnalyticalTableCellInstance, type AnalyticalTableColumnDefinition, type AnalyticalTablePropTypes,
  type AnalyticalTableInstance, type ReactTableHooks,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { decodeBool } from "@confire/b1";
import { statusState } from "../documentStatus.ts";
import { EntityLink, useCanOpen } from "../EntityLink.tsx";
import { useUiI18n } from "../i18n.ts";
import { endAligned, formatValue, optionLabel, parseIsoDate } from "../format.ts";
import { linkValue } from "../navigation.ts";
import { GridSettingsDialog } from "./GridSettingsDialog.tsx";
import type { ListColumn, Row, ViewState } from "../types.ts";

// beas-grid, read mode (LIST-REPORT-OBJECT-PAGE.md §3.4) over AnalyticalTable: the view decides
// which columns show, in what order, at which widths, sorted and grouped how. Sorting
// and paging are the server's (manualSortBy, infinite scroll); grouping is client-side over the
// rows loaded so far, and each page scrolled in joins its groups or opens new ones.

export type GridState = Pick<ViewState, "columns" | "sortBy" | "groupBy" | "columnWidths">;
export type Selection = { rows: Row[]; clear: () => void };
export type CellTemplate = (row: Row, column: ListColumn) => ReactNode;

const NO_SELECTION: { ids: Record<string, boolean>; rows: Row[] } = { ids: {}, rows: [] };

const tableStyle: CSSProperties = {
  maxHeight: "100%",
  boxSizing: "border-box",
  overflow: "hidden",
  borderRadius: "var(--sapElement_BorderCornerRadius)",
};
// AutoWithEmptyRows rounds the row count down, so up to a row of the slot is left over: the frame
// takes it inside its own background, or it reads as a deeper bottom margin than the sides'.
const fillTableStyle: CSSProperties = { ...tableStyle, height: "100%", background: "var(--sapList_Background)" };

// Full screen is the page, not the browser's. AutoWithEmptyRows counts rows from the table's
// parentElement, so the parent is ours: on the page it passes the slot's height through, full page
// it is what fills the viewport. `position: fixed` alone stays inside DynamicPage (its root is
// `container-type: inline-size`, which contains fixed descendants), so it goes into the top layer as
// a manual popover — the escape ui5's own popups use. Same elements, so scroll, loaded pages and open
// groups survive; popups opened later stack above it.
const slotStyle: CSSProperties = { height: "100%" };
// undoes the UA [popover] box: fit-content, margin, border, padding, Canvas colors
const fullPageStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  margin: 0,
  border: 0,
  padding: 0,
  color: "inherit",
  background: "var(--sapBackgroundColor)",
};

/** A link cell (§3 linkConfig): only for a plain string column — no template, no options, no
 *  other type — with a non-empty value. Anything typed is formatted instead, as in Beas. */
const isLinkCell = (c: ListColumn) => !!c.linkConfig && !c.options && (!c.type || c.type === "string");

/** The .xlsx export (ExcelExportService): the visible columns, typed cells, option labels. */
async function exportXlsx(title: string, columns: ListColumn[], rows: Row[]) {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const cell = (v: unknown, c: ListColumn) => {
    if (v === null || v === undefined || v === "") return null;
    const label = optionLabel(v, c.options);
    if (label !== undefined) return { type: String, value: label };
    if (c.type === "number" && typeof v === "number") return { type: Number, value: v };
    if (c.type === "boolean") return { type: Boolean, value: decodeBool(v) };
    if (c.type === "date") {
      const d = parseIsoDate(v);
      if (d) return { type: Date, value: d, format: "yyyy-mm-dd" };
    }
    return { type: String, value: typeof v === "object" ? JSON.stringify(v) : String(v) };
  };
  const header = columns.map((c) => ({ value: c.label ?? c.key, fontWeight: "bold" as const }));
  await writeXlsxFile(
    [header, ...rows.map((r) => columns.map((c) => cell(r[c.key], c)))],
    { columns: columns.map((c) => ({ width: Math.max(10, Math.round((c.width ?? 140) / 7)) })) },
  ).toFile(`${title || "export"}.xlsx`);
}

/** react-table starts every group shut. For a grid whose rows are all loaded, grouping is a way to
 *  read them, not to hide them: open every group whenever the set of groups changes. A group the
 *  user closes stays closed until then. Not for a paged list, where a page appending new groups
 *  would reopen the ones the user closed. */
const useExpandGroups = (hooks: ReactTableHooks) => {
  hooks.useInstance.push((instance: AnalyticalTableInstance) => {
    const groups = (instance.onlyGroupedFlatRows ?? []).map((r) => r.id).join();
    const expand = instance.toggleAllRowsExpanded;
    useEffect(() => { if (groups) expand?.(true); }, [groups, expand]);
  });
};

/** The FormItem class that holds a table in a `FormGroup colSpan={layout}` (GridForm, and
 *  ConfiguratorForm's table groups): the Form lays a group's items in `column-count` columns, so the
 *  item breaks out with `column-span: all` (FormItem's columnSpan is deprecated since UI5 2.23 and
 *  does nothing), and its label part is hidden — the Form's title or the Grid's toolbar names the
 *  table. */
export const TABLE_ITEM = "confire-table-item";
if (typeof document !== "undefined" && !document.getElementById(TABLE_ITEM)) {
  const el = document.createElement("style");
  el.id = TABLE_ITEM;
  el.textContent = `.${TABLE_ITEM}{column-span:all}.${TABLE_ITEM}::part(label){display:none}`;
  document.head.appendChild(el);
}

/** A `statusRows` grid's closed line (global.css). */
const CLOSED_ROW = "confire-row-closed";

// ConfiguratorForm's FORM_PROPS, so a grid sits in a page the way ConfigTable sits in a section.
const GRID_FORM = { accessibleMode: "Edit", labelSpan: "S12 M12 L12 XL12", layout: "S1 M2 L2 XL2", headerLevel: "H5" } as const;

/** A grid in a Form of its own: one full-width group, as ConfiguratorForm places a table. With
 *  `headerText` the Form titles the table; without, `name` only labels it (a section already does). */
export function GridForm({ name, headerText, children }: { name?: string; headerText?: string; children: ReactNode }) {
  return (
    <Form {...GRID_FORM} headerText={headerText} accessibleName={name}>
      <FormGroup colSpan={GRID_FORM.layout}>
        <FormItem className={TABLE_ITEM}>{children}</FormItem>
      </FormGroup>
    </Form>
  );
}

export function Grid({
  title, columns, state, onStateChange, rows, total, loading, hasMore, onLoadMore, loadAll, keyOf,
  selectionMode = "None", selectedIds, onSelectionChange, onRowClick, toolbarActions, cellTemplates,
  exportName, showSettings = true, fill = true, epoch, noDataText, expandGroups, statusRows,
}: {
  title?: string;
  /** every column the view may show, resolved against metadata */
  columns: ListColumn[];
  state: GridState;
  onStateChange?: (patch: Partial<GridState>) => void;
  rows: Row[];
  total?: number;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** the whole result (capped) — export needs every row, not the loaded page */
  loadAll?: () => Promise<Row[]>;
  keyOf?: (row: Row) => string;
  selectionMode?: "None" | "Single" | "Multiple";
  /** controlled selection (the value-help dialog's highlight); omit to let the grid own it */
  selectedIds?: Record<string, boolean>;
  onSelectionChange?: (rows: Row[]) => void;
  onRowClick?: (row: Row) => void;
  /** toolbar buttons, given the current selection — `clear` because the selection is ours */
  toolbarActions?: (selection: Selection) => ReactNode;
  cellTemplates?: Record<string, CellTemplate>;
  /** enables Export; the file name */
  exportName?: string;
  showSettings?: boolean;
  /** fill the parent's height (a list page) rather than size to the rows (an object page) */
  fill?: boolean;
  /** remounts the table when a view is applied wholesale, so its own resize state starts over */
  epoch?: number;
  noDataText?: string;
  /** every row is loaded, so groups open as they appear (useExpandGroups) */
  expandGroups?: boolean;
  /** document lines: a row whose first status column says closed reads muted */
  statusRows?: boolean;
}) {
  const canOpen = useCanOpen();
  const i18n = useUiI18n();
  const [selected, setSelected] = useState(NO_SELECTION);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  // Dropping the `popover` attribute hides it again, so only opening needs a call.
  useLayoutEffect(() => {
    if (maximized) slotRef.current?.showPopover();
  }, [maximized]);
  // A view transition morphs the table between its slot and the page (timing in global.css).
  // flushSync: the new state is captured when the callback returns. The name is set only while it
  // runs, because two grids can be on screen (a list under its value help) and names must be unique.
  const toggleMaximized = () => {
    const el = slotRef.current;
    const flip = () => flushSync(() => setMaximized((m) => !m));
    if (!el || !document.startViewTransition) return flip();
    el.style.viewTransitionName = "confire-grid";
    document.startViewTransition(flip).finished.finally(() => { el.style.viewTransitionName = ""; });
  };

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const visible = useMemo(
    () => state.columns.map((k) => byKey.get(k)).filter((c): c is ListColumn => !!c),
    [state.columns, byKey],
  );

  // A width the table reported (useOnColumnResize below) comes back through `state`, but the table
  // already shows it, so it must not rebuild the columns: that remounts every cell, and a rebuilt
  // column the user did not resize falls back to react-table's 150px, because the table skips its
  // own layout while it holds a manual width. Only widths from elsewhere (a view applied, a saved
  // layout arriving) rebuild; any rebuild reads the latest ones.
  const reported = useRef<GridState["columnWidths"]>(undefined);
  const outsideWidths = useRef(state.columnWidths);
  if (state.columnWidths !== reported.current) outsideWidths.current = state.columnWidths;

  // One Cell component per column, built once per column set: a fresh function per render would be
  // a new component type to React and remount every cell on every keystroke elsewhere on the page.
  const tableColumns = useMemo<AnalyticalTableColumnDefinition[]>(
    () =>
      visible.map((c) => {
        const template = cellTemplates?.[c.key];
        // Inverted, as the local lists draw their status cells (configs, requests).
        const show = (v: unknown) => {
          const text = formatValue(v, c.type, c.options, c.integer);
          return c.status && text ? <ObjectStatus inverted state={statusState(v)}>{text}</ObjectStatus> : <span>{text}</span>;
        };
        const Cell = ({ cell }: AnalyticalTableCellInstance) => {
          // A group header row has no `original`, only the grouped value (react-table useGroupBy).
          if (cell.isGrouped) return show(cell.value);
          const r = ((cell.row as { original?: Row }).original ?? {}) as Row;
          const v = r[c.key];
          if (template) return <>{template(r, c)}</>;
          if (isLinkCell(c)) {
            const target = linkValue(v, c.linkConfig!, r);
            const route = c.linkConfig!.route;
            if (target && (c.linkConfig!.action || (route && canOpen(route))))
              return (
                <EntityLink route={route} target={target} value={v}
                  action={c.linkConfig!.action ? (x) => c.linkConfig!.action!(x, r) : undefined}>
                  {String(v ?? "").trim()}
                </EntityLink>
              );
          }
          return show(v);
        };
        return {
          id: c.key,
          accessor: (row: Row) => row[c.key],
          // A Label, not "*" in the text: UI5 draws the asterisk and announces "required".
          Header: c.required ? () => <Label required>{c.label ?? c.key}</Label> : c.label ?? c.key,
          ...(state.columnWidths?.[c.key] ?? c.width ? { width: state.columnWidths?.[c.key] ?? c.width } : {}),
          ...(endAligned(c.type) ? { hAlign: "End" as const } : {}),
          disableSortBy: c.sortable === false,
          disableGroupBy: c.groupable !== true,
          Cell,
          // A group row has no aggregates, and react-table falls back to Cell for them — which
          // then formats a record that does not exist (NaN out of a money template).
          Aggregated: () => null,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- widths: outsideWidths, above
    [visible, outsideWidths.current, cellTemplates, canOpen],
  );

  // Sort and group are the view's, not the table's: the controlled state shows the view's rules in
  // the headers (including a multi-sort set in the settings dialog), and a header click comes back
  // through onSort/onGroup to change the view.
  const sortBy = useMemo(() => state.sortBy.map((s) => ({ id: s.field, desc: s.direction === "desc" })), [state.sortBy]);
  const reactTableOptions = useMemo(
    () => ({
      autoResetSortBy: false, autoResetFilters: false, autoResetSelectedRows: false,
      // autoResetResize stays on: a new column set drops the table's manual widths and lays out
      // again from the view's (which hold every resize). Kept, a rebuilt column the user never
      // resized fell back to react-table's 150px, since the table skips its layout while it holds one.
      autoResetPage: false, autoResetHiddenColumns: false, autoResetGroupBy: false,
      // a page appended under a grouped view must not collapse the groups the user opened
      autoResetExpanded: false,
      manualSortBy: true, manualFilters: true, manualGlobalFilter: true,
      useControlledState: (s: Record<string, unknown>) => ({ ...s, sortBy, groupBy: state.groupBy }),
      // Row ids from the record's key, not its index: a selection then survives a page append,
      // and the value-help dialog can say which row is highlighted.
      ...(keyOf ? { getRowId: (row: Row) => keyOf(row) } : {}),
    }),
    [sortBy, state.groupBy, keyOf],
  );

  // Widths are committed when a resize ends (useOnColumnResize watches state.columnResizing), not
  // on every pixel. The plugin captures its callback once, so it reads the latest through a ref.
  // The commit must be a no-op when the width is already ours: the plugin (ui5 2.26) never clears
  // its last-resized column, so after one resize it re-fires on every `columns` change — and when a
  // commit still rebuilt `columns`, that was "Maximum update depth exceeded".
  const latest = useRef({ onStateChange, widths: state.columnWidths });
  latest.current = { onStateChange, widths: state.columnWidths };

  // A closed row is read off the first status column on screen — through a ref, because the hook
  // list is fixed while the column can be hidden.
  const statusKeyRef = useRef<string | undefined>(undefined);
  statusKeyRef.current = statusRows ? visible.find((c) => c.status)?.key : undefined;

  const tableHooks = useMemo(
    () => [
      AnalyticalTableHooks.useOnColumnResize(({ columnWidth, header }) => {
        const { onStateChange: change, widths } = latest.current;
        const width = Math.round(columnWidth);
        if (header?.id && Number.isFinite(width) && widths?.[header.id] !== width) {
          reported.current = { ...widths, [header.id]: width };
          change?.({ columnWidths: reported.current });
        }
      }),
      // Fixed for a grid's lifetime, so the plugin list (and react-table's hook order) never changes.
      ...(expandGroups ? [useExpandGroups] : []),
      ...(statusRows ? [(hooks: ReactTableHooks) => {
        hooks.getRowProps.push((props: object, { row }: { row: { original?: Row } }) => {
          const key = statusKeyRef.current;
          return key && row.original?.[key] === "bost_Close" ? [props, { className: CLOSED_ROW }] : props;
        });
      }] : []),
    ],
    [expandGroups, statusRows],
  );

  const handleSort = useCallback<NonNullable<AnalyticalTablePropTypes["onSort"]>>((e) => {
    const id = (e.detail.column as { id?: string }).id;
    const dir = e.detail.sortDirection;
    if (!id) return;
    onStateChange?.({ sortBy: dir === "asc" || dir === "desc" ? [{ field: id, direction: dir }] : [] });
  }, [onStateChange]);
  const handleGroup = useCallback<NonNullable<AnalyticalTablePropTypes["onGroup"]>>((e) => {
    onStateChange?.({ groupBy: e.detail.groupedColumns });
  }, [onStateChange]);
  const handleReorder = useCallback<NonNullable<AnalyticalTablePropTypes["onColumnsReorder"]>>((e) => {
    const order = e.detail.columnsNewOrder.map((c) => (c as { id?: string }).id).filter((id): id is string => !!id);
    if (order.length) onStateChange?.({ columns: order });
  }, [onStateChange]);
  const handleRowSelect = useCallback<NonNullable<AnalyticalTablePropTypes["onRowSelect"]>>((e) => {
    const ids = e.detail.selectedRowIds ?? {};
    const byId = e.detail.rowsById ?? {};
    const rowsSel = Object.keys(ids).filter((k) => ids[k]).map((k) => byId[k]?.original as Row).filter(Boolean);
    setSelected({ ids, rows: rowsSel });
    onSelectionChange?.(rowsSel);
  }, [onSelectionChange]);

  const NoData = useMemo(
    () =>
      function NoData({ noDataReason }: { noDataReason: "Empty" | "Filtered" }) {
        // getText reads the loaded language, so a switch updates the next render of this cell.
        return noDataReason === "Filtered" || !title ? (
          <IllustratedMessage name="NoData" design="Auto" titleText={noDataText ?? i18n.getText("UI_NOTHING_IN_VIEW")}
            subtitleText={i18n.getText("UI_TRY_DIFFERENT_FILTER")} />
        ) : (
          <IllustratedMessage name="NoData" design="Auto"
            titleText={noDataText ?? i18n.getText("UI_EMPTY_LIST", title.toLowerCase())} />
        );
      },
    // The stand-in bundle and the loaded one are different objects; once loaded, getText is live.
    [title, noDataText, i18n],
  );

  // A controlled selection may arrive before any click, and may name rows that are not loaded.
  const selCount = selectedIds && keyOf ? rows.filter((r) => selectedIds[keyOf(r)]).length : selected.rows.length;
  const fullScreenLabel = i18n.getText(maximized ? "UI_EXIT_FULL_SCREEN" : "UI_FULL_SCREEN");
  const toolbar = (
    <Bar
      startContent={title ? (
        <Title level="H5">
          {title} ({selectionMode === "Multiple" && selCount ? `${selCount}/` : ""}{total ?? rows.length})
        </Title>
      ) : undefined}
      endContent={
        <>
          {/* The caller's actions ride in an element of ours, as ObjectPageHeader's ToolbarItem does.
              ui5 hands `slot` to each slot child, and a component child (PrintActions) drops it: its
              buttons fell into the Bar's middle, and its closed Dialog became a slotted child that the
              Bar's `::slotted(*) { display: inline-block }` overrode `[popover] { display: none }` on —
              a stretched blank sheet over the page for as long as one row was selected. The gap
              replaces the `::slotted([ui5-button])` margins the buttons no longer get. */}
          {toolbarActions ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {toolbarActions({ rows: selected.rows, clear: () => setSelected(NO_SELECTION) })}
            </div>
          ) : null}
          {exportName ? (
            <Button icon="excel-attachment" design="Transparent" tooltip={i18n.getText("UI_EXPORT_EXCEL")} accessibleName={i18n.getText("UI_EXPORT_EXCEL")}
              disabled={exporting || !rows.length}
              onClick={async () => {
                setExporting(true);
                try {
                  await exportXlsx(exportName, visible, loadAll ? await loadAll() : rows);
                } finally {
                  setExporting(false);
                }
              }} />
          ) : null}
          <Button icon={maximized ? "exit-full-screen" : "full-screen"} design="Transparent"
            tooltip={fullScreenLabel} accessibleName={fullScreenLabel} onClick={toggleMaximized} />
          {showSettings && onStateChange ? (
            <Button icon="action-settings" design="Transparent" tooltip={i18n.getText("UI_VIEW_SETTINGS")} accessibleName={i18n.getText("UI_VIEW_SETTINGS")}
              onClick={() => setSettingsOpen(true)} />
          ) : null}
        </>
      }
    />
  );

  return (
    <>
      <div ref={slotRef} popover={maximized ? "manual" : undefined} style={maximized ? fullPageStyle : slotStyle}>
        <AnalyticalTable
          key={epoch}
          columns={tableColumns}
          data={rows}
          reactTableOptions={reactTableOptions}
          tableHooks={tableHooks}
          // A reported width never rebuilds the columns (outsideWidths), so they lag the view until
          // the next rebuild: without this, a container resize (full screen) lays out from them and
          // undoes the user's resize.
          retainColumnWidth
          style={fill || maximized ? fillTableStyle : tableStyle}
          extension={toolbar}
          loading={loading}
          minRows={1}
          visibleRowCountMode={fill || maximized ? "AutoWithEmptyRows" : "Fixed"}
          visibleRows={fill || maximized ? undefined : Math.min(Math.max(rows.length, 3), 15)}
          // onLoadMore only fires off a scroll of the table body, and a page that fits has nothing
          // to scroll — so while there is more, a few phantom rows keep the body scrollable. Grouped,
          // the table fires on every scroll to the bottom: a page may only grow existing groups.
          infiniteScroll={!!onLoadMore}
          additionalEmptyRowsCount={hasMore ? 5 : 0}
          infiniteScrollThreshold={40}
          onLoadMore={onLoadMore}
          // Sized to its rows, the body is three rows high and an illustration overflows it: an empty
          // one shows the table's own plain line of noDataText, or nothing.
          NoDataComponent={fill ? NoData : undefined}
          noDataText={noDataText ?? ""}
          sortable
          groupable={columns.some((c) => c.groupable)}
          onSort={handleSort}
          onGroup={handleGroup}
          onColumnsReorder={handleReorder}
          // The table hovers only rows a click selects (Single/Multiple, never RowSelector), so a
          // clickable list runs as Single/RowOnly — no selector column — and Multiple as Row.
          selectionMode={selectionMode === "None" && onRowClick ? "Single" : selectionMode}
          selectionBehavior={selectionMode === "None" ? "RowOnly" : "Row"}
          selectedRowIds={selectedIds ?? selected.ids}
          onRowSelect={handleRowSelect}
          withNavigationHighlight={!!onRowClick && selectionMode !== "Single"}
          onRowClick={(e) => {
            const target = e.target as HTMLElement | null;
            // The checkbox cell and a link inside a cell are not the row: one selects, the other
            // opens the referenced record.
            if (target?.closest?.('[data-selection-cell="true"], ui5-link')) return;
            const original = e.detail.row.original as Row | undefined;
            if (original) onRowClick?.(original);
          }}
        />
      </div>
      {settingsOpen ? (
        <GridSettingsDialog columns={columns} state={state}
          onConfirm={(patch) => { onStateChange?.(patch); setSettingsOpen(false); }}
          onClose={() => setSettingsOpen(false)} />
      ) : null}
    </>
  );
}
