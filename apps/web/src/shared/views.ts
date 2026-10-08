import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../orpc.ts";
import { isEmptyValue } from "./validation.ts";
import type {
  FilterCond, FilterField, FilterValue, ListColumn, ListQuery, SystemView, ViewState,
} from "./types.ts";

// Saved views (LIST-REPORT-OBJECT-PAGE.md §6), with the grid-view and filter-view payloads in one
// combined state: one choice in the title restores both. System views are declared in code and
// read-only; personal/shared ones come from views.list; the active one is remembered per user.

export type ViewVisibility = "personal" | "shared" | "system";
export type View<S> = {
  id: string;
  name: string;
  visibility: ViewVisibility;
  isDefault: boolean;
  canEdit: boolean;
  /** null = the declared defaults; a system view may hold only part of a state */
  state: Partial<S> | null;
  author?: string;
};

export const STANDARD_ID = "system:default";

/** ks(): declared views as read-only `system:<key>` views, Standard first unless declared. */
export function systemViewsOf<S>(declared: SystemView<S>[] = []): View<S>[] {
  const own: View<S>[] = declared.map((v) => ({
    id: `system:${v.key}`, name: v.name, visibility: "system", isDefault: !!v.isDefault, canEdit: false, state: v.state,
  }));
  if (declared.some((v) => v.key === "default")) return own;
  return [
    { id: STANDARD_ID, name: "Standard", visibility: "system", isDefault: !declared.some((v) => v.isDefault), canEdit: false, state: null },
    ...own,
  ];
}

/** Which view opens: the one this user last had active, then their personal default, then the
 *  shared default, then the declared default (Standard). */
export function pickInitial<S>(views: View<S>[], activeId: string | null | undefined): View<S> {
  return (
    views.find((v) => v.id === activeId) ??
    views.find((v) => v.visibility === "personal" && v.isDefault) ??
    views.find((v) => v.visibility === "shared" && v.isDefault) ??
    views.find((v) => v.visibility === "system" && v.isDefault) ??
    views[0]!
  );
}

// Object keys are sorted and empty objects/undefined dropped before comparing; arrays keep their
// order. `state` is jsonb, and Postgres stores object keys in its own order (by length, then
// bytewise), so a view read back after a Save arrives as {direction, field} where the browser
// wrote {field, direction} — a plain JSON.stringify leaves the dirty asterisk on forever. Array
// order is part of the view: column, sort and filter order mean something.
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return x;
    const entries = Object.entries(x).filter(([, y]) => y !== undefined && !(y && typeof y === "object" && !Array.isArray(y) && !Object.keys(y).length));
    return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
  });
export const sameState = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

// --- list state ---------------------------------------------------------------------------------

/**
 * buildPool (§3.2): every possible filter. Declared filter fields come first, typed by their
 * column where they did not say; then every other filterable column as a HIDDEN auto filter, so
 * Adapt Filters can offer it.
 */
export function buildPool(filterFields: FilterField[], columns: ListColumn[]): FilterField[] {
  const col = (k: string) => columns.find((c) => c.key === k);
  const declared = filterFields.map((f) => {
    const c = col(f.key);
    return {
      ...f,
      label: f.label ?? c?.label ?? f.key,
      type: f.type ?? c?.type,
      ...(f.options ?? c?.options ? { options: f.options ?? c?.options } : {}),
      exact: f.exact ?? c?.exact,
    };
  });
  const auto = columns
    .filter((c) => c.filterable !== false && c.type !== "collection" && !filterFields.some((f) => f.key === c.key))
    .map((c): FilterField => ({
      key: c.key, label: c.label ?? c.key, type: c.type, visible: false,
      ...(c.options ? { options: c.options } : {}), ...(c.exact ? { exact: true } : {}),
    }));
  return [...declared, ...auto];
}

/** A date filter is a from/to range (Beas renders date filters as ranges). */
export const isRangeField = (f: FilterField) => f.type === "date";
/** Options and value-help filters hold several values — an `in`. A value-help filter is
 *  multi-select unless its dialog says `multiSelect: false` (Beas `g()`). */
