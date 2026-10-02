import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bar, Button, Dialog } from "@ui5/webcomponents-react";
import { meQuery, orpc } from "../../orpc.ts";
import { resolveColumns, useFieldConstraints } from "../metadata.ts";
import { buildPool, defaultState, mergeKnownColumns, toQuery } from "../views.ts";
import { useListView } from "../useListView.ts";
import { FilterHeader } from "../list-report/FilterHeader.tsx";
import { Grid, type GridState } from "../list-report/Grid.tsx";
import { fetchPage, sourceKey } from "./cfl-provider.ts";
import { keyFieldOf } from "./cfl-configs.ts";
import type { CflDialogConfig, FilterValue, ListColumn, Row, ViewState } from "../types.ts";

// beas-cfl-dialog (VALUE-HELP-AND-KEY-NAVIGATION.md §4): the full value help. The same filter bar
// and grid a list report uses, inside a Dialog, over the value help's source. Lazy-loaded by
// CflField — most fields are never opened.
//
// Deviation from Beas: the grid's layout (columns, widths, Adapt Filters) is one per-user state
// under `cfl:<source>`, not named views. ponytail: add named views to the dialog if asked.

type Layout = Partial<Pick<ViewState, "columns" | "knownColumns" | "columnWidths" | "adaptFilterKeys">>;

const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 600px)").matches;

