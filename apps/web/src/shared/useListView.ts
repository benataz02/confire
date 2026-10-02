import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  keepPreviousData, useInfiniteQuery,
  type InfiniteData, type InfiniteQueryObserverResult, type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { entityPath } from "./navigation.ts";
import type { Row } from "./types.ts";

// BaseListView (LIST-REPORT-OBJECT-PAGE.md §2): the paged rows a ListReport shows, plus the
// row-click and create navigation every list repeats. One hook instead of the infinite-query
// boilerplate each list page used to carry.

/** ponytail: grouped views and the .xlsx export load at most 5 000 rows; server-side aggregation
 *  if a tenant outgrows it. */
export const LOAD_ALL_CAP = 5_000;

type Page = { rows: Row[]; total?: number };

export type ListData = {
  rows: Row[];
  total: number;
  loading: boolean;
  error: Error | null;
  hasMore: boolean;
  onLoadMore: () => void;
  /** every page up to the cap — grouping and export need the whole result, not what scrolled in */
  loadAll: () => Promise<Row[]>;
  onRowClick?: (row: Row) => void;
  onCreate?: () => void;
};

const flatten = (data: InfiniteData<Page> | undefined) => (data?.pages ?? []).flatMap((p) => p.rows);

/**
 * `options` is an oRPC `infiniteOptions(...)` (or any infinite-query options whose pages carry
 * `rows`). `nav`: where a row opens (`entityPath(route, keyOf(row))`) and, with `create`, where
 * Create goes (`route#create`, the createModeMatch of Beas).
 */
export function useListView(options: object, nav?: { route: string; keyOf: (row: Row) => unknown; create?: boolean }): ListData {
  const navigate = useNavigate();
  const page = useInfiniteQuery({
    retry: false,
    placeholderData: keepPreviousData,
    ...options,
  } as never) as UseInfiniteQueryResult<InfiniteData<Page>, Error>;
  const rows = useMemo(() => flatten(page.data), [page.data]);

  const loadAll = useCallback(async () => {
    let res: InfiniteQueryObserverResult<InfiniteData<Page>, Error> = page;
    while (res.hasNextPage && flatten(res.data).length < LOAD_ALL_CAP) res = await res.fetchNextPage();
    return flatten(res.data).slice(0, LOAD_ALL_CAP);
  }, [page]);

  return {
    rows,
    total: page.data?.pages[0]?.total ?? rows.length,
    loading: page.isFetching && !page.isFetchingNextPage,
    error: page.error,
    hasMore: page.hasNextPage,
    // Passed straight through: the table records the row count it fired at whether or not we act,
    // so a swallowed call would disarm the trigger for good — re-entry is guarded here instead.
    onLoadMore: () => { if (!page.isFetchingNextPage) void page.fetchNextPage(); },
    loadAll,
    ...(nav
      ? {
          onRowClick: (row: Row) => {
            const key = nav.keyOf(row);
            if (key !== undefined && key !== null && key !== "") void navigate({ href: entityPath(nav.route, key) });
          },
          ...(nav.create ? { onCreate: () => void navigate({ href: `${nav.route}#create` }) } : {}),
        }
      : {}),
  };
}
