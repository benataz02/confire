import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Button, DynamicPage, DynamicPageHeader, DynamicPageTitle, MessageStrip } from "@ui5/webcomponents-react";
import { resolveColumns, resolveFilters, udfColumns, type Constraints } from "../metadata.ts";
import {
  buildPool, decodeFilters, encodeFilters, resolveListState, toQuery, useViews,
} from "../views.ts";
import type { ListData } from "../useListView.ts";
import { FilterHeader, ViewTitle, type FilterTemplate } from "./FilterHeader.tsx";
import { Grid, type CellTemplate, type GridState, type Selection } from "./Grid.tsx";
import type { ListFeature, ListQuery, Row, ViewState } from "../types.ts";

// app-list-report (LIST-REPORT-OBJECT-PAGE.md §3): a declared list — columns, filters, system
// views — over whatever the page pages. The view state (one combined variant: layout + filters)
// lives here; the page only hears the query it implies (`onQuery`) and hands back the rows.

// Trims the title bar to the view selector's own height; the default padding and 4rem min-height
// leave dead space above and below it. ponytail: private theme vars, revisit if they get renamed.
const titleStyle = {
  "--_ui5_dynamic_page_title_padding_top": "0.25rem",
  "--_ui5_dynamic_page_title_padding_bottom": "0.25rem",
  "--_ui5_dynamic_page_title_min_height": "2rem",
  "--_ui5_dynamic_page_title_heading_padding_top": "0",
} as CSSProperties;

export function ListReport({
  feature, constraints, data, onQuery, keyOf, toolbarActions, headerActions, readOnly, localViews,
  showSearch = true, cellTemplates, filterTemplates, footer, error,
}: {
  feature: ListFeature;
  /** B1 lists: metadata fills the columns and adds the UDFs as hidden columns */
  constraints?: Constraints;
  data: ListData;
  /** the query the active view implies, re-sent whenever it changes */
  onQuery: (q: ListQuery) => void;
  keyOf?: (row: Row) => string;
  toolbarActions?: (selection: Selection) => ReactNode;
  /** title bar buttons — a Toolbar, so they overflow */
  headerActions?: ReactElement;
  /** hides Create */
  readOnly?: boolean;
  /** system views only, no server calls (the portal) */
  localViews?: boolean;
  showSearch?: boolean;
  cellTemplates?: Record<string, CellTemplate>;
  filterTemplates?: Record<string, FilterTemplate>;
  /** listReportFooter: a pane under the grid */
  footer?: ReactNode;
  /** an action's failure, shown with the list's own */
  error?: Error | null;
}) {
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;

  const columns = useMemo(() => {
    const declared = resolveColumns(feature.columns, constraints);
    return [...declared, ...udfColumns(constraints, declared.map((c) => c.key))];
  }, [feature.columns, constraints]);
  const pool = useMemo(
    () => buildPool(resolveFilters(feature.filterFields ?? [], constraints), columns),
    [feature.filterFields, constraints, columns],
  );

  const resolve = useCallback((s: Partial<ViewState> | null) => resolveListState(s, columns, pool), [columns, pool]);
  // On first load the URL wins over the view's own filter values — a shared link or a Back from a
  // record restores what was on screen — and the view then shows as changed.
  const searchAtMount = useRef(search);
  const initial = useCallback((s: ViewState) => {
    const fromUrl = decodeFilters(searchAtMount.current, pool);
    return fromUrl ? { ...s, ...fromUrl } : s;
  }, [pool]);
  const views = useViews<ViewState>({ tableId: feature.tableId, systemViews: feature.systemViews, resolve, initial, local: localViews });
  const state = views.state;

  // The page refetches only when the query changes — not on a resize, a rename or a reorder.
  const queryJson = state ? JSON.stringify(toQuery(state, pool)) : null;
  useEffect(() => {
    if (queryJson) onQuery(JSON.parse(queryJson) as ListQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryJson]);

  // Go, Clear, a view switch and Restore all land here: the URL follows the applied filters.
  const urlJson = state ? JSON.stringify(encodeFilters(state, pool)) : null;
  useEffect(() => {
    if (!urlJson) return;
    void navigate({ to: ".", search: JSON.parse(urlJson) as never, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlJson]);

  const setGrid = useCallback((patch: Partial<GridState>) => views.setState((s) => ({ ...s, ...patch })), [views.setState]);
  const applyFilters = useCallback(
    (next: Pick<ViewState, "adaptFilterKeys" | "filterValues" | "searchTerm">) => views.setState((s) => ({ ...s, ...next })),
    [views.setState],
  );

  const restore = views.dirty && views.active?.visibility === "system" ? views.restore : undefined;
  const err = data.error ?? views.error ?? error;

  return (
    <DynamicPage
      hidePinButton
      titleArea={
        <DynamicPageTitle
          heading={<ViewTitle title={feature.title} views={views} />}
          snappedHeading={<ViewTitle title={feature.title} views={views} />}
          style={titleStyle}
          actionsBar={headerActions}
        />
      }
      headerArea={state ? (
        <DynamicPageHeader>
          <FilterHeader pool={pool} state={state} onApply={applyFilters} onRestore={restore}
            showSearch={showSearch} filterTemplates={filterTemplates} />
        </DynamicPageHeader>
      ) : undefined}
    >
      {/* Flex column so the table gets exactly the leftover height and the page never scrolls.
          DynamicPage's content padding is `1rem 1rem 0`, so the bottom gap is ours to add. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", height: "100%", paddingBottom: "1rem", boxSizing: "border-box" }}>
        {err ? <MessageStrip design="Negative" hideCloseButton>{err.message}</MessageStrip> : null}
        {/* Plain div, not a Card: AutoWithEmptyRows measures this element, so the frame goes on
            the table itself and this box only supplies the height. */}
        <div style={{ flex: 1, minHeight: 0 }}>
          {state ? (
            <Grid
              title={feature.title}
              columns={columns}
              state={state}
              onStateChange={setGrid}
              epoch={views.epoch}
              rows={data.rows}
              total={data.total}
              loading={data.loading}
              hasMore={data.hasMore}
              onLoadMore={data.onLoadMore}
              loadAll={data.loadAll}
              keyOf={keyOf}
              selectionMode={toolbarActions ? "Multiple" : "None"}
              onRowClick={data.onRowClick}
              cellTemplates={cellTemplates}
              exportName={feature.title}
              toolbarActions={(sel) => (
                <>
                  {data.onCreate && !readOnly ? (
                    <Button design="Transparent" icon="add" onClick={data.onCreate}>Create</Button>
                  ) : null}
                  {toolbarActions?.(sel)}
                </>
              )}
            />
          ) : null}
        </div>
        {footer}
      </div>
    </DynamicPage>
  );
}
