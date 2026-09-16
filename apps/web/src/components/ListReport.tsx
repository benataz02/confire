import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DynamicPage, DynamicPageHeader, DynamicPageTitle,
  FilterBar, FilterGroupItem, VariantManagement, VariantItem,
  AnalyticalTable, Bar, Title, Input, MultiComboBox, MultiComboBoxItem, DatePicker,
  Button, Dialog, CheckBox, IllustratedMessage,
  Table, TableHeaderRow, TableHeaderCell, TableRow, TableCell,
  MessageStrip, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import type { AnalyticalTablePropTypes } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { client, orpc } from "../orpc.ts";
import {
  truthy, visibleColumns, formatCell, isTextType, boolFilterState, nextBoolFilter, optionFilterValues,
  type FilterCond, type FilterOp, type ListColumn, type ListSpec, type ListVariantDef,
} from "../variants.ts";

type Row = Record<string, unknown>;

export type ListReportProps = {
  listSpec: ListSpec;
  /** shown in the count bar, e.g. "Configurations" */
  title: string;
  columns: ListColumn[];
  /** field holding the row's identity, used for the row-click callback */
  keyField: string;
  rows: Row[];
  /** B1: server-side count. Local: rows.length after applySpec, so the bar reflects the filter. */
  total: number;
  loading?: boolean;
  error?: { message: string } | null;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onRowClick: (row: Row) => void;
  /** Every button in the table's count bar, in render order. Called with the current selection,
   *  so a page-level action (New …) and a selection-driven one (Duplicate, Delete) are the same
   *  kind of thing here — ListReport never learns what any of them do. `clear` exists because the
   *  selection is this component's state: react-table keys it by row *index*, so after a delete
   *  the surviving rows shift under the old ids and the caller must be able to reset it. */
  actions?: (selection: { rows: Row[]; clear: () => void }) => ReactNode;
};

const NO_SELECTION: { ids: Record<string, boolean>; rows: Row[] } = { ids: {}, rows: [] };

// Trims the title bar down to the variant switcher's own height: the default padding and 4rem
// min-height leave dead space above and below it. Skip this on B1 lists — the refresh ToolbarButton
// needs the stock row. // ponytail: private theme vars, revisit if they get renamed.
const titleStyle = {
  "--_ui5_dynamic_page_title_padding_top": "0.25rem",
  "--_ui5_dynamic_page_title_padding_bottom": "0.25rem",
  "--_ui5_dynamic_page_title_min_height": "2rem",
  "--_ui5_dynamic_page_title_heading_padding_top": "0",
} as CSSProperties;

const tableStyle: CSSProperties = {
  maxHeight: "100%",
  boxSizing: "border-box",
  overflow: "hidden",
  borderRadius: "var(--sapElement_BorderCornerRadius)",
};

// ---------------------------------------------------------------------------------------------
// Why this file is four components rather than one.
//
// Nothing in UI5's React layer is memo()'d — AnalyticalTable, FilterBar, FilterGroupItem and
// VariantManagement are all plain forwardRef — so one render of the page walks the entire
// floorplan. The state here is three unrelated things: a filter-bar keystroke has nothing to say
// to the table, and a row checkbox has nothing to say to the filter bar. So each owns its own
// state and sits behind memo(), and the props that cross a boundary are the stable ones
// (`useListSpec` hands out useCallback'd handlers for exactly this reason) — never the `listSpec`
// object itself, which is a fresh object every render of the page.
//
// memo(), not a useMemo'd element: withWebComponent cloneElement()s every slot value on every
// render to stamp `slot="headerArea"` on it, so element identity never survives the trip and
// React's identity bailout is unavailable for anything passed as titleArea/headerArea.
// ---------------------------------------------------------------------------------------------