export const isMultiField = (f: FilterField) =>
  !!f.options || (!!f.cfl && f.cfl.dialogConfig.multiSelect !== false);

const isRange = (v: unknown): v is { from: string; to: string } =>
  !!v && typeof v === "object" && !Array.isArray(v) && "from" in v;

/** A filter value that filters nothing: blank, an empty list, a range with neither end. */
export const isEmptyFilter = (v: unknown): boolean =>
  isEmptyValue(v) || (isRange(v) && !v.from && !v.to);

/** Drop the empty ones, so a Go that changed nothing leaves the view clean. */
export const cleanValues = (values: Record<string, FilterValue>): Record<string, FilterValue> =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => !isEmptyFilter(v)));

/** The declared defaults — what Standard (`state: null`) is. */
export function defaultState(columns: ListColumn[], pool: FilterField[]): ViewState {
  return {
    columns: columns.filter((c) => !c.hidden).map((c) => c.key),
    knownColumns: columns.map((c) => c.key),
    sortBy: [],
    groupBy: [],
    adaptFilterKeys: pool.filter((f) => f.visible !== false).map((f) => f.key),
    filterValues: cleanValues(Object.fromEntries(
      pool.filter((f) => f.defaultValue !== undefined).map((f) => [f.key, f.defaultValue!]),
    )),
    searchTerm: "",
  };
}

/**
 * qc(): a saved column list plus the columns the feature gained since. A non-hidden column the
 * view never knew about is inserted after its nearest preceding neighbour in the feature's own
 * order (or first, if none of those is shown). Columns the feature dropped are dropped.
 */
export function mergeKnownColumns(saved: string[], known: string[], columns: ListColumn[]): string[] {
  const exists = new Set(columns.map((c) => c.key));
  const out = saved.filter((k) => exists.has(k));
  const knew = new Set(known);
  columns.forEach((c, i) => {
    if (c.hidden || knew.has(c.key) || out.includes(c.key)) return;
    for (let j = i - 1; j >= 0; j--) {
      const at = out.indexOf(columns[j]!.key);
      if (at >= 0) {
        out.splice(at + 1, 0, c.key);
        return;
      }
    }
    out.unshift(c.key);
  });
  return out;
}

/** A stored or declared state against today's columns and filters. Only known filter keys survive
 *  (Beas `M()`); `columns: []` in a declared view means "the default visible columns". */
export function resolveListState(
  state: Partial<ViewState> | null, columns: ListColumn[], pool: FilterField[],
): ViewState {
  const d = defaultState(columns, pool);
  if (!state) return d;
  const keys = new Set(pool.map((f) => f.key));
  const colKeys = new Set(columns.map((c) => c.key));
  return {
    ...d,
    ...state,
    columns: state.columns?.length ? mergeKnownColumns(state.columns, state.knownColumns ?? [], columns) : d.columns,
    knownColumns: d.knownColumns,
    sortBy: (state.sortBy ?? d.sortBy),
    groupBy: (state.groupBy ?? d.groupBy).filter((k) => colKeys.has(k)),
    adaptFilterKeys: state.adaptFilterKeys?.length ? state.adaptFilterKeys.filter((k) => keys.has(k)) : d.adaptFilterKeys,
    filterValues: Object.fromEntries(
      Object.entries({ ...d.filterValues, ...state.filterValues }).filter(([k, v]) => keys.has(k) && !isEmptyFilter(v)),
    ),
    searchTerm: state.searchTerm ?? "",
  };
}

/** "2026-01-31" -> "2026-02-01". A range's `to` is compiled as `lt` the next day rather than `le`
 *  the day itself: on a timestamp column (`updatedAt`) `le '2026-01-31'` is midnight and drops the
 *  whole last day; on B1's midnight-only DocDate both forms agree. */
const nextDay = (iso: string): string => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
};

/**
 * The Beas provider's customFilters rules, as a ListQuery: a range is ge/lt, a list is `in`,
 * number/boolean/date/enum are `eq`, a string is `contains` (or `eq` for an exact field). `select`
 * is the visible columns, sorted so a reorder does not change the query key — the server adds the
 * entity keys itself.
 */
