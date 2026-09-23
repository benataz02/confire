import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Dialog, Icon, Input, SuggestionItem, Table, TableCell, TableGrowing,
  TableHeaderCell, TableHeaderRow, TableRow, TableVirtualizer,
  type TableRowDomRef, type TableVirtualizerDomRef,
} from "@ui5/webcomponents-react";
import {
  displayColumns, refKeyCols,
  type DomainOption, type LookupRef, type ResolvedTable, type Val,
} from "@confire/config-engine";
import { orpc } from "../orpc.ts";
import { EMPTY_SPEC, type FilterCond } from "../listSpec.ts";
import { optionsOf, resolveEntry } from "./configurator/formHelpers.ts";

// Kill the dialog's default content padding so the table (and its sticky header) sit flush.
// overflow:hidden so only the table scrolls — Dialog::part(content) is overflow:auto by default.
if (typeof document !== "undefined") {
  let el = document.getElementById("confire-vh-style");
  if (!el) { el = document.createElement("style"); el.id = "confire-vh-style"; document.head.appendChild(el); }
  el.textContent = `.confire-vh-dialog::part(content){padding:0;overflow:hidden;}`;
}

// A <Text> here is a custom element upgraded per cell on every range change — ~125 of them per
// scroll tick. A span draws the same line. The nowrap is load-bearing beyond looks: it keeps every
// row exactly one line tall, which is what lets one measured row speak for all of them (rowHeight).
const CELL: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** Remote-search plumbing: one round trip per 250ms pause instead of one per keystroke. */
function useRemoteSearch(onSearch: (q: string) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => cancel, []);
  return {
    cancel,
    search: (q: string) => { cancel(); timer.current = setTimeout(() => onSearch(q), 250); },
  };
}

