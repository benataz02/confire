import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AnalyticalTable, AnalyticalTableHooks, Bar, Button, IllustratedMessage, Title,
  type AnalyticalTableCellInstance, type AnalyticalTableColumnDefinition, type AnalyticalTablePropTypes,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { decodeBool } from "@confire/b1";
import { EntityLink, useCanOpen } from "../EntityLink.tsx";
import { endAligned, formatValue, optionLabel, parseIsoDate } from "../format.ts";
import { linkValue } from "../navigation.ts";
import { GridSettingsDialog } from "./GridSettingsDialog.tsx";
import type { ListColumn, Row, ViewState } from "../types.ts";

// beas-grid, read mode (LIST-REPORT-OBJECT-PAGE.md §3.4) over AnalyticalTable: the view decides
// which columns show, in what order, with which labels and widths, sorted and grouped how. Sorting
// and paging are the server's (manualSortBy, infinite scroll); grouping is client-side over rows
// the caller loaded in full first.

export type GridState = Pick<ViewState, "columns" | "labels" | "sortBy" | "groupBy" | "columnWidths">;
export type Selection = { rows: Row[]; clear: () => void };
export type CellTemplate = (row: Row, column: ListColumn) => ReactNode;

const NO_SELECTION: { ids: Record<string, boolean>; rows: Row[] } = { ids: {}, rows: [] };

const tableStyle: CSSProperties = {
  maxHeight: "100%",
  boxSizing: "border-box",
  overflow: "hidden",
  borderRadius: "var(--sapElement_BorderCornerRadius)",
};

/** A link cell (§3 linkConfig): only for a plain string column — no template, no options, no
 *  other type — with a non-empty value. Anything typed is formatted instead, as in Beas. */
const isLinkCell = (c: ListColumn) => !!c.linkConfig && !c.options && (!c.type || c.type === "string");

/** The .xlsx export (ExcelExportService): the visible columns, typed cells, option labels. */
async function exportXlsx(title: string, columns: ListColumn[], labels: Record<string, string> | undefined, rows: Row[]) {
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
  const header = columns.map((c) => ({ value: labels?.[c.key] ?? c.label ?? c.key, fontWeight: "bold" as const }));
  await writeXlsxFile(
    [header, ...rows.map((r) => columns.map((c) => cell(r[c.key], c)))],
    { columns: columns.map((c) => ({ width: Math.max(10, Math.round((c.width ?? 140) / 7)) })) },
  ).toFile(`${title || "export"}.xlsx`);
}