type ListVariantsProps = {
  /** filled in by DynamicPageTitle's slot handling — forward it or the element never gets slotted */
  slot?: string;
  entity: string;
  variants: ListSpec["variants"];
  selectedName: string;
  spec: ListVariantDef;
  dirty: boolean;
  isAdmin: boolean;
  setSelectedName: (name: string) => void;
  applyVariant: (name: string) => void;
  applyDefault: (exclude?: string[]) => void;
  save: ListSpec["save"]["mutate"];
  remove: ListSpec["remove"]["mutate"];
};

const ListVariants = memo(function ListVariants({
  slot, entity, variants, selectedName, spec, dirty, isAdmin,
  setSelectedName, applyVariant, applyDefault, save, remove,
}: ListVariantsProps) {
  // VariantManagement copies its children into state from a useEffect keyed on the children array,
  // so an unmemoised `variants.map` costs an extra render plus three dependent effects every time
  // this component renders — including the renders where only `dirty` flipped.
  const items = useMemo(
    () =>
      variants.map((v) => (
        <VariantItem
          key={v.id}
          selected={selectedName === v.name}
          isDefault={v.isDefault}
          global={v.shared}
          author={v.author}
          readOnly={!v.canManage || v.isStandard}
          hideDelete={!v.canManage || v.isStandard}
        >
          {v.name}
        </VariantItem>
      )),
    [variants, selectedName],
  );

  return (
    <VariantManagement
      slot={slot}
      closeOnItemSelect
      dirtyState={dirty}
      hideShare={!isAdmin}
      hideApplyAutomatically
      onSelect={(e) => applyVariant(String(e.detail.selectedVariant.children))}
      onSaveAs={(e) => {
        const d = e.detail;
        const name = String(d.children);
        save(
          { page: "list", entity, name, definition: spec, shared: truthy(d.global), isDefault: truthy(d.isDefault) },
          { onSuccess: () => setSelectedName(name) },
        );
      }}
      onSave={() => {
        const row = variants.find((v) => v.name === selectedName);
        if (row) save({ id: row.id, page: "list", entity, name: row.name, definition: spec, shared: row.shared, isDefault: row.isDefault });
      }}
      // VariantManagement keys its rows by name and reads `selected` only on first paint, so both
      // branches here have to move `selectedName` themselves — otherwise Save looks up a name that
      // no longer exists and silently writes nothing.
      onSaveManageViews={(e) => {
        const deleted = e.detail.deletedVariants.map((d) => String(d.children));
        for (const name of deleted) {
          const r = variants.find((v) => v.name === name);
          if (r) remove({ id: r.id });
        }
        for (const up of e.detail.updatedVariants) {
          const prevName = up.prevVariant?.children ? String(up.prevVariant.children) : String(up.children);
          const r = variants.find((v) => v.name === prevName);
          // Belt-and-suspenders: readOnly already blocks this in the dialog, but never rename Standard.
          if (!r || r.isStandard) continue;
          const name = String(up.children);
          save({ id: r.id, page: "list", entity, name, definition: r.definition as ListVariantDef, shared: truthy(up.global), isDefault: truthy(up.isDefault) });
          if (selectedName === prevName) setSelectedName(name);
        }
        // The applied view was deleted: fall back the same way the initial load does. `deleted` is
        // excluded by name because the variants query has not refetched yet.
        if (deleted.includes(selectedName)) applyDefault(deleted);
      }}
    >
      {items}
    </VariantManagement>
  );
});

type ListFiltersProps = {
  /** filled in by DynamicPage's slot handling — forwarded to DynamicPageHeader */
  slot?: string;
  cols: ListColumn[];
  keyField: string;
  /** the *applied* query (spec.filter / spec.search). The bar's own values are `filterDraft`. */
  filter: FilterCond[];
  search: string | undefined;
  filterBar: string[] | undefined;
  setSpec: ListSpec["setSpec"];
  applyVariant: (name: string) => void;
  selectedName: string;
};

