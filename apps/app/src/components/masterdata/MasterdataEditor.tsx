import { useEffect, useRef, useState } from "react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, CheckBox, Form, FormGroup, FormItem, Icon, IllustratedMessage, Input,
  Label, MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle, Option, Panel, Select,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, TextArea,
  Title, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { PanelDomRef } from "@ui5/webcomponents-react";
import type { ODataQuery, QuerySource, Val } from "@confire/config-engine";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { colMinWidth } from "../configurator/tableWidths.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";

// One editor for both kinds. The kind is picked once, on create: a saved row keeps it, because
// switching would throw away either the maintained rows or the query behind it.

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
type Cell = Exclude<Val, string[]>;
type QueryDef = QuerySource & { labels?: Record<string, string>; hidden?: string[]; syncMinutes?: number };
type Draft = { name: string; kind: "table" | "query"; columns: Col[]; rows: Cell[][]; query: QueryDef };

const emptyDraft = (): Draft => ({
  name: "",
  kind: "table",
  columns: [{ key: "", label: "", type: "string" }],
  rows: [],
  query: { target: "b1", query: { entitySet: "" }, columns: [] },
});

// Two columns once there is room: the short field groups sit side by side, the table groups get a
// row of their own.
const FORM = {
  layout: "S1 M1 L2 XL2", labelSpan: "S12 M3 L3 XL3", emptySpan: "S0 M0 L0 XL1", accessibleMode: "Edit",
} as const;

// One CSS var drives both a group's column span *and* the `column-count` of its own content, so a
// group spanning both columns would fragment its table down the middle. `column-span: all` puts the
// content back into a single column across the full width — it needs a box to apply to, hence the
// `display: block` overriding the `display: contents` the Form sets on slotted groups.
const WIDE = { columnSpan: 2, style: { display: "block", columnSpan: "all" } } as const;

// A preview is a shape check, not a data browse — five rows read as $top=5, server-side.
const PREVIEW_TOP = 5;

const CELL = { display: "flex", alignItems: "center", gap: "0.5rem" } as const;

// Toolbar draws a border-bottom on its host and has no prop to turn it off; sitting on a table it
// doubles up with the header row's own line. Inline beats the `:host` rule.

/** Keeps the text of a row that has no icon aligned with the text of the rows that do. */
const iconSlot = <span style={{ width: "1rem", flex: "none" }} />;

/** `col-3` / `row-12` -> 3 / 12. The row key is the index; there is nothing else to key on. */
const rowIndex = (row: unknown) => Number((row as { rowKey: string }).rowKey.split("-")[1]);

// Drop labels/hidden for keys the Select clause no longer names; omit empty bags so the row
// stays sparse.
function pruneColUi(q: QueryDef): QueryDef {
  const keys = new Set(q.columns);
  const labels = Object.fromEntries(Object.entries(q.labels ?? {}).filter(([k, v]) => keys.has(k) && v.trim() !== ""));
  const hidden = (q.hidden ?? []).filter((k) => keys.has(k));
  return {
    ...q,
    labels: Object.keys(labels).length ? labels : undefined,
    hidden: hidden.length ? hidden : undefined,
  };
}

/** The same rules masterdata.save enforces, in words a person can act on — the server's are zod's. */
function issueOf(d: Draft, t: (key: string) => string): string | null {
  if (!d.name.trim()) return t("ADMIN_MD_NEED_NAME");
  if (d.kind === "query") return d.query.query.entitySet ? null : t("ADMIN_MD_NEED_ENTITY");
  if (!d.columns.length) return t("ADMIN_MD_NEED_COLUMN");
  if (d.columns.some((c) => !c.key.trim())) return t("ADMIN_MD_NEED_KEY");
  return null;
}