export function toQuery(state: ViewState, pool: FilterField[]): ListQuery {
  const filter: FilterCond[] = [];
  for (const f of pool) {
    const v = state.filterValues[f.key];
    if (isEmptyFilter(v)) continue;
    if (isRange(v)) {
      if (v.from) filter.push({ field: f.key, op: "ge", value: v.from });
      if (v.to) filter.push({ field: f.key, op: "lt", value: nextDay(v.to) });
    } else if (Array.isArray(v)) {
      filter.push({ field: f.key, op: "in", value: v });
    } else if (typeof v === "number" || typeof v === "boolean" || ["number", "boolean", "date", "enum"].includes(f.type ?? "")) {
      filter.push({ field: f.key, op: "eq", value: v as string | number | boolean });
    } else {
      filter.push({ field: f.key, op: f.exact ? "eq" : "contains", value: String(v) });
    }
  }
  const search = state.searchTerm.trim();
  return {
    select: [...state.columns].sort(),
    filter,
    orderby: state.sortBy.map((s) => ({ field: s.field, dir: s.direction })),
    ...(search ? { search } : {}),
  };
}

// --- URL codec (R() / C()) ----------------------------------------------------------------------

/** A string the router's JSON-ish search serializer would otherwise quote ("123" -> %22123%22)
 *  goes as the number it already reads as. Leading zeros stay a string: "0001" is not 1. */
const urlScalar = (s: string): string | number | boolean =>
  s === "true" ? true : s === "false" ? false : String(Number(s)) === s ? Number(s) : s;

/** R(): filter values as query params. Ranges `from~to`, lists `a,b`, the search term as
 *  `search`; empty and default values are left out. */
export function encodeFilters(state: Pick<ViewState, "filterValues" | "searchTerm">, pool: FilterField[]) {
  const out: Record<string, string | number | boolean> = {};
  for (const f of pool) {
    const v = state.filterValues[f.key];
    if (isEmptyFilter(v) || (f.defaultValue !== undefined && sameState(v, f.defaultValue))) continue;
    out[f.key] = isRange(v) ? `${v.from}~${v.to}` : Array.isArray(v) ? v.join(",") : urlScalar(String(v));
  }
  const s = state.searchTerm.trim();
  if (s) out.search = urlScalar(s);
  return out;
}

/** C(): query params back to filter values, keys matched case-insensitively. null = nothing in
 *  the URL is a filter, so the view's own values apply. */
export function decodeFilters(
  params: Record<string, unknown>, pool: FilterField[],
): { filterValues: Record<string, FilterValue>; searchTerm: string } | null {
  const lower = new Map(Object.keys(params).map((k) => [k.toLowerCase(), k]));
  const filterValues: Record<string, FilterValue> = {};
  for (const f of pool) {
    const k = lower.get(f.key.toLowerCase());
    const raw = k === undefined || params[k] === null || params[k] === undefined ? "" : String(params[k]);
    if (!raw) continue;
    if (isRangeField(f)) {
      const [from = "", to = ""] = raw.split("~");
      filterValues[f.key] = { from, to };
    } else if (isMultiField(f)) {
      filterValues[f.key] = raw.split(",").filter(Boolean).map((x) => (f.type === "number" ? Number(x) : x));
    } else if (f.type === "boolean") {
      filterValues[f.key] = raw === "true";
    } else if (f.type === "number" && Number.isFinite(Number(raw))) {
      filterValues[f.key] = Number(raw);
    } else {
      filterValues[f.key] = raw;
    }
  }
  const s = lower.get("search");
  const searchTerm = s === undefined || params[s] == null ? "" : String(params[s]);
  return Object.keys(filterValues).length || searchTerm ? { filterValues, searchTerm } : null;
}

// --- the hook -----------------------------------------------------------------------------------

export type ViewsApi<S> = ReturnType<typeof useViews<S>>;