// Owns the draft so a keystroke stops here: nothing above re-renders until Go.
const ListFilters = memo(function ListFilters({
  slot, cols, keyField, filter, search, filterBar, setSpec, applyVariant, selectedName,
}: ListFiltersProps) {
  // FilterBar has no liveMode: values live here until Go. spec.filter/search stay the applied query.
  const [filterDraft, setFilterDraft] = useState<{ filter: FilterCond[]; search: string }>(
    () => ({ filter, search: search ?? "" }),
  );

  // Variant / Restore rewrite spec.filter|search; copy that into the bar so the fields match the query.
  useEffect(() => {
    setFilterDraft({ filter, search: search ?? "" });
  }, [filter, search]);

  const setDraftCond = (field: string, op: FilterOp, value: FilterCond["value"] | "") =>
    setFilterDraft((d) => {
      const rest = d.filter.filter((c) => c.field !== field);
      const empty = value === "" || value == null || (Array.isArray(value) && !value.length);
      return { ...d, filter: empty ? rest : [...rest, { field, op, value }] };
    });

  // `search` is dropped when empty, not written as "": the seeded Standard has no `search` key at
  // all, so writing one would make a Go that changed nothing report the view as unsaved.
  const applyFilters = (over: Partial<ListVariantDef> = {}) => {
    const { filter: draftFilter, search: draftSearch } = filterDraft;
    setSpec(({ search: _drop, ...s }) => ({ ...s, filter: draftFilter, ...(draftSearch ? { search: draftSearch } : {}), ...over }));
  };

  // One FilterGroupItem per column. Text/key columns are shown in the bar; the rest live in the
  // "Adapt Filters" dialog (hiddenInFilterBar) so the bar isn't a wall of inputs.
  // ponytail: an element is built for every column even though FilterBar throws away the hidden
  // ones — it needs the full set to populate Adapt Filters. ~90 element allocations on a B1 sales
  // document; build the hidden half lazily only if a profile says it matters.
  const filterItems = cols.map((c) => {
    const cond = filterDraft.filter.find((f) => f.field === c.name);
    const isBool = /bool/i.test(c.type);
    const isDate = /date|time/i.test(c.type);
    const isNum = /int|double|decimal|single|byte|number/i.test(c.type);
    // Visibility is part of the view: an explicit filterBar set wins; else a default heuristic.
    // An active filter is always shown so its value can't hide off-screen.
    const bar = filterBar ?? [];
    const inBar = (bar.length ? bar.includes(c.name) : c.name === keyField || !!c.options || isTextType(c.type)) || !!cond;
    let control;
    if (c.options) {
      // One value stays `eq` so a saved single-status view (e.g. Requested) is not dirtied by Go.
      control = (
        <MultiComboBox
          filter="Contains"
          selectedValues={optionFilterValues(cond)}
          onSelectionChange={(e) => {
            const values = e.detail.items.flatMap((i) => (i.value ? [i.value] : []));
            if (values.length <= 1) setDraftCond(c.name, "eq", values[0] ?? "");
            else setDraftCond(c.name, "in", values);
          }}
        >
          {c.options.map((o) => (
            <MultiComboBoxItem key={o.value} text={o.text} value={o.value} />
          ))}
        </MultiComboBox>
      );
    } else if (isBool) {
      // A boolean is a checkbox here too, not a dropdown — but a filter has a third state the
      // field doesn't: unfiltered. Hence indeterminate, cycling Any -> Yes -> No, with the text
      // saying which one you are on.
      const on = boolFilterState(cond);
      control = (
        <CheckBox
          checked={on === true}
          indeterminate={on === undefined}
          text={on === undefined ? "Any" : on ? "Yes" : "No"}
          onChange={() => setDraftCond(c.name, "eq", nextBoolFilter(on))}
        />
      );
    } else if (isDate) {
      // ISO so the server-side OData $filter literal is valid (B1 dates are unquoted ISO).
      control = <DatePicker displayFormat="yyyy-MM-dd" value={cond ? String(cond.value) : ""} onChange={(e) => setDraftCond(c.name, "eq", e.detail.value)} />;
    } else {
      control = (
        <Input
          type={isNum ? "Number" : "Text"}
          value={cond ? String(cond.value) : ""}
          onInput={(e) => setDraftCond(c.name, isNum ? "eq" : "contains", isNum ? Number(e.target.value) : e.target.value)}
        />
      );
    }
    return (
      <FilterGroupItem key={c.name} filterKey={c.name} label={c.label ?? c.name} active={!!cond} hiddenInFilterBar={!inBar}>
        {control}
      </FilterGroupItem>
    );
  });

  return (
    <DynamicPageHeader slot={slot}>
      <FilterBar
        hideToolbar
        enableReordering
        showGoOnFB
        showClearOnFB
        onGo={() => applyFilters()}
        onClear={() => setFilterDraft({ filter: [], search: "" })}
        // Adapt Filters Go: persist which filters are in the bar, and apply values like the bar Go.
        onFiltersDialogSave={(e) => {
          const keys = e.detail.selectedFilterKeys;
          applyFilters(Array.isArray(keys) ? { filterBar: keys as string[] } : {});
        }}
        // Restore = discard unsaved changes, revert to the selected view.
        onRestore={() => applyVariant(selectedName)}
        search={<Input placeholder="Search" value={filterDraft.search} onInput={(e) => setFilterDraft((d) => ({ ...d, search: e.target.value }))} />}
      >
        {filterItems}
      </FilterBar>
    </DynamicPageHeader>
  );
});