export function Grid({
  title, columns, state, onStateChange, rows, total, loading, hasMore, onLoadMore, loadAll, keyOf,
  selectionMode = "None", selectedIds, onSelectionChange, onRowClick, toolbarActions, cellTemplates,
  exportName, showSettings = true, fill = true, epoch, noDataText,
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
  /** the whole result (capped) — export and grouping need every row, not the loaded page */
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
}) {
  const canOpen = useCanOpen();
  const [selected, setSelected] = useState(NO_SELECTION);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const visible = useMemo(
    () => state.columns.map((k) => byKey.get(k)).filter((c): c is ListColumn => !!c),
    [state.columns, byKey],
  );

  // One Cell component per column, built once per column set: a fresh function per render would be
  // a new component type to React and remount every cell on every keystroke elsewhere on the page.
  const tableColumns = useMemo<AnalyticalTableColumnDefinition[]>(
    () =>
      visible.map((c) => {
        const template = cellTemplates?.[c.key];
        const Cell = ({ cell }: AnalyticalTableCellInstance) => {
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
          return <span>{formatValue(v, c.type, c.options)}</span>;
        };
        return {
          id: c.key,
          accessor: (row: Row) => row[c.key],
          Header: state.labels?.[c.key] ?? c.label ?? c.key,
          ...(state.columnWidths?.[c.key] ?? c.width ? { width: state.columnWidths?.[c.key] ?? c.width } : {}),
          ...(endAligned(c.type) ? { hAlign: "End" as const } : {}),
          disableSortBy: c.sortable === false,
          disableGroupBy: c.groupable !== true,
          Cell,
        };
      }),
    [visible, state.labels, state.columnWidths, cellTemplates, canOpen],
  );

  // Sort and group are the view's, not the table's: the controlled state shows the view's rules in
  // the headers (including a multi-sort set in the settings dialog), and a header click comes back
  // through onSort/onGroup to change the view.
  const sortBy = useMemo(() => state.sortBy.map((s) => ({ id: s.field, desc: s.direction === "desc" })), [state.sortBy]);
  const reactTableOptions = useMemo(
    () => ({
      autoResetSortBy: false, autoResetFilters: false, autoResetSelectedRows: false,
      autoResetPage: false, autoResetHiddenColumns: false, autoResetResize: false, autoResetGroupBy: false,
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
  const latest = useRef({ onStateChange, widths: state.columnWidths });
  latest.current = { onStateChange, widths: state.columnWidths };
  const tableHooks = useMemo(
    () => [
      AnalyticalTableHooks.useOnColumnResize(({ columnWidth, header }) => {
        const { onStateChange: change, widths } = latest.current;
        if (header?.id && Number.isFinite(columnWidth))
          change?.({ columnWidths: { ...widths, [header.id]: Math.round(columnWidth) } });
      }),
    ],
    [],
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
        return noDataReason === "Filtered" || !title ? (
          <IllustratedMessage name="NoData" design="Auto" titleText={noDataText ?? "Nothing in this view"}
            subtitleText="Try a different filter or pick another view." />
        ) : (
          <IllustratedMessage name="NoData" design="Auto" titleText={noDataText ?? `No ${title.toLowerCase()} yet`} />
        );
      },
    [title, noDataText],
  );

  const grouped = state.groupBy.length > 0;
  const toolbar = (
    <Bar
      startContent={title ? (
        <Title level="H5">
          {title} ({selectionMode === "Multiple" ? `${selected.rows.length}/` : ""}{total ?? rows.length})
        </Title>
      ) : undefined}
      endContent={
        <>
          {toolbarActions?.({ rows: selected.rows, clear: () => setSelected(NO_SELECTION) })}
          {exportName ? (
            <Button icon="excel-attachment" design="Transparent" tooltip="Export to Excel" accessibleName="Export to Excel"
              disabled={exporting || !rows.length}
              onClick={async () => {
                setExporting(true);
                try {
                  await exportXlsx(exportName, visible, state.labels, loadAll ? await loadAll() : rows);
                } finally {
                  setExporting(false);
                }
              }} />
          ) : null}
          {showSettings && onStateChange ? (
            <Button icon="action-settings" design="Transparent" tooltip="View settings" accessibleName="View settings"
              onClick={() => setSettingsOpen(true)} />
          ) : null}
        </>
      }
    />
  );

  return (
    <>
      <AnalyticalTable
        key={epoch}
        columns={tableColumns}
        data={rows}
        reactTableOptions={reactTableOptions}
        tableHooks={tableHooks}
        style={tableStyle}
        extension={toolbar}
        loading={loading}
        minRows={1}
        visibleRowCountMode={fill ? "AutoWithEmptyRows" : "Fixed"}
        visibleRows={fill ? undefined : Math.min(Math.max(rows.length, 3), 15)}
        // onLoadMore only fires off a scroll of the table body, and a page that fits has nothing
        // to scroll — so while there is more, a few phantom rows keep the body scrollable. Grouped
        // views have every row already (loadAll), so no infinite scroll there.
        infiniteScroll={!!onLoadMore && !grouped}
        additionalEmptyRowsCount={hasMore && !grouped ? 5 : 0}
        infiniteScrollThreshold={40}
        onLoadMore={onLoadMore}
        NoDataComponent={NoData}
        sortable
        groupable={columns.some((c) => c.groupable)}
        onSort={handleSort}
        onGroup={handleGroup}
        onColumnsReorder={handleReorder}
        selectionMode={selectionMode}
        selectionBehavior={selectionMode === "Single" ? "Row" : "RowSelector"}
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
      {settingsOpen ? (
        <GridSettingsDialog columns={columns} state={state}
          onConfirm={(patch) => { onStateChange?.(patch); setSettingsOpen(false); }}
          onClose={() => setSettingsOpen(false)} />
      ) : null}
    </>
  );
}