export default function CflDialog({ config, initialSearch, multiSelect, onSelect, onClose }: {
  config: CflDialogConfig;
  initialSearch: string;
  multiSelect: boolean;
  onSelect: (rows: Row[]) => void;
  onClose: () => void;
}) {
  const key = keyFieldOf(config);
  const src = config.source;
  const role = useQuery(meQuery).data?.role;
  // A portal client has no user-state endpoint (userProcedure fences them out): its layout lives
  // for the dialog's lifetime. ponytail: persist it too if portal users ask.
  const persist = role !== undefined && role !== "client";
  const stateKey = `cfl:${sourceKey(src)}`;

  // Every field the entity has but the config did not declare, as a hidden column: Adapt Filters
  // and the settings dialog offer them. A masterdata table's own columns are already all declared.
  const meta = useFieldConstraints(src.kind === "entity" ? src.entitySet : undefined);
  const columns = useMemo<ListColumn[]>(() => {
    const fields = meta.data?.fields;
    const declared = resolveColumns(config.columns, fields);
    const extra = fields
      ? resolveColumns(
          Object.keys(fields)
            .filter((k) => fields[k]!.Type !== "collection" && !declared.some((c) => c.key === k))
            .map((k) => ({ key: k, hidden: true })),
          fields,
        )
      : [];
    return [...declared, ...extra];
  }, [config.columns, meta.data]);

  const showAdapt = config.showAdaptFilters !== false;
  const pool = useMemo(
    () => buildPool(config.filterFields ?? [], showAdapt ? columns.filter((c) => !config.excludeAdaptFilters?.includes(c.key)) : []),
    [config.filterFields, config.excludeAdaptFilters, columns, showAdapt],
  );

  const saved = useQuery({
    ...orpc.views.getState.queryOptions({ input: { key: stateKey } }),
    enabled: persist,
    staleTime: Infinity,
  });
  const [layoutDraft, setLayoutDraft] = useState<Layout | null>(null);
  const layout: Layout = layoutDraft ?? ((saved.data as Layout | null) ?? {});
  const store = useMutation(orpc.views.setState.mutationOptions());
  const setLayout = (next: Layout) => {
    setLayoutDraft(next);
    if (persist) store.mutate({ key: stateKey, value: next });
  };

  const [filters, setFilters] = useState<{ filterValues: Record<string, FilterValue>; searchTerm: string }>(
    { filterValues: {}, searchTerm: initialSearch },
  );
  const [sortBy, setSortBy] = useState<ViewState["sortBy"]>([]);

  const d = defaultState(columns, pool);
  const state: ViewState = {
    ...d,
    columns: layout.columns?.length ? mergeKnownColumns(layout.columns, layout.knownColumns ?? [], columns) : d.columns,
    columnWidths: layout.columnWidths,
    adaptFilterKeys: layout.adaptFilterKeys ?? d.adaptFilterKeys,
    sortBy,
    ...filters,
  };

  const q = toQuery(state, pool);
  // The key, the label columns and every declared column always come back: a pick fills dependent
  // fields from the row, whether or not the user hid that column.
  const select = [...new Set([...q.select, key, ...(config.displayColumns ?? []), ...(config.displayField ? [config.displayField] : []), ...config.columns.map((c) => c.key)])];
  const request = {
    select,
    filter: [...(config.fixedFilters ?? []), ...q.filter],
    orderby: q.orderby,
    ...(q.search ? { search: q.search, searchFields: config.searchFields, mode: "contains" as const } : {}),
  };
  const list = useListView({
    queryKey: ["cfl-dialog", sourceKey(src), request],
    queryFn: ({ pageParam }: { pageParam: string | number | undefined }) =>
      fetchPage(src, { ...request, cursor: pageParam, count: pageParam === undefined }),
    initialPageParam: undefined as string | number | undefined,
    getNextPageParam: (last: { next?: string | number }) => last.next,
    enabled: src.kind === "masterdata" || !meta.isPending,
  });

  const rowId = (r: Row) => String(r[key] ?? "");
  const [picked, setPicked] = useState<Row[]>([]);
  const highlighted = picked[0];
  const choose = (rows: Row[]) => { if (rows.length) onSelect(rows); };

  const gridState: GridState = { columns: state.columns, labels: {}, sortBy, groupBy: [], columnWidths: state.columnWidths };

  return (
    <Dialog open onClose={onClose} headerText={config.title} stretch={isPhone()}
      style={{ width: "min(1600px, 95vw)", height: "min(900px, 90vh)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            {config.readOnly ? null : (
              <Button design="Emphasized" disabled={!picked.length} onClick={() => choose(picked)}>
                {multiSelect ? `Select (${picked.length})` : "Select"}
              </Button>
            )}
            <Button design="Transparent" onClick={onClose}>{config.readOnly ? "Close" : "Cancel"}</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: "0.5rem" }}>
        <FilterHeader pool={pool} showAdaptFilters={showAdapt}
          state={{ adaptFilterKeys: state.adaptFilterKeys, filterValues: filters.filterValues, searchTerm: filters.searchTerm }}
          onApply={(next) => {
            setFilters({ filterValues: next.filterValues, searchTerm: next.searchTerm });
            if (next.adaptFilterKeys !== state.adaptFilterKeys) setLayout({ ...layout, adaptFilterKeys: next.adaptFilterKeys });
          }} />
        <div style={{ flex: 1, minHeight: 0 }}>
          <Grid title={config.title} columns={columns} state={gridState} keyOf={rowId}
            rows={list.rows} total={list.total} loading={list.loading} hasMore={list.hasMore} onLoadMore={list.onLoadMore}
            selectionMode={multiSelect ? "Multiple" : config.readOnly && !config.onRowNavigate ? "None" : "Single"}
            selectedIds={multiSelect ? undefined : highlighted ? { [rowId(highlighted)]: true } : {}}
            onSelectionChange={multiSelect ? setPicked : undefined}
            onRowClick={multiSelect ? undefined : (row) => {
              // First click highlights; clicking the highlighted row again selects it — or, with
              // onRowNavigate, closes the dialog and opens the record.
              if (highlighted && rowId(highlighted) === rowId(row)) {
                if (config.onRowNavigate) { onClose(); config.onRowNavigate(row); }
                else if (!config.readOnly) choose([row]);
              } else setPicked([row]);
            }}
            onStateChange={(patch) => {
              if (patch.sortBy) setSortBy(patch.sortBy);
              if (patch.columns || patch.columnWidths)
                setLayout({
                  ...layout,
                  ...(patch.columns ? { columns: patch.columns, knownColumns: columns.map((c) => c.key) } : {}),
                  ...(patch.columnWidths ? { columnWidths: patch.columnWidths } : {}),
                });
            }} />
        </div>
      </div>
    </Dialog>
  );
}