type ColumnsDialogProps = {
  open: boolean;
  cols: ListColumn[];
  visibleCols: string[];
  labels: Record<string, string> | undefined;
  onConfirm: (select: string[], labels?: Record<string, string>) => void;
  onClose: () => void;
};

// A draft copy of visibility/order/labels; only Confirm touches spec. Owning the draft here is what
// keeps a rename keystroke off the table and the filter bar.
const ColumnsDialog = memo(function ColumnsDialog({
  open, cols, visibleCols, labels, onConfirm, onClose,
}: ColumnsDialogProps) {
  const [draft, setDraft] = useState<{ name: string; visible: boolean; label: string }[] | null>(null);

  // Seeded on open, dropped on close. cols/visibleCols/labels are deliberately *not* deps: the
  // draft is a snapshot taken when the dialog opened, not a live mirror of the view.
  useEffect(() => {
    if (!open) return setDraft(null);
    const hidden = cols.map((c) => c.name).filter((n) => !visibleCols.includes(n));
    setDraft(
      [...visibleCols, ...hidden].map((name) => ({
        name,
        visible: visibleCols.includes(name),
        label: labels?.[name] ?? cols.find((c) => c.name === name)?.label ?? name,
      })),
    );
  }, [open]);

  const confirm = () => {
    if (!draft) return onClose();
    const order = draft.filter((d) => d.visible).map((d) => d.name);
    const schemaOrder = cols.map((c) => c.name);
    const isDefaultOrder = order.length === schemaOrder.length && order.every((n, i) => n === schemaOrder[i]);
    const renamed = Object.fromEntries(
      draft.filter((d) => d.label !== (cols.find((c) => c.name === d.name)?.label ?? d.name)).map((d) => [d.name, d.label]),
    );
    // Same rule as `search`: no renames means no `labels` key, not an empty one.
    onConfirm(isDefaultOrder ? [] : order, Object.keys(renamed).length ? renamed : undefined);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      headerText="Columns"
      style={{ width: 480 }}
      footer={
        <Bar
          endContent={
            <>
              <Button design="Emphasized" onClick={confirm}>Confirm</Button>
              <Button design="Transparent" onClick={onClose}>Cancel</Button>
            </>
          }
        />
      }
    >
      {draft ? (
        <Table
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell>Visible</TableHeaderCell>
              <TableHeaderCell>Label</TableHeaderCell>
            </TableHeaderRow>
          }
          onMoveOver={(e) => e.preventDefault()}
          onMove={(e) => {
            const src = (e.detail.source.element as unknown as { rowKey?: string } | null)?.rowKey;
            const dst = (e.detail.destination.element as unknown as { rowKey?: string } | null)?.rowKey;
            if (!src || !dst || src === dst) return;
            setDraft((cur) => {
              if (!cur) return cur;
              const next = [...cur];
              const from = next.findIndex((d) => d.name === src);
              if (from < 0) return cur;
              const moved = next.splice(from, 1)[0]!;
              let to = next.findIndex((d) => d.name === dst);
              if (to < 0) return cur;
              if (e.detail.destination.placement === "After") to += 1;
              next.splice(to, 0, moved);
              return next;
            });
          }}
        >
          {draft.map((d) => (
            <TableRow key={d.name} rowKey={d.name} movable>
              <TableCell>
                <CheckBox checked={d.visible} onChange={() => setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, visible: !x.visible } : x)))} />
              </TableCell>
              <TableCell>
                <Input
                  value={d.label}
                  onInput={(e) => {
                    const v = e.target.value;
                    setDraft((cur) => cur!.map((x) => (x.name === d.name ? { ...x, label: v } : x)));
                  }}
                />
              </TableCell>
            </TableRow>
          ))}
        </Table>
      ) : null}
    </Dialog>
  );
});