/**
 * The views of one table and the state being worked on. `resolve` turns a view's stored (or
 * declared, possibly partial) state into a full one — the list passes resolveListState, the object
 * page its own. `initial` may rewrite the very first state (the list lets the URL win there).
 * `local`: system views only, no server calls, no save chrome.
 */
export function useViews<S>({ tableId, systemViews, resolve, initial, local = false }: {
  tableId: string;
  systemViews?: SystemView<S>[];
  resolve: (state: Partial<S> | null) => S;
  initial?: (state: S) => S;
  local?: boolean;
}) {
  const qc = useQueryClient();
  const listOpts = orpc.views.list.queryOptions({ input: { tableId } });
  // A failed list is not a broken page: the declared views still work, so it is only "no saved
  // views" — hence isFetched rather than isSuccess as the gate.
  const q = useQuery({ ...listOpts, enabled: !local, retry: false, staleTime: 60_000 });
  const system = useMemo(() => systemViewsOf(systemViews), [systemViews]);
  const views = useMemo<View<S>[]>(
    () => [...system, ...(q.data?.views ?? []).map((v) => ({ ...v, state: v.state as unknown as Partial<S> }))],
    [system, q.data],
  );
  const loaded = local || q.isFetched;

  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setStateRaw] = useState<S | null>(null);
  // Bumped whenever a view is applied wholesale (select, restore): the grid keys on it, so its
  // internal resize/sort state is rebuilt from the view instead of fighting it.
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    if (!loaded || activeId !== null) return;
    const v = pickInitial(views, q.data?.activeId);
    setActiveId(v.id);
    const s = resolve(v.state);
    setStateRaw(initial ? initial(s) : s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // The active view vanished (deleted elsewhere, or by Manage): fall back the way the load does.
  const active = views.find((v) => v.id === activeId) ?? (loaded ? pickInitial(views, null) : undefined);
  const saved = useMemo(() => (active ? resolve(active.state) : null), [active, resolve]);
  // Only an editable view or a system view (which can then be restored) shows the asterisk.
  const dirty = !!active && !!state && !!saved && (active.canEdit || active.visibility === "system") && !sameState(state, saved);

  const invalidate = () => qc.invalidateQueries({ queryKey: listOpts.queryKey });
  const setActive = useMutation(orpc.views.setActive.mutationOptions());
  const create = useMutation(orpc.views.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(orpc.views.update.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.views.remove.mutationOptions({ onSuccess: invalidate }));

  const apply = useCallback((v: View<S>) => {
    setActiveId(v.id);
    setStateRaw(resolve(v.state));
    setEpoch((e) => e + 1);
  }, [resolve]);

  const select = useCallback((id: string) => {
    const v = views.find((x) => x.id === id);
    if (!v) return;
    apply(v);
    if (!local) setActive.mutate({ tableId, id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views, apply, local, tableId]);

  return {
    views,
    active,
    state,
    setState: setStateRaw as (next: S | ((prev: S) => S)) => void,
    dirty,
    /** views loaded and the first state applied — gate the page's query on this */
    ready: state !== null,
    epoch,
    isAdmin: q.data?.isAdmin ?? false,
    local,
    error: create.error ?? update.error ?? remove.error,
    select,
    restore: () => { if (active) apply(active); },
    save: () => {
      if (active?.canEdit && state) update.mutate({ id: active.id, state });
    },
    saveAs: (v: { name: string; visibility: "personal" | "shared"; isDefault: boolean }) => {
      if (!state) return;
      create.mutate({ tableId, ...v, state }, {
        onSuccess: (r) => { setActiveId(r.id); },
      });
    },
    /** Manage Views: renames/visibility/default changes and deletes, in one go. */
    manage: async (changes: { deleted: string[]; updated: { id: string; name: string; visibility: "personal" | "shared"; isDefault: boolean }[] }) => {
      for (const id of changes.deleted) await remove.mutateAsync({ id });
      for (const u of changes.updated) await update.mutateAsync(u);
      if (active && changes.deleted.includes(active.id))
        apply(pickInitial(views.filter((v) => !changes.deleted.includes(v.id)), null));
    },
  };
}