// Fiori-style value help for query-sourced parameters: type to search, click a row to pick it.
// The search is remote only — the caller refreshes `table`. Re-filtering the response locally
// would hide a row the server matched on a column this dialog does not display.
function ValueHelpDialog({
  open, headerText, table, valueCol, columns, onSelect, onClose,
  onSearch, loading, hasMore, onLoadMore, columnLabels, hidden,
}: {
  open: boolean;
  headerText: string;
  table: ResolvedTable;
  valueCol: string;
  /** extra display columns (without valueCol) */
  columns: string[];
  onSelect: (v: Val | undefined, row?: Val[]) => void;
  onClose: () => void;
  /** remote search — debounced; the caller refreshes `table` */
  onSearch: (q: string) => void;
  loading?: boolean;
  /** another page is available — growing loads it when the table is scrolled to the end */
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** dialog headers; missing/blank → the key */
  columnLabels?: Record<string, string>;
  /** keys omitted from the dialog. Still on the row for derived values. */
  hidden?: string[];
}) {
  const [q, setQ] = useState("");
  const [range, setRange] = useState({ first: 0, last: 20 });
  const virtRef = useRef<TableVirtualizerDomRef>(null);
  const remote = useRemoteSearch(onSearch);

  // The virtualizer never SETS a row height, it assumes one (#rows = rowCount*rowHeight, each slice
  // translated by position*rowHeight) while the row itself is only min-height:
  // --_ui5_list_item_base_height — 44px cozy, 32px compact, and AppShell switches density at
  // runtime, so any pinned number (UI5's own default is 45) drifts the rows off the scrollbar in
  // the other density. Measured, not read off that var: it is shadow-scoped (`:host{}`, adopted per
  // component — the document does not have it), private, rem, and a MIN. Written as a property
  // rather than a prop: no state, and the range is right on the same tick it is measured.
  const measureRow = useCallback((el: TableRowDomRef | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      // Rounded: blockSize is fractional and a sub-pixel wobble would reset the range for nothing.
      // Half a pixel of error per row is well inside extraRows.
      const h = Math.round(e?.borderBoxSize[0]?.blockSize ?? 0);
      const virt = virtRef.current;
      if (!h || !virt || virt.rowHeight === h) return;
      virt.rowHeight = h;
      virt.reset(); // nothing else re-fires range-change, and every range it gave out used the old h
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const visible = [valueCol, ...columns].filter((c) => !hidden?.includes(c));
  const shown = visible.length ? visible : [valueCol];
  const idx = shown.map((c) => table.columns.indexOf(c));
  const vi = table.columns.indexOf(valueCol);
  const rows = table.rows;

  // Reset on the search TERM, not on `rows`: a growing page-append also changes `rows`, and
  // resetting there would yank the range back to the top while the user sits at the bottom.
  useEffect(() => {
    setRange({ first: 0, last: 20 });
    virtRef.current?.reset();
  }, [q]);

  return (
    <Dialog open={open} headerText={headerText} onClose={onClose} className="confire-vh-dialog"
      style={{ width: "min(52rem, 95vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button onClick={() => { onSelect(undefined); onClose(); }}>Clear</Button>
            <Button onClick={onClose}>Cancel</Button>
          </>
        } />
      }>
      <div style={{ display: "flex", flexDirection: "column", height: "60vh" }}>
        <div style={{ flex: "none", background: "var(--sapGroup_ContentBackground)", padding: "0.5rem" }}>
          <Input icon={<Icon name="search" />} placeholder="Search" value={q} showClearIcon
            onInput={(e) => { const v = e.target.value ?? ""; setQ(v); remote.search(v); }} style={{ width: "100%" }} />
        </div>
        {/* The height has to be DEFINITE (flex:1 + height:100%, not maxHeight): overflowMode=Scroll
            sets #table{height:100%}, and a host that never clips lets the rowCount*rowHeight spacer
            overflow the Dialog as a second scroller — and TableGrowing's Scroll mode, which is
            `#table.clientHeight >= #table.scrollHeight`, degrades to a "More" button. */}
        <Table noDataText="No matching rows." loading={loading} overflowMode="Scroll"
          style={{ flex: 1, height: "100%", minHeight: 0 }}
          features={[
            // rowCount is the LOADED count, never a server total: growing observes a row that sits
            // below the whole spacer, so overstating it buries load-more under blank rows.
            <TableVirtualizer key="virt" ref={virtRef} rowCount={rows.length} extraRows={10}
              onRangeChange={(e) => {
                const { first, last } = e.detail;
                setRange((prev) => (prev.first === first && prev.last === last ? prev : { first, last }));
              }} />,
            hasMore ? <TableGrowing key="grow" mode="Scroll" onLoadMore={() => onLoadMore?.()} /> : undefined,
          ]}
          onRowClick={(e) => {
            // `position` is the index we set below — the virtualizer needs it anyway, so the row
            // carries its own identity and no data-* attribute has to be parsed back out.
            const r = rows[e.detail.row.position ?? -1];
            if (r && vi >= 0) {
              onSelect(r[vi] ?? null, r);
              onClose();
            }
          }}
          headerRow={
            <TableHeaderRow sticky>
              {shown.map((c) => <TableHeaderCell key={c}><span>{columnLabels?.[c] || c}</span></TableHeaderCell>)}
            </TableHeaderRow>
          }>
          {rows.slice(range.first, range.last).map((r, j) => {
            const i = range.first + j;
            return (
              <TableRow key={i} rowKey={String(i)} position={i} interactive
                ref={j === 0 ? measureRow : undefined}>
                {idx.map((ci, k) => (
                  <TableCell key={k}><span style={CELL}>{ci < 0 ? "" : String(r[ci] ?? "")}</span></TableCell>
                ))}
              </TableRow>
            );
          })}
        </Table>
      </div>
    </Dialog>
  );
}

// The value-help input: type to search remotely, pick from the suggestions, or open the F4 dialog
// for the full table. The field shows the option's **label** unless `showValue` — the key always
// travels in `value`/`onChange`. Free text that matches no option is rejected on blur/Enter and
// the field snaps back to the committed option.
//
// INVARIANT: `options` is index-aligned with `table.rows` (both wrappers below build it that way,
// through optionsOf) — that alignment is how a picked row recovers its label.
export function ValueHelp({
  options, value, onChange, headerText, table, valueCol, columns, onSearch, disabled, readonly,
  valueState, valueStateMessage, loading, hasMore, onLoadMore, onOpen, columnLabels, hidden,
  showValue, required,
}: {
  options: DomainOption[];
  value: Val | undefined;
  onChange: (v: Val | undefined, row?: Val[]) => void;
  /** dialog title */
  headerText: string;
  valueState?: "None" | "Positive" | "Critical" | "Negative" | "Information";
  /** shown under the field while `valueState` is Information/Critical/Negative */
  valueStateMessage?: ReactNode;
  /** mandatory field: Fiori wants the negative state, not just the label asterisk, while it is
   *  empty. Derived here off the committed value, so typing a search does not clear the error. */
  required?: boolean;
  table: ResolvedTable;
  valueCol: string;
  columns: string[];
  /** remote search — debounced here, then the caller refreshes `options`/`table` */
  onSearch: (q: string) => void;
  disabled?: boolean;
  /** display-only: the field stays focusable and copyable, and the F4 icon is not offered */
  readonly?: boolean;
  /** a remote fetch is in flight: the field spins and F4 waits for it instead of opening empty */
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  /** resets the caller's search before the dialog opens */
  onOpen: () => void;
  columnLabels?: Record<string, string>;
  hidden?: string[];
  /** field + suggestion `text` show the option key; the label moves to additionalText */
  showValue?: boolean;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // Remember what we committed: the picked row drops out of `options` on the next remote search,
  // and the field must keep showing its label rather than falling back to the key.
  const [picked, setPicked] = useState<{ value: Val; label: string } | null>(null);
  const remote = useRemoteSearch(onSearch);

  const raw = value === undefined || value === null ? "" : String(value);
  const label = showValue ? raw : (
    options.find((o) => o.value === value)?.label ??
    (picked && picked.value === value ? picked.label : undefined) ??
    raw
  );
  const shown = typed ?? label;

  // filter="None" on the Input, and no local filter here: the server already searched for the same
  // term, so re-filtering could only drop rows it deliberately matched.
  const items = loading ? [] : options;

  const pick = (v: Val | undefined, row?: Val[], matchedLabel?: string) => {
    setPicked(v === undefined ? null : {
      value: v,
      label: matchedLabel ?? options.find((o) => o.value === v)?.label ?? String(v ?? ""),
    });
    setTyped(null); // snap the field back to the committed display
    onChange(v, row);
  };
  const commit = (raw: string) => {
    const r = resolveEntry(options, raw);
    if (r.kind === "clear") pick(undefined);
    else if (r.kind === "set") pick(r.value, table.rows[r.index], options[r.index]!.label);
    else setTyped(null); // reject: keep the last committed value
  };

  // Nothing to show yet: spin on the field and hold the dialog back until the first page lands.
  const pending = !!loading && !table.rows.length;

  // Without a message slot UI5 falls back to its own "Invalid entry", which names neither the
  // field nor what to do about it — say what is missing instead.
  return (
    <>
      <Input showSuggestions filter="None" value={shown} placeholder="Type or pick…"
        showClearIcon={!readonly} style={{ width: "100%" }} disabled={disabled} readonly={readonly}
        required={required}
        valueState={valueState ?? (required && !raw ? "Negative" : undefined)}
        valueStateMessage={
          valueStateMessage ? <div>{valueStateMessage}</div>
            : required && !raw ? <div>Pick a value from the list.</div>
            : undefined
        }
        icon={
          readonly ? undefined
            : loading ? <BusyIndicator active delay={0} size="S" />
            : <Icon name="value-help" style={{ cursor: "pointer" }} onClick={() => {
                remote.cancel();
                onOpen();
                setOpen(true);
              }} />
        }
        onInput={(e) => { const t = e.target.value ?? ""; setTyped(t); remote.search(t); }}
        onChange={(e) => commit(e.target.value ?? "")}>
        {items.map((o, i) => {
          const key = String(o.value ?? "");
          return showValue
            ? <SuggestionItem key={i} text={key} additionalText={o.label} />
            : <SuggestionItem key={i} text={o.label} additionalText={key} />;
        })}
      </Input>
      {open && !pending ? (
        <ValueHelpDialog open headerText={headerText} table={table} valueCol={valueCol} columns={columns}
          columnLabels={columnLabels} hidden={hidden} onSelect={(v, row) => {
            const i = row ? table.rows.indexOf(row) : -1;
            pick(v, row, i < 0 ? undefined : options[i]?.label);
          }} onClose={() => setOpen(false)}
          onSearch={onSearch} loading={loading} hasMore={hasMore} onLoadMore={onLoadMore} />
      ) : null}
    </>
  );
}

/** The three paging props both value helps hand to ValueHelp, from one infinite query.
 *
 *  `hasMore` is `hasNextPage` alone, deliberately: it gates whether <TableGrowing> is mounted, and
 *  ANDing `!isFetchingNextPage` onto it tore the growing feature down on every fetch — its
 *  onExitDOM disconnects the IntersectionObserver, and the re-mount costs another render cycle
 *  before it re-observes. Re-entry is guarded in onLoadMore instead, where it belongs.
 *
 *  `loading` is "asked and nothing back yet, or a search refetch" — but never on a failure, or the
 *  field would spin forever and the dialog never open (retry is off; the error shows as valueState). */
const pagingProps = (page: {
  data?: unknown; isError: boolean; isFetching: boolean; isFetchingNextPage: boolean;
  hasNextPage: boolean; fetchNextPage: () => Promise<unknown>;
}, asked: boolean) => ({
  loading: asked && !page.isError && (!page.data || (page.isFetching && !page.isFetchingNextPage)),
  hasMore: page.hasNextPage,
  onLoadMore: () => { if (!page.isFetchingNextPage) void page.fetchNextPage(); },
});

/** Which endpoint pages this table. Both name a masterdata row and let the server resolve the
 *  query from it — the builder preview included, now that a query is tenant masterdata and not
 *  part of the draft being edited. */
export type QuerySource = { kind: "project" | "portal"; modelId: string };

/** Value help over a model's query masterdata. Empty search starts from page 1, then pages by row
 *  offset on scroll; a non-empty search starts a separate remote page chain so a match past page 1
 *  is still findable. */
export function QueryValueHelp({
  source, canonicalTable, lookupRef, value, onChange, onPick, headerText, disabled, readonly,
  showValue, required,
}: {
  source: QuerySource;
  /** first page already resolved with the form's other lookups; carries the masterdata row's own
   *  column list and value-help labels, and is what the field shows before any fetch */
  canonicalTable?: ResolvedTable;
  lookupRef: LookupRef;
  value: Val | undefined;
  onChange: (v: Val | undefined) => void;
  /** the picked row — searched/off-page rows need adding locally to bind derived values immediately */
  onPick?: (t: ResolvedTable) => void;
  headerText: string;
  disabled?: boolean;
  readonly?: boolean;
  showValue?: boolean;
  /** mandatory field — see ValueHelp */
  required?: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null); // null = untouched; show canonical data without fetching
  const table = lookupRef.source === "manual" ? "" : lookupRef.table;
  // What the server searches: the ref's key/label columns as the masterdata row declares them (a
  // query keeps its columns from Test fetch) — queryPageSource rejects anything else. The rendered
  // key/label come from the response.
  const pinned = refKeyCols(lookupRef, canonicalTable?.columns);
  const searchCols = [pinned.valueCol, pinned.labelCol].filter((c): c is string => !!c);

  // The cursor is a row offset, and the search rides with it on every page — the server rebuilds
  // the same query and only moves $skip. (It used to be B1's @odata.nextLink, which forced the
  // server to re-validate a client-supplied URL on every page.)
  // keepPreviousData matters beyond the flicker: without it a search refetch empties `rows`, which
  // makes ValueHelp's `pending` true and unmounts the open F4 dialog mid-search (losing what the
  // user just typed into it). The table shows its own `loading` state instead.
  const term = (search ?? "").trim();
  const page = useInfiniteQuery(
    (source.kind === "portal" ? orpc.portal.queryPage : orpc.configs.queryPage).infiniteOptions({
      input: (next: number | undefined) => ({ modelId: source.modelId, table, cursor: next, search: term, searchCols }),
      getNextPageParam: (last) => last.nextSkip,
      initialPageParam: undefined as number | undefined,
      enabled: !!table && search !== null && !!source.modelId,
      retry: false,
      staleTime: 5 * 60_000,
      placeholderData: keepPreviousData,
    }),
  );

  // ponytail: the canonical page is a display-only fallback, not a cache seed — opening F4 costs
  // one page-1 fetch, and in exchange the rows and the next-page offset can never be a stale mix
  // of two resolves. Seed the query cache again if that round trip ever shows.
  const resolved = useMemo<ResolvedTable>(
    () =>
      page.data
        ? {
            columns: page.data.pages[0]?.columns ?? canonicalTable?.columns ?? [],
            rows: page.data.pages.flatMap((p) => p.rows as Val[][]),
          }
        : (canonicalTable ?? { columns: [], rows: [] }),
    [page.data, canonicalTable],
  );
  // Columns come back with the page when the query has none pinned, so resolve key/label against
  // what we actually got.
  const { valueCol, labelCol } = refKeyCols(lookupRef, resolved.columns);

  return (
    <ValueHelp options={optionsOf(resolved, valueCol, labelCol)} value={value} headerText={headerText}
      onChange={(nv, row) => {
        if (row) onPick?.({ columns: resolved.columns, rows: [row] });
        onChange(nv);
      }}
      disabled={disabled} readonly={readonly} showValue={showValue} required={required}
      valueState={page.error ? "Negative" : undefined}
      valueStateMessage={page.error ? (page.error as Error).message : undefined}
      table={resolved} valueCol={valueCol} columns={displayColumns(lookupRef, resolved.columns)}
      columnLabels={canonicalTable?.labels} hidden={canonicalTable?.hidden}
      onSearch={setSearch} onOpen={() => setSearch("")}
      {...pagingProps(page, search !== null)} />
  );
}

/** Value help over a B1 entity set via `entities.rows`. Same dialog as QueryValueHelp; the
 *  query is a ListVariantDef compiled server-side (the browser never sends a $filter string). */
export function EntityValueHelp({
  entitySet, keyField, value, onChange, headerText, select, filter, valueState, valueStateMessage,
  disabled, readonly, showValue, required,
}: {
  entitySet: string;
  keyField: string;
  value: Val | undefined;
  /** `row` is index-aligned with the columns below — [keyField, ...select minus keyField] — so a
   *  caller that pinned `select` can read a second field off the picked row without a round trip. */
  onChange: (v: Val | undefined, row?: Val[]) => void;
  headerText: string;
  /** $select; omitted = every scalar */
  select?: string[];
  /** $filter, AND-combined */
  filter?: FilterCond[];
  /** caller's state (e.g. required-but-empty); a fetch error still wins. */
  valueState?: "None" | "Positive" | "Critical" | "Negative" | "Information";
  /** what is wrong, in words — without it UI5 shows the generic "Invalid entry" */
  valueStateMessage?: ReactNode;
  disabled?: boolean;
  /** locked: the picked code stays readable, the dialog just won't open */
  readonly?: boolean;
  /** show the key rather than the label — for a field whose column IS the key (an item code) */
  showValue?: boolean;
  /** mandatory field — see ValueHelp */
  required?: boolean;
}) {
  const [search, setSearch] = useState<string | null>(null); // null = untouched: don't fetch yet

  const page = useInfiniteQuery(
    orpc.entities.rows.infiniteOptions({
      // Same cursor as the entity list: B1's sealed @odata.nextLink, and B1_PAGE_SIZE decides how
      // many rows a page holds — asking for `top: 50` here used to suppress that nextLink entirely.
      input: (cursor: string | undefined) => ({
        entity: entitySet,
        spec: {
          ...EMPTY_SPEC,
          select: select ?? EMPTY_SPEC.select,
          filter: filter ?? EMPTY_SPEC.filter,
          search: (search ?? "").trim(),
        },
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor,
      enabled: search !== null,
      retry: false,
      placeholderData: keepPreviousData,
      staleTime: 5 * 60_000,
    }),
  );

  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);
  // Pinned select wins so headers exist before the first page; otherwise the key plus whatever
  // the first row's other scalar fields are — B1's own column order.
  const columns = useMemo(() => {
    if (select?.length) return [keyField, ...select.filter((c) => c !== keyField)];
    const first = rows[0];
    if (!first) return [keyField];
    const rest = Object.keys(first).filter((k) => k !== keyField && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
    return [keyField, ...rest.slice(0, 4)];
  }, [rows, keyField, select]);

  const table = useMemo<ResolvedTable>(
    () => ({
      columns,
      rows: rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c] as Val)),
    }),
    [rows, columns],
  );

  return (
    <ValueHelp
      options={optionsOf(table, columns[0]!, columns[1])} value={value} onChange={onChange} headerText={headerText}
      table={table} valueCol={columns[0]!} columns={columns.slice(1)}
      onSearch={setSearch} onOpen={() => setSearch("")}
      disabled={disabled} readonly={readonly} showValue={showValue} required={required}
      valueState={page.error ? "Negative" : valueState}
      valueStateMessage={page.error ? page.error.message : valueStateMessage}
      {...pagingProps(page, search !== null)}
    />
  );
}