// The one list-report floorplan: DynamicPage + VariantManagement + FilterBar over an AnalyticalTable.
// A saved view (variant) IS the query — select/filter/orderby/search are executed by the caller
// (OData for B1 entities, applySpec for local arrays) and this component does NO client-side
// processing (manualSortBy/manualFilters), so both sources behave identically.
export function ListReport({
  listSpec, title, columns: cols, keyField, rows, total,
  loading, error, hasMore, onLoadMore, onRowClick, actions,
}: ListReportProps) {
  const { entity, spec, setSpec, variants, selectedName, setSelectedName, applyVariant, applyDefault, dirty, isAdmin, readOnly, save, remove } = listSpec;
  const b1 = entity.startsWith("b1:") ? entity.slice(3) : "";
  const qc = useQueryClient();
  // ponytail: the title bar is here, so the button is here. Portal lists are `portal:`, not `b1:`.
  // refetch() alone would return the same cached row — the re-read has to be asked for.
  const refresh = useMutation({
    mutationFn: () => client.entities.schema({ entity: b1, refresh: true }),
    onSuccess: (fresh) => {
      qc.setQueryData(orpc.entities.schema.queryOptions({ input: { entity: b1 } }).queryKey, fresh);
    },
  });
  const err = error ?? refresh.error;

  const [selected, setSelected] = useState(NO_SELECTION);
  const [columnsOpen, setColumnsOpen] = useState(false);

  const visibleCols = useMemo(() => visibleColumns(spec, cols), [spec.select, cols]);

  const columns = useMemo(
    () =>
      visibleCols
        .map((n) => cols.find((c) => c.name === n))
        .filter((c): c is ListColumn => !!c)
        .map((c) => ({
          id: c.name,
          Header: spec.labels?.[c.name] ?? c.label ?? c.name,
          // A custom Cell wants the raw value; everything else is pre-formatted to a string.
          accessor: c.Cell ? c.name : (row: Row) => formatCell(row[c.name], c.type),
          ...(c.Cell ? { Cell: c.Cell } : {}),
        })),
    // Not the whole `spec`: `columns` identity is the one prop UI5 documents as a full table
    // re-render, and only these two parts of the view can change what a column is.
    [visibleCols, spec.labels, cols],
  );

  // Server-side everything: no client sort/filter, and don't reset table state as rows append.
  const reactTableOptions = useMemo(
    () => ({
      autoResetSortBy: false, autoResetFilters: false, autoResetSelectedRows: false,
      autoResetPage: false, autoResetHiddenColumns: false,
      manualSortBy: true, manualFilters: true, manualGlobalFilter: true,
      // Columns are sized by the view, not by dragging. useColumnResizing reads this table-level
      // flag, so no resizer handle is rendered on any header and there is no width state to persist.
      disableResizing: true,
    }),
    [],
  );

  // ponytail: identity changes remount the (stateless) illustration; title is stable per page.
  const NoDataComponent = useMemo(
    () =>
      function NoData({ noDataReason }: { noDataReason: "Empty" | "Filtered" }) {
        return noDataReason === "Filtered" ? (
          <IllustratedMessage name="NoData" design="Auto" titleText="Nothing in this view"
            subtitleText="Try a different filter or pick another view." />
        ) : (
          <IllustratedMessage name="NoData" design="Auto" titleText={`No ${title.toLowerCase()} yet`} />
        );
      },
    [title],
  );

  // Stable so ColumnsDialog's memo holds — setSpec is a useState setter, so these never change.
  const closeColumns = useCallback(() => setColumnsOpen(false), []);
  const confirmColumns = useCallback(
    (select: string[], labels?: Record<string, string>) => {
      setSpec(({ labels: _drop, ...s }) => ({ ...s, select, ...(labels ? { labels } : {}) }));
      setColumnsOpen(false);
    },
    [setSpec],
  );

  // These three close over nothing but state setters, so they can be stable — unlike onRowClick /
  // onLoadMore / actions, which are the caller's closures and are fresh on every page render.
  const handleRowSelect = useCallback<NonNullable<AnalyticalTablePropTypes["onRowSelect"]>>((e) => {
    const ids = e.detail.selectedRowIds ?? {};
    const byId = e.detail.rowsById ?? {};
    // rowsById carries the originals, so bulk actions never re-derive ids from the DOM.
    setSelected({ ids, rows: Object.keys(ids).filter((k) => ids[k]).map((k) => byId[k]?.original as Row).filter(Boolean) });
  }, []);
  // Sort routes to the caller's query, not client-side (manualSortBy). Single-column for v1.
  // ponytail: multi-sort -> push each into orderby instead of replacing.
  const handleSort = useCallback<NonNullable<AnalyticalTablePropTypes["onSort"]>>((e) => {
    const col = (e.detail.column as { id?: string }).id;
    const dir = e.detail.sortDirection;
    if (!col) return;
    setSpec((s) => ({ ...s, orderby: dir === "asc" || dir === "desc" ? [{ field: col, dir }] : [] }));
  }, [setSpec]);
  const handleColumnsReorder = useCallback<NonNullable<AnalyticalTablePropTypes["onColumnsReorder"]>>((e) => {
    const order = e.detail.columnsNewOrder.map((c) => (c as { id?: string }).id).filter((id): id is string => !!id);
    if (order.length) setSpec((s) => ({ ...s, select: order }));
  }, [setSpec]);

  // No save, no Save As, no Manage Views for a user who cannot own a view — a variant switcher
  // with one entry and every action disabled is worse than a plain title.
  const heading = readOnly ? (
    <Title level="H4">{title}</Title>
  ) : (
    <ListVariants
      entity={entity} variants={variants} selectedName={selectedName} spec={spec}
      dirty={dirty} isAdmin={isAdmin} setSelectedName={setSelectedName}
      applyVariant={applyVariant} applyDefault={applyDefault} save={save.mutate} remove={remove.mutate}
    />
  );

  const countBar = (
    <Bar
      startContent={<Title level="H5">{title} ({selected.rows.length}/{total})</Title>}
      endContent={
        <>
          {actions?.({ rows: selected.rows, clear: () => setSelected(NO_SELECTION) })}
          <Button icon="action-settings" design="Transparent" onClick={() => setColumnsOpen((o) => !o)}></Button>
        </>
      }
    />
  );

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={heading}
          snappedHeading={heading}
          style={titleStyle}
          actionsBar={b1 ? (
            <Toolbar design="Transparent">
              <ToolbarButton design="Transparent" icon="refresh" tooltip="Refresh schema"
                accessibleName="Refresh schema" disabled={refresh.isPending}
                onClick={() => refresh.mutate()} />
            </Toolbar>
          ) : undefined}
        />
      }
      headerArea={
        <ListFilters
          cols={cols} keyField={keyField} filter={spec.filter} search={spec.search}
          filterBar={spec.filterBar} setSpec={setSpec} applyVariant={applyVariant}
          selectedName={selectedName}
        />
      }
    >
      {/* Flex column so the table gets exactly the leftover height and the page never scrolls.
          DynamicPage's content padding is `1rem 1rem 0`, so the bottom gap is ours to add — as
          padding here, not a margin below the table, which would overflow the 100% again. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", height: "100%", paddingBottom: "1rem", boxSizing: "border-box" }}>
        {err ? <MessageStrip design="Negative" hideCloseButton>{err.message}</MessageStrip> : null}
        {/* Plain div, not a Card: AutoWithEmptyRows measures this element and the table ends up a
            whole number of rows short of it, so the frame goes on the table itself — otherwise the
            rounded bottom floats below the last row. This box only supplies the height. */}
        <div style={{ flex: 1, minHeight: 0 }}>
        <AnalyticalTable
          columns={columns}
          data={rows}
          reactTableOptions={reactTableOptions}
          // What Card gave us: --_ui5_card_border + rounded corners, clipped so the header/last row
          // don't square them off. maxHeight absorbs the 2px the border adds to the measured fit.
          style={tableStyle}
          extension={countBar}
          loading={loading}
          minRows={1}
          visibleRowCountMode="AutoWithEmptyRows"
          // onLoadMore has exactly one source: a native scroll event on the table body. Under
          // AutoWithEmptyRows the body is padded to *exactly* the visible row count, so a page that
          // fits leaves scrollHeight === clientHeight and there is nothing to scroll — the event can
          // never fire. additionalEmptyRowsCount is UI5's documented answer; it only applies while
          // the table isn't scrollable, so it costs nothing once real data overflows, and gating it
          // on hasMore keeps the last page free of phantom rows.
          infiniteScroll={!!onLoadMore}
          additionalEmptyRowsCount={hasMore ? 5 : 0}
          // Default is 20, which against a 100-row page means the first fetch only starts ~80 rows
          // down. Half a page of lead time instead.
          infiniteScrollThreshold={40}
          NoDataComponent={NoDataComponent}
          // Passed straight through, not wrapped in `if (hasMore)`: UI5 records the row count in its
          // fired-once set whether or not we act on the event, so swallowing one here disarms the
          // trigger for good at that length. Callers guard re-entry with isFetchingNextPage.
          // ponytail: UI5's `lastScrollTop` is a high-water mark, not a previous position, so after
          // scrolling up there's a dead zone until you pass the deepest offset reached before. It
          // self-heals on the next page; fixing it would mean owning the scroll handler.
          onLoadMore={onLoadMore}
          selectedRowIds={selected.ids}
          onRowSelect={handleRowSelect}
          // UI5 only suppresses onRowClick when the checkbox itself is hit; the padding around it
          // is the cell div, which still navigates. Walk up to the cell instead.
          onRowClick={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.('[data-selection-cell="true"]')) return;
            onRowClick(e.detail.row.original as Row);
          }}
          onSort={handleSort}
          onColumnsReorder={handleColumnsReorder}
          selectionBehavior="Row"
          selectionMode="Multiple"
          sortable
          />
        </div>
      </div>
      <ColumnsDialog
        open={columnsOpen}
        cols={cols}
        visibleCols={visibleCols}
        labels={spec.labels}
        onConfirm={confirmColumns}
        onClose={closeColumns}
      />
    </DynamicPage>
  );
}