export function MasterdataEditor({ id }: { id?: string }) {
  const i18n = useI18n();
  const rowsText = (n: number) => i18n.getText(n === 1 ? "ADMIN_ROW_ONE" : "ADMIN_ROW_MANY", n);
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const list = useQuery(orpc.masterdata.list.queryOptions());
  const row = id ? list.data?.find((t) => t.id === id) : undefined;

  const [draft, setDraft] = useState<Draft | null>(id ? null : emptyDraft());
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ cols: string[]; rows: Cell[][] } | null>(null);
  const edit = (fn: (d: Draft) => Draft) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); };
  const panelRef = useRef<PanelDomRef>(null);
  // Panel only animates from its own toggle handler — assigning `collapsed` from outside just
  // re-renders it open. Clicking its toggle button is the interaction path; a frame later, so the
  // result is in the DOM when slideDown measures the height it animates to.
  // A dispatched MouseEvent rather than `.click()`: `.click()` arrives at x=0/y=0, which Panel
  // reads as the keyboard path and answers with stopImmediatePropagation, so the click never
  // reaches the header handler that toggles and the panel stays shut (2.26.0, verified headless).
  // Coordinates make it the mouse path, which is the one that animates.
  const expandPreview = () => requestAnimationFrame(() => {
    if (!panelRef.current?.collapsed) return;
    panelRef.current.shadowRoot?.querySelector(".ui5-panel-header-button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 1, clientY: 1 }));
  });
  const testFetch = useMutation(orpc.masterdata.queryPage.mutationOptions({
    onSuccess: (r) => {
      edit((x) => ({ ...x, query: pruneColUi({ ...x.query, columns: r.columns }) }));
      setPreview({ cols: r.columns, rows: r.rows as Cell[][] });
      expandPreview();
    },
    onError: () => { setPreview(null); expandPreview(); },
  }));

  useEffect(() => {
    if (!row || draft) return;
    setDraft({
      name: row.name,
      kind: row.kind,
      columns: row.kind === "table" ? (row.columns as Col[]) : emptyDraft().columns,
      rows: row.rows as Cell[][],
      query: row.query ?? emptyDraft().query,
    });
  }, [row, draft]);

  // Both keys: `list` is what this editor and useDraftModel read, `rows` is the list page's
  // display projection. A write invalidates both or the list shows a stale row.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.masterdata.rows.key() });
  };
  // Refill this table's cache now. Invalidates the same two keys a save does: `rowCount` and
  // `syncedAt` are on the row, so the list page is as stale as this editor after one.
  const sync = useMutation(orpc.masterdata.sync.mutationOptions({
    onSuccess: (r) => { invalidate(); toast(i18n.getText(r.count === 1 ? "ADMIN_SYNCED_ONE" : "ADMIN_SYNCED_MANY", r.count)); },
  }));
  const saveOpts = orpc.masterdata.save.mutationOptions({
    onSuccess: (r) => {
      setDirty(false);
      invalidate();
      toast(i18n.getText("ADMIN_MD_SAVED"));
      if (!id) void navigate({ to: "/$slug/masterdata/$id", params: { id: r.id }, replace: true });
    },
  });
  const save = useMutation({
    ...saveOpts,
    // The client rules run *as part of* the mutation rather than gating it, so a local problem and
    // a server one land in the same place: `save.error`. That is also what makes the mutation's own
    // state enough to say whether Save has been pressed — no second flag beside it. The test fetch
    // a query kind runs first is a link in that same chain for the same reason: it opens the
    // preview on its way through, and a query B1 refuses fails the save in that one place.
    mutationFn: async (...args: Parameters<NonNullable<typeof saveOpts.mutationFn>>) => {
      const i = issueOf(draft!, (key) => i18n.getText(key));
      if (i) throw new Error(i);
      const [input, ...rest] = args;
      if (input.kind !== "query") return saveOpts.mutationFn!(...args);
      // What gets stored is what the response returned, never what was typed — the rule Test fetch
      // already followed, now on the only path that writes: a saved $select answered by B1 once.
      const r = await testFetch.mutateAsync({
        target: input.query.target, query: input.query.query, columns: input.query.columns, top: PREVIEW_TOP,
      });
      return saveOpts.mutationFn!({ ...input, query: pruneColUi({ ...input.query, columns: r.columns }) }, ...rest);
    },
  });
  // `isError`, not `submittedAt`: a submit stamp outlives the save that succeeded, so clearing a
  // field afterwards would light it up again — the very thing this was meant to stop.
  const submitted = save.isError;
  const remove = useMutation(orpc.masterdata.remove.mutationOptions({
    onSuccess: () => { setDirty(false); invalidate(); toast(i18n.getText("ADMIN_TABLE_DELETED")); void navigate({ to: "/$slug/masterdata" }); },
  }));
  // Copies the *persisted* row, which is why the button is disabled while dirty — see the toolbar.
  const duplicate = useMutation(orpc.masterdata.duplicate.mutationOptions({
    onSuccess: (r) => { invalidate(); toast(i18n.getText("ADMIN_TABLE_DUPLICATED")); void navigate({ to: "/$slug/masterdata/$id", params: { id: r.id } }); },
  }));

  useBlocker({
    shouldBlockFn: async () => {
      if (!dirty || save.isPending) return false;
      return !(await confirm({
        title: i18n.getText("ADMIN_DISCARD_TITLE"),
        message: i18n.getText("ADMIN_DISCARD_MSG"),
        actionText: i18n.getText("ADMIN_DISCARD"),
        destructive: true,
      }));
    },
    enableBeforeUnload: () => dirty,
  });

  if (!draft) {
    if (list.error)
      return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{list.error.message}</MessageStrip>;
    if (list.data && !row)
      return <IllustratedMessage name="NoData" design="Auto" titleText={i18n.getText("ADMIN_TABLE_NOT_FOUND")} subtitleText={i18n.getText("ADMIN_TABLE_NOT_FOUND_SUB")} />;
    return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }
  const d = draft;
  const error = save.error ?? testFetch.error ?? remove.error ?? duplicate.error;
  // Both title states: a delete the server refuses has to be readable without scrolling the
  // header shut first.
  const errorStrip = error
    ? <MessageStrip design="Negative" hideCloseButton style={{ paddingBlockStart: "0.5rem" }}>{error.message}</MessageStrip>
    : null;

  const typed = (col: Col, raw: string): Cell =>
    col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split("\t"));
    if (!parsed.length) return;
    edit((x) => ({ ...x, rows: [...x.rows, ...parsed.map((cells) => x.columns.map((c, i) => typed(c, cells[i] ?? "")))] }));
    // A big paste lands below the fold; without this it looks like nothing happened.
    toast(i18n.getText(parsed.length === 1 ? "ADMIN_ROWS_ADDED_ONE" : "ADMIN_ROWS_ADDED_MANY", parsed.length));
  };

  const setQuery = (patch: Partial<QueryDef>) => edit((x) => ({ ...x, query: pruneColUi({ ...x.query, ...patch }) }));
  const setOData = (patch: Partial<ODataQuery>) => edit((x) => ({ ...x, query: { ...x.query, query: { ...x.query.query, ...patch } } }));
  const setCell = (ri: number, ci: number, v: Cell) =>
    edit((x) => ({ ...x, rows: x.rows.map((y, j) => (j === ri ? y.map((cell, cj) => (cj === ci ? v : cell)) : y)) }));

  return (
    <ObjectPage
      titleArea={
        <ObjectPageTitle
          header={
              <Title level="H4">{i18n.getText("ADMIN_MD_HEADING", i18n.getText("NAV_MASTERDATA"), d.name || (id ? i18n.getText("ADMIN_UNTITLED") : i18n.getText("ADMIN_NEW_TABLE")))}</Title>
          }
          snappedContent={errorStrip}
          expandedContent={errorStrip}
          actionsBar={
            <Toolbar design="Transparent" accessibleName={i18n.getText("ADMIN_TABLE_ACTIONS")}>
              {id && d.kind === "query" ? (
                // Disabled while dirty for the same reason Duplicate is: the sync runs the SAVED
                // query, so running it against edits still on screen would cache the wrong answer.
                <ToolbarButton text={sync.isPending ? i18n.getText("ADMIN_SYNCING") : i18n.getText("ADMIN_SYNC_NOW")} icon="synchronize"
                  accessibleName={i18n.getText("ADMIN_SYNC_NOW")} disabled={dirty || sync.isPending}
                  tooltip={dirty ? i18n.getText("ADMIN_SYNC_SAVE_FIRST") : i18n.getText("ADMIN_SYNC_TOOLTIP")}
                  onClick={() => sync.mutate({ id })} />
              ) : null}
              {id ? (
                // Disabled while dirty: duplicate copies what is stored, not what is on screen,
                // and a clean copy also never trips the unsaved-changes blocker on the way out.
                <ToolbarButton text={i18n.getText("ADMIN_DUPLICATE")} icon="copy" tooltip={dirty ? i18n.getText("ADMIN_SAVE_FIRST") : i18n.getText("ADMIN_DUPLICATE_TABLE")}
                  accessibleName={i18n.getText("ADMIN_DUPLICATE_TABLE")} disabled={dirty || duplicate.isPending}
                  onClick={() => duplicate.mutate({ id })} />
              ) : null}
              {id ? (
                <ToolbarButton text={i18n.getText("ADMIN_DELETE")} icon="delete" tooltip={i18n.getText("ADMIN_DELETE_TABLE")} accessibleName={i18n.getText("ADMIN_DELETE_TABLE")} disabled={remove.isPending}
                  onClick={async () => {
                    if (await confirm({
                      title: i18n.getText("ADMIN_DELETE_TABLE"),
                      message: i18n.getText("ADMIN_MD_DELETE_MSG", d.name),
                      actionText: i18n.getText("ADMIN_DELETE"), destructive: true,
                    })) remove.mutate({ ids: [id] });
                  }} />
              ) : null}
            </Toolbar>
          }
        />
      }
      footerArea={
        <Bar design="FloatingFooter" endContent={
          <Button design="Emphasized" disabled={save.isPending || testFetch.isPending}
            onClick={() => save.mutate(
              d.kind === "table"
                ? { id, name: d.name.trim(), kind: "table", columns: d.columns, rows: d.rows }
                : { id, name: d.name.trim(), kind: "query", query: d.query },
            )}>
            {testFetch.isPending ? i18n.getText("ADMIN_TESTING") : save.isPending ? i18n.getText("ADMIN_SAVING") : i18n.getText("ADMIN_SAVE")}
          </Button>
        } />
      }
    >
      <ObjectPageSection id="general" titleText={i18n.getText("ADMIN_SECTION_GENERAL")} hideTitleText>
        <Form {...FORM}>
          <FormGroup headerText={i18n.getText("ADMIN_DETAILS")}>
            <FormItem labelContent={<Label required>{i18n.getText("ADMIN_NAME")}</Label>}>
              <Input value={d.name} placeholder={i18n.getText("ADMIN_NAME_PLACEHOLDER")} required
                valueState={submitted && !d.name.trim() ? "Negative" : "None"}
                valueStateMessage={<div>{i18n.getText("ADMIN_NAME_HINT")}</div>}
                onInput={(e) => edit((x) => ({ ...x, name: e.target.value }))} />
            </FormItem>
            <FormItem labelContent={<Label required>{i18n.getText("ADMIN_KIND")}</Label>}>
              {/* Fixed once saved: the two kinds store different things, and a flip would throw
                  away either the maintained rows or the query. Read-only rather than disabled —
                  the choice still has to be readable after saving. */}
              <Select readonly={!!id} required value={d.kind} accessibleName={i18n.getText("ADMIN_KIND")}
                onChange={(e) => edit((x) => ({ ...x, kind: e.detail.selectedOption.value as Draft["kind"] }))}>
                <Option value="table" additionalText={i18n.getText("ADMIN_MAINTAINED_HERE")}>{i18n.getText("ADMIN_KIND_TABLE")}</Option>
                <Option value="query" additionalText={i18n.getText("ADMIN_READ_LIVE")}>{i18n.getText("ADMIN_KIND_QUERY")}</Option>
              </Select>
            </FormItem>
          </FormGroup>

          {d.kind === "table" ? (
            <>
            <FormGroup headerText={i18n.getText("ADMIN_COLUMNS")} {...WIDE}>
              <Toolbar design="Transparent" accessibleName={i18n.getText("ADMIN_COLUMN_ACTIONS")}>
                <ToolbarButton icon="add" design="Transparent" text={i18n.getText("ADMIN_ADD_COLUMN")} onClick={() => edit((x) => ({
                  ...x,
                  columns: [...x.columns, { key: "", label: "", type: "string" }],
                  rows: x.rows.map((r) => [...r, null]),
                }))} />
              </Toolbar>
              {/* Popin rather than Scroll: three short columns that must stay readable when the
                  window is narrow. */}
              <Table
                overflowMode="Popin"
                rowActionCount={1}
                onRowActionClick={(e) => {
                  const i = rowIndex(e.detail.row);
                  edit((x) => ({
                    ...x,
                    columns: x.columns.filter((_, j) => j !== i),
                    rows: x.rows.map((r) => r.filter((_, j) => j !== i)),
                  }));
                }}
                headerRow={
                  <TableHeaderRow>
                    <TableHeaderCell minWidth="12rem">{i18n.getText("ADMIN_KEY")}</TableHeaderCell>
                    <TableHeaderCell minWidth="10rem">{i18n.getText("ADMIN_LABEL")}</TableHeaderCell>
                    <TableHeaderCell width="9rem">{i18n.getText("ADMIN_TYPE")}</TableHeaderCell>
                  </TableHeaderRow>
                }>
                {d.columns.map((c, i) => (
                  <TableRow key={i} rowKey={`col-${i}`}
                    actions={<TableRowAction icon="delete" text={i18n.getText("ADMIN_DELETE")} />}>
                    <TableCell>
                      <div style={{ ...CELL, width: "100%" }}>
                        {/* 1st column = key, 2nd = label (refKeyCols) — the same convention the
                            query panel below states, and what a model's lookup reads. */}
                        {i < 2
                          ? <Icon name={i === 0 ? "key" : "text"} design="Neutral" accessibleName={i === 0 ? i18n.getText("ADMIN_LOOKUP_KEY") : i18n.getText("ADMIN_LABEL_COLUMN")} />
                          : iconSlot}
                        <Input placeholder={i18n.getText("ADMIN_KEY_PLACEHOLDER")} value={c.key} style={{ width: "100%" }}
                          valueState={submitted && !c.key.trim() ? "Negative" : "None"}
                          valueStateMessage={<div>{i18n.getText("ADMIN_NEED_KEY")}</div>}
                          onInput={(e) => edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)) }))} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input placeholder={c.key || i18n.getText("ADMIN_LABEL_PLACEHOLDER")} value={c.label} style={{ width: "100%" }}
                        onInput={(e) => edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)) }))} />
                    </TableCell>
                    <TableCell>
                      <Select style={{ width: "100%" }} value={c.type} accessibleName={i18n.getText("ADMIN_COLUMN_TYPE")}
                        onChange={(e) => edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, type: e.detail.selectedOption.value as Col["type"] } : y)) }))}>
                        {(["string", "number", "boolean"] as const).map((type) => (
                          <Option key={type} value={type}>{i18n.getText(type === "string" ? "ADMIN_TYPE_STRING" : type === "number" ? "ADMIN_TYPE_NUMBER" : "ADMIN_TYPE_BOOLEAN")}</Option>
                        ))}
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </FormGroup>

            <FormGroup headerText={i18n.getText("ADMIN_ROWS")} {...WIDE}>
              <Toolbar design="Transparent" accessibleName={i18n.getText("ADMIN_ROW_ACTIONS")}>
                <ToolbarButton icon="add" design="Transparent" text={i18n.getText("ADMIN_ADD_ROW")} disabled={!d.columns.length}
                  onClick={() => edit((x) => ({ ...x, rows: [...x.rows, x.columns.map(() => null as Cell)] }))} />
              </Toolbar>
              <div
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  // Only a grid becomes new rows; a single value belongs in the cell being pasted into.
                  if (!/[\t\n]/.test(text) || !d.columns.length) return;
                  e.preventDefault();
                  pasteRows(text);
                }}>
                <Table
                  noData={
                    <IllustratedMessage name="NoData" design="Dot" titleText={i18n.getText("ADMIN_NO_ROWS")}
                      subtitleText={i18n.getText("ADMIN_NO_ROWS_SUB")} />
                  }
                  rowActionCount={1}
                  onRowActionClick={(e) => {
                    const i = rowIndex(e.detail.row);
                    edit((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== i) }));
                  }}
                  headerRow={
                    <TableHeaderRow>
                      {d.columns.map((c, i) => (
                        <TableHeaderCell key={i} minWidth={colMinWidth(c.label || c.key, d.rows, i)}>
                          <span>{c.label || c.key}</span>
                        </TableHeaderCell>
                      ))}
                    </TableHeaderRow>
                  }>
                  {d.rows.map((r, ri) => (
                    <TableRow key={ri} rowKey={`row-${ri}`} actions={<TableRowAction icon="delete" text={i18n.getText("ADMIN_DELETE")} />}>
                      {d.columns.map((c, ci) => (
                        <TableCell key={ci}>
                          {/* The column's own type rather than a text box for everything: a boolean
                              reads as a checkbox, a number gets the numeric keypad. */}
                          {c.type === "boolean" ? (
                            <CheckBox checked={r[ci] === true} accessibleName={c.label || c.key}
                              onChange={(e) => setCell(ri, ci, e.target.checked)} />
                          ) : (
                            <Input style={{ width: "100%" }} type={c.type === "number" ? "Number" : "Text"}
                              accessibleName={c.label || c.key} value={String(r[ci] ?? "")}
                              onInput={(e) => setCell(ri, ci, typed(c, e.target.value))} />
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </Table>
              </div>
            </FormGroup>
            </>
          ) : (
            <>
            <FormGroup headerText={i18n.getText("ADMIN_CLAUSES")}>
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_SOURCE")}</Label>}>
                <Select value={d.query.target} accessibleName={i18n.getText("ADMIN_SOURCE")}
                  onChange={(e) => setQuery({ target: e.detail.selectedOption.value as QueryDef["target"] })}>
                  <Option value="b1">B1</Option>
                  <Option value="beas">Beas</Option>
                </Select>
              </FormItem>
              <FormItem labelContent={<Label required>{i18n.getText("ADMIN_ENTITY_SET")}</Label>}>
                <Input value={d.query.query.entitySet} placeholder="Items" required
                  valueState={submitted && !d.query.query.entitySet ? "Negative" : "None"}
                  valueStateMessage={<div>{i18n.getText("ADMIN_ENTITY_SET_HINT")}</div>}
                  onInput={(e) => setOData({ entitySet: e.target.value.trim() })} />
              </FormItem>
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_SELECT")}</Label>}>
                {/* Committed on change (Enter/focus-out), not on input: `columns` drives $select
                    *and* the label/visibility bags, which would be pruned mid-word on every keystroke. */}
                <Input value={d.query.columns.join(", ")} placeholder="ItemCode, ItemName"
                  onChange={(e) => setQuery({ columns: [...new Set(e.target.value.split(/[,\s]+/).filter(Boolean))] })} />
              </FormItem>
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_FILTER")}</Label>}>
                <TextArea growing growingMaxRows={4} rows={1} value={d.query.query.filter ?? ""}
                  placeholder="ItemType eq 'itItems' and Frozen eq 'tNO'"
                  onInput={(e) => setOData({ filter: e.target.value || undefined })} />
              </FormItem>
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_SORT")}</Label>}>
                <Input value={d.query.query.orderby ?? ""} placeholder="ItemName"
                  onInput={(e) => setOData({ orderby: e.target.value || undefined })} />
              </FormItem>
              {/* Not a schedule — there is no job runner. It is how old the cache may get before a
                  read refreshes it in the background, so a table nobody opens never costs a call. */}
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_SYNC_EVERY")}</Label>}>
                <Input type="Number" value={d.query.syncMinutes?.toString() ?? ""} placeholder={i18n.getText("ADMIN_MANUAL_ONLY")}
                  accessibleName={i18n.getText("ADMIN_SYNC_MINUTES_A11Y")}
                  onInput={(e) => {
                    const n = Number(e.target.value);
                    setQuery({ syncMinutes: Number.isInteger(n) && n > 0 ? n : undefined });
                  }} />
                <Text style={{ opacity: 0.7, whiteSpace: "nowrap" }}>{i18n.getText("ADMIN_MINUTES")}</Text>
              </FormItem>
            </FormGroup>
            <FormGroup headerText={i18n.getText("ADMIN_CACHE")}>
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_LAST_SYNCED")}</Label>}>
                <Text>{row?.syncedAt ? new Date(row.syncedAt).toLocaleString() : id ? i18n.getText("ADMIN_NEVER") : "—"}</Text>
              </FormItem>
              <FormItem labelContent={<Label>{i18n.getText("ADMIN_CACHED_ROWS")}</Label>}>
                <Text>{id ? rowsText(row?.rowCount ?? 0) : "—"}</Text>
              </FormItem>
              {row?.syncError ? (
                <FormItem labelContent={<Label>{i18n.getText("ADMIN_LAST_ERROR")}</Label>}>
                  <MessageStrip design="Negative" hideCloseButton>{row.syncError}</MessageStrip>
                </FormItem>
              ) : null}
            </FormGroup>
            <FormGroup accessibleName={i18n.getText("ADMIN_PREVIEW")} {...WIDE}>
              <Panel ref={panelRef} accessibleRole="Region" accessibleName={i18n.getText("ADMIN_PREVIEW")} collapsed
                header={
                  <div style={{ ...CELL, flex: 1, justifyContent: "space-between", minWidth: 0 }}>
                    <Title level="H5" size="H6">{i18n.getText("ADMIN_PREVIEW")}</Title>
                    <Button design="Transparent" icon="refresh"
                      disabled={testFetch.isPending || !d.query.query.entitySet}
                      onClick={() => testFetch.mutate({
                        target: d.query.target,
                        query: d.query.query,
                        columns: d.query.columns,
                        top: PREVIEW_TOP,
                      })}>
                      {testFetch.isPending ? i18n.getText("ADMIN_LOADING") : i18n.getText("ADMIN_TEST_FETCH")}
                    </Button>
                  </div>
                }>
              {preview ? (
                <Table noDataText={i18n.getText("ADMIN_NO_ROWS_RETURNED")}
                  headerRow={
                    <TableHeaderRow>
                      {preview.cols.map((c) => (
                        <TableHeaderCell key={c} minWidth="8rem"><span>{d.query.labels?.[c] || c}</span></TableHeaderCell>
                      ))}
                    </TableHeaderRow>
                  }>
                  {preview.rows.map((r, ri) => (
                    <TableRow key={ri} rowKey={`q-${ri}`}>
                      {r.map((cell, ci) => (
                        <TableCell key={ci}>
                          <Text maxLines={1} title={String(cell ?? "")}>{String(cell ?? "")}</Text>
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </Table>
              ) : (
                <IllustratedMessage name="NoData" design="Dot" titleText={i18n.getText("ADMIN_NO_PREVIEW")}
                  subtitleText={i18n.getText("ADMIN_NO_PREVIEW_SUB", PREVIEW_TOP, i18n.getText("ADMIN_TEST_FETCH"))} />
              )}
              </Panel>
            </FormGroup>

            <FormGroup headerText={i18n.getText("ADMIN_QUERY_COLUMNS")} {...WIDE}>
              <MessageStrip design="Information" style={{ marginBlockEnd: "0.5rem" }}>
                {i18n.getText("ADMIN_QUERY_COLUMNS_NOTE")}
              </MessageStrip>
              <Table
                noData={
                  <IllustratedMessage name="NoData" design="Dot" titleText={i18n.getText("ADMIN_NO_COLUMNS")}
                    subtitleText={i18n.getText("ADMIN_NO_COLUMNS_SUB", i18n.getText("ADMIN_TEST_FETCH"))} />
                }
                headerRow={
                  <TableHeaderRow>
                    <TableHeaderCell minWidth="10rem"><span>{i18n.getText("ADMIN_KEY")}</span></TableHeaderCell>
                    <TableHeaderCell minWidth="12rem"><span>{i18n.getText("ADMIN_LABEL")}</span></TableHeaderCell>
                    <TableHeaderCell width="7rem"><span>{i18n.getText("ADMIN_VALUE_HELP")}</span></TableHeaderCell>
                  </TableHeaderRow>
                }>
                {/* The first two columns of the Select clause are the key and the label by
                    convention (refKeyCols) — the icons say so instead of a line of prose. */}
                {d.query.columns.map((c, i) => (
                  <TableRow key={c} rowKey={c}>
                    <TableCell>
                      <div style={CELL}>
                        {i < 2
                          ? <Icon name={i === 0 ? "key" : "text"} design="Neutral" accessibleName={i === 0 ? i18n.getText("ADMIN_KEY_COLUMN") : i18n.getText("ADMIN_LABEL_COLUMN")} />
                          : iconSlot}
                        <Text>{c}</Text>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Input placeholder={c} value={d.query.labels?.[c] ?? ""} style={{ width: "100%" }}
                        accessibleName={i18n.getText("ADMIN_LABEL_FOR", c)}
                        onInput={(e) => setQuery({ labels: { ...d.query.labels, [c]: e.target.value } })} />
                    </TableCell>
                    <TableCell>
                      <CheckBox checked={!d.query.hidden?.includes(c)} accessibleName={i18n.getText("ADMIN_SHOW_IN_VH")}
                        onChange={(e) => setQuery({
                          hidden: e.target.checked
                            ? (d.query.hidden ?? []).filter((k) => k !== c)
                            : [...(d.query.hidden ?? []), c],
                        })} />
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </FormGroup>
            </>
          )}
        </Form>
      </ObjectPageSection>
    </ObjectPage>
  );
}
