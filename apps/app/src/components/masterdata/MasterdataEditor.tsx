import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, CheckBox, Form, FormGroup, FormItem, Icon, IllustratedMessage, Input, Label, MessageStrip,
  Option, Select, Text, TextArea,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { ODataQuery, QuerySource, Val } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { Grid, GridForm, type GridState } from "@confire/ui/list-report/Grid.tsx";
import type { EntityConstraints } from "@confire/ui/metadata.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import type { FormContext, ListColumn, Row, Section } from "@confire/ui/types.ts";
import { sameState } from "@confire/ui/views.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";
import { DeleteRows, useEditGrid } from "../model-builder/useEditGrid.tsx";

// One editor for both kinds. The kind is picked once, on create: a saved row keeps it, because
// switching would throw away either the maintained rows or the query behind it.

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
type Cell = Exclude<Val, string[]>;
type QueryDef = QuerySource & { labels?: Record<string, string>; hidden?: string[]; syncMinutes?: number };
type Draft = { name: string; kind: "table" | "query"; columns: Col[]; rows: Cell[][]; query: QueryDef };
type Translate = (key: string, ...params: Array<string | number>) => string;

const emptyDraft = (): Draft => ({
  name: "",
  kind: "table",
  columns: [{ key: "", label: "", type: "string" }],
  rows: [],
  query: { target: "b1", query: { entitySet: "" }, columns: [] },
});

// The draft is the record's one field, as in ParamPage: the shared ObjectPage's buffer, dirty mark,
// discard guard and Save/Cancel cover it whole; every section is a template over it.
const CONSTRAINTS: EntityConstraints = {
  name: "Masterdata", label: "", keys: [], writable: true, printable: false, flows: [],
  fields: { md: { Type: "string", EdmType: "", Editable: true } },
};

// Two columns once there is room.
const FORM = {
  layout: "S1 M1 L2 XL2", labelSpan: "S12 M3 L3 XL3", emptySpan: "S0 M0 L0 XL1", accessibleMode: "Edit",
} as const;

// A preview is a shape check, not a data browse — five rows read as $top=5, server-side.
const PREVIEW_TOP = 5;

const CELL = { display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" } as const;

/** Keeps the text of a row that has no icon aligned with the text of the rows that do. */
const iconSlot = <span style={{ width: "1rem", flex: "none" }} />;

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
function issueOf(d: Draft, t: Translate): string | null {
  if (!d.name.trim()) return t("ADMIN_MD_NEED_NAME");
  if (d.kind === "query") return d.query.query.entitySet ? null : t("ADMIN_MD_NEED_ENTITY");
  if (!d.columns.length) return t("ADMIN_MD_NEED_COLUMN");
  if (d.columns.some((c) => !c.key.trim())) return t("ADMIN_MD_NEED_KEY");
  return null;
}

const typed = (col: Col, raw: string): Cell =>
  col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

type Part = {
  d: Draft;
  edit: (fn: (d: Draft) => Draft) => void;
  /** Nothing is wrong until Save was tried: an empty key is a work in progress, not a mistake. */
  tried: boolean;
};

export function MasterdataEditor({ id }: { id?: string }) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const list = useQuery(orpc.masterdata.list.queryOptions());
  const row = id ? list.data?.find((x) => x.id === id) : undefined;

  // Taken once: a new object resets the page's form, so a background refetch must not hand it one.
  const [data, setData] = useState<Row | null>(id ? null : { md: emptyDraft() });
  const [tried, setTried] = useState(false);
  const [preview, setPreview] = useState<{ cols: string[]; rows: Cell[][] } | null>(null);
  // The draft on screen, for a test fetch answering after the user typed on.
  const latest = useRef<Draft | null>(null);

  useEffect(() => {
    if (!row || data) return;
    setData({
      md: {
        name: row.name,
        kind: row.kind,
        columns: row.kind === "table" ? (row.columns as Col[]) : emptyDraft().columns,
        rows: row.rows as Cell[][],
        query: row.query ?? emptyDraft().query,
      } satisfies Draft,
    });
  }, [row, data]);

  // Both keys: `list` is what this editor and useDraftModel read, `rows` is the list page's
  // display projection. A write invalidates both or the list shows a stale row.
  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: orpc.masterdata.rows.key() }),
  ]);
  const testFetch = useMutation(orpc.masterdata.queryPage.mutationOptions({
    onSuccess: (r) => setPreview({ cols: r.columns, rows: r.rows as Cell[][] }),
    onError: () => setPreview(null),
  }));
  // Refill this table's cache now. Invalidates the same two keys a save does: `rowCount` and
  // `syncedAt` are on the row, so the list page is as stale as this editor after one.
  const sync = useMutation(orpc.masterdata.sync.mutationOptions({
    onSuccess: (r) => { void invalidate(); toast(t(r.count === 1 ? "ADMIN_SYNCED_ONE" : "ADMIN_SYNCED_MANY", r.count)); },
  }));
  const save = useMutation(orpc.masterdata.save.mutationOptions());
  // A Delete leaves past the discard guard: its own confirm already asked.
  const remove = useMutation(orpc.masterdata.remove.mutationOptions({
    onSuccess: () => {
      void invalidate();
      toast(t("ADMIN_TABLE_DELETED"));
      void navigate({ to: "/$slug/masterdata", ignoreBlocker: true });
    },
  }));
  // Copies the *persisted* row, which is why the button is disabled while dirty — see the header.
  const duplicate = useMutation(orpc.masterdata.duplicate.mutationOptions({
    onSuccess: (r) => { void invalidate(); toast(t("ADMIN_TABLE_DUPLICATED")); void navigate({ to: "/$slug/masterdata/$id", params: { id: r.id } }); },
  }));

  const sections = useMemo<Section[]>(() => {
    const kind = (k: Draft["kind"]) => (fd: Row) => (fd.md as Draft).kind === k;
    return [
      { id: "general", label: t("ADMIN_SECTION_GENERAL") },
      { id: "columns", label: t("ADMIN_COLUMNS"), visible: kind("table") },
      { id: "rows", label: t("ADMIN_ROWS"), visible: kind("table") },
      { id: "query", label: t("ADMIN_KIND_QUERY"), visible: kind("query") },
      // A new table has nothing cached yet.
      ...(id ? [{ id: "cache", label: t("ADMIN_CACHE"), visible: kind("query") }] : []),
      { id: "preview", label: t("ADMIN_PREVIEW"), visible: kind("query") },
      { id: "queryColumns", label: t("ADMIN_QUERY_COLUMNS"), visible: kind("query") },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n, id]);

  if (!data) {
    if (list.error) return <PageError error={list.error} />;
    if (list.data && !row)
      return <IllustratedMessage name="NoData" design="Auto" titleText={t("ADMIN_TABLE_NOT_FOUND")} subtitleText={t("ADMIN_TABLE_NOT_FOUND_SUB")} />;
    return <ObjectPageSkeleton />;
  }
  const opened = data.md as Draft;

  const part = (ctx: FormContext): Part => {
    const d = ctx.formData.md as Draft;
    latest.current = d;
    return { d, edit: (fn) => ctx.updateField("md", fn(latest.current ?? d)), tried };
  };
  const fetchPreview = (p: Part) => testFetch.mutate(
    { target: p.d.query.target, query: p.d.query.query, columns: p.d.query.columns, top: PREVIEW_TOP },
    // What the response returned becomes the Select clause, never what was typed.
    { onSuccess: (r) => p.edit((x) => ({ ...x, query: pruneColUi({ ...x.query, columns: r.columns }) })) },
  );

  const actionError = remove.error ?? duplicate.error;
  const title = row?.name || (id ? t("ADMIN_UNTITLED") : t("ADMIN_NEW_TABLE"));
  return (
    <ObjectPage
      isNew
      entity="Masterdata"
      constraints={CONSTRAINTS}
      data={data}
      sections={sections}
      header={{
        titleField: "md",
        createTitle: title,
        actions: id ? (ctx) => {
          const d = ctx.formData.md as Draft;
          const dirty = !sameState(d, opened);
          return (
            <>
              {d.kind === "query" ? (
                // Disabled while dirty for the same reason Duplicate is: the sync runs the SAVED
                // query, so running it against edits still on screen would cache the wrong answer.
                <Button design="Transparent" icon="synchronize" disabled={dirty || sync.isPending}
                  tooltip={dirty ? t("ADMIN_SYNC_SAVE_FIRST") : t("ADMIN_SYNC_TOOLTIP")}
                  onClick={() => sync.mutate({ id })}>
                  {sync.isPending ? t("ADMIN_SYNCING") : t("ADMIN_SYNC_NOW")}
                </Button>
              ) : null}
              {/* Disabled while dirty: duplicate copies what is stored, not what is on screen,
                  and a clean copy also never trips the unsaved-changes guard on the way out. */}
              <Button design="Transparent" icon="copy" disabled={dirty || duplicate.isPending}
                tooltip={dirty ? t("ADMIN_SAVE_FIRST") : t("ADMIN_DUPLICATE_TABLE")}
                onClick={() => duplicate.mutate({ id })}>
                {t("ADMIN_DUPLICATE")}
              </Button>
              <Button design="Transparent" icon="delete" disabled={remove.isPending} tooltip={t("ADMIN_DELETE_TABLE")}
                onClick={async () => {
                  if (await confirm({
                    title: t("ADMIN_DELETE_TABLE"),
                    message: t("ADMIN_MD_DELETE_MSG", d.name),
                    actionText: t("ADMIN_DELETE"), destructive: true,
                  })) remove.mutate({ ids: [id] });
                }}>
                {t("ADMIN_DELETE")}
              </Button>
            </>
          );
        } : undefined,
      }}
      localViews
      createLabel={t("ADMIN_SAVE")}
      onCancelCreate={() => void navigate({ to: "/$slug/masterdata" })}
      breadcrumbs={[{ text: t("NAV_MASTERDATA"), to: "/masterdata" }]}
      notice={actionError ? <MessageStrip design="Negative" hideCloseButton>{actionError.message}</MessageStrip> : undefined}
      sectionTemplates={{
        general: (ctx) => <GeneralSection {...part(ctx)} saved={!!id} />,
        columns: (ctx) => <ColumnsSection {...part(ctx)} />,
        rows: (ctx) => <RowsSection {...part(ctx)} />,
        query: (ctx) => <QuerySection {...part(ctx)} />,
        cache: () => <CacheSection syncedAt={row?.syncedAt ?? null} rowCount={row?.rowCount ?? 0} syncError={row?.syncError ?? null} />,
        preview: (ctx) => {
          const p = part(ctx);
          return <PreviewSection d={p.d} preview={preview} fetching={testFetch.isPending} error={testFetch.error}
            onFetch={() => fetchPreview(p)} />;
        },
        queryColumns: (ctx) => <QueryColumnsSection {...part(ctx)} />,
      }}
      onSave={async (diff) => {
        // Unchanged, the page sends no diff — Save still stores (and test-fetches) what is open.
        const d = (diff.md ?? opened) as Draft;
        const issue = issueOf(d, t);
        if (issue) {
          setTried(true);
          throw new Error(issue);
        }
        let saved = d;
        if (d.kind === "query") {
          // What gets stored is what the response returned, never what was typed: a saved $select
          // answered by B1 once. A query B1 refuses fails the save right here.
          const r = await testFetch.mutateAsync({
            target: d.query.target, query: d.query.query, columns: d.query.columns, top: PREVIEW_TOP,
          });
          saved = { ...d, query: pruneColUi({ ...d.query, columns: r.columns }) };
        }
        const r = await save.mutateAsync(
          saved.kind === "table"
            ? { id, name: saved.name.trim(), kind: "table", columns: saved.columns, rows: saved.rows }
            : { id, name: saved.name.trim(), kind: "query", query: saved.query },
        );
        setTried(false);
        // Awaited: the page a create moves to reads its row from this list.
        await invalidate();
        toast(t("ADMIN_MD_SAVED"));
        if (!id) await navigate({ to: "/$slug/masterdata/$id", params: { id: r.id }, replace: true });
        else setData({ md: saved });
      }}
    />
  );
}

function GeneralSection({ d, edit, tried, saved }: Part & { saved: boolean }) {
  const i18n = useI18n();
  return (
    <Form {...FORM}>
      <FormGroup>
        <FormItem labelContent={<Label required>{i18n.getText("ADMIN_NAME")}</Label>}>
          <Input value={d.name} placeholder={i18n.getText("ADMIN_NAME_PLACEHOLDER")} required
            valueState={tried && !d.name.trim() ? "Negative" : "None"}
            valueStateMessage={<div>{i18n.getText("ADMIN_NAME_HINT")}</div>}
            onInput={(e) => edit((x) => ({ ...x, name: e.target.value }))} />
        </FormItem>
        <FormItem labelContent={<Label required>{i18n.getText("ADMIN_KIND")}</Label>}>
          {/* Fixed once saved: the two kinds store different things, and a flip would throw
              away either the maintained rows or the query. Read-only rather than disabled —
              the choice still has to be readable after saving. */}
          <Select readonly={saved} required value={d.kind} accessibleName={i18n.getText("ADMIN_KIND")}
            onChange={(e) => edit((x) => ({ ...x, kind: e.detail.selectedOption.value as Draft["kind"] }))}>
            <Option value="table" additionalText={i18n.getText("ADMIN_MAINTAINED_HERE")}>{i18n.getText("ADMIN_KIND_TABLE")}</Option>
            <Option value="query" additionalText={i18n.getText("ADMIN_READ_LIVE")}>{i18n.getText("ADMIN_KIND_QUERY")}</Option>
          </Select>
        </FormItem>
      </FormGroup>
    </Form>
  );
}

function ColumnsSection({ d, edit, tried }: Part) {
  const i18n = useI18n();
  // Memoized: useEditGrid rebuilds its cell templates when the column set changes, and a rebuild
  // remounts the input under the cursor.
  const columns = useMemo<ListColumn[]>(() => [
    { key: "key", label: i18n.getText("ADMIN_KEY"), width: 260 },
    { key: "label", label: i18n.getText("ADMIN_LABEL") },
    { key: "type", label: i18n.getText("ADMIN_TYPE"), width: 160 },
  ], [i18n]);
  const setCol = (i: number, patch: Partial<Col>) =>
    edit((x) => ({ ...x, columns: x.columns.map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  const grid = useEditGrid(d.columns, columns, {
    key: (c, i) => (
      <div style={CELL}>
        {/* 1st column = key, 2nd = label (refKeyCols) — the same convention the query's
            columns state, and what a model's lookup reads. */}
        {i < 2
          ? <Icon name={i === 0 ? "key" : "text"} design="Neutral" accessibleName={i18n.getText(i === 0 ? "ADMIN_LOOKUP_KEY" : "ADMIN_LABEL_COLUMN")} />
          : iconSlot}
        <Input placeholder={i18n.getText("ADMIN_KEY_PLACEHOLDER")} value={c.key} style={{ width: "100%" }}
          valueState={tried && !c.key.trim() ? "Negative" : "None"}
          valueStateMessage={<div>{i18n.getText("ADMIN_NEED_KEY")}</div>}
          onInput={(e) => setCol(i, { key: e.target.value })} />
      </div>
    ),
    label: (c, i) => (
      <Input placeholder={c.key || i18n.getText("ADMIN_LABEL_PLACEHOLDER")} value={c.label} style={{ width: "100%" }}
        onInput={(e) => setCol(i, { label: e.target.value })} />
    ),
    type: (c, i) => (
      <Select style={{ width: "100%" }} value={c.type} accessibleName={i18n.getText("ADMIN_COLUMN_TYPE")}
        onChange={(e) => setCol(i, { type: e.detail.selectedOption.value as Col["type"] })}>
        {(["string", "number", "boolean"] as const).map((type) => (
          <Option key={type} value={type}>{i18n.getText(type === "string" ? "ADMIN_TYPE_STRING" : type === "number" ? "ADMIN_TYPE_NUMBER" : "ADMIN_TYPE_BOOLEAN")}</Option>
        ))}
      </Select>
    ),
  });
  return (
    <GridForm name={i18n.getText("ADMIN_COLUMNS")}>
      <Grid {...grid} title={i18n.getText("ADMIN_COLUMNS")} fill={false} selectionMode="Multiple"
        noDataText={i18n.getText("ADMIN_MD_NEED_COLUMN")}
        toolbarActions={(sel) => (
          <>
            <Button icon="add" design="Transparent" onClick={() => edit((x) => ({
              ...x,
              columns: [...x.columns, { key: "", label: "", type: "string" }],
              rows: x.rows.map((r) => [...r, null]),
            }))}>{i18n.getText("ADMIN_ADD_COLUMN")}</Button>
            <DeleteRows sel={sel} onDelete={(gone) => edit((x) => ({
              ...x,
              columns: x.columns.filter((_, j) => !gone.has(j)),
              rows: x.rows.map((r) => r.filter((_, j) => !gone.has(j))),
            }))} />
          </>
        )} />
    </GridForm>
  );
}

function RowsSection({ d, edit }: Part) {
  const i18n = useI18n();
  // Keyed by position: a column's key may be empty or doubled while it is being typed. Rebuilt
  // only when a column changes — `columns` keeps its identity through a cell edit.
  const columns = useMemo<ListColumn[]>(
    () => d.columns.map((c, i) => ({ key: `c${i}`, label: c.label || c.key })),
    [d.columns],
  );
  const setCell = (ri: number, ci: number, v: Cell) =>
    edit((x) => ({ ...x, rows: x.rows.map((y, j) => (j === ri ? y.map((cell, cj) => (cj === ci ? v : cell)) : y)) }));
  const grid = useEditGrid(d.rows, columns, Object.fromEntries(d.columns.map((c, ci) => [`c${ci}`, (r: Cell[], ri: number) =>
    // The column's own type rather than a text box for everything: a boolean reads as a
    // checkbox, a number gets the numeric keypad.
    c.type === "boolean" ? (
      <CheckBox checked={r[ci] === true} accessibleName={c.label || c.key}
        onChange={(e) => setCell(ri, ci, e.target.checked)} />
    ) : (
      <Input style={{ width: "100%" }} type={c.type === "number" ? "Number" : "Text"}
        accessibleName={c.label || c.key} value={String(r[ci] ?? "")}
        onInput={(e) => setCell(ri, ci, typed(c, e.target.value))} />
    ),
  ])));

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split("\t"));
    if (!parsed.length) return;
    edit((x) => ({ ...x, rows: [...x.rows, ...parsed.map((cells) => x.columns.map((c, i) => typed(c, cells[i] ?? "")))] }));
    // A big paste lands below the fold; without this it looks like nothing happened.
    toast(i18n.getText(parsed.length === 1 ? "ADMIN_ROWS_ADDED_ONE" : "ADMIN_ROWS_ADDED_MANY", parsed.length));
  };

  return (
    <div
      onPaste={(e) => {
        const text = e.clipboardData.getData("text");
        // Only a grid becomes new rows; a single value belongs in the cell being pasted into.
        if (!/[\t\n]/.test(text) || !d.columns.length) return;
        e.preventDefault();
        pasteRows(text);
      }}>
      <GridForm name={i18n.getText("ADMIN_ROWS")}>
        <Grid {...grid} title={i18n.getText("ADMIN_ROWS")} fill={false} selectionMode="Multiple"
          noDataText={i18n.getText("ADMIN_NO_ROWS_SUB")}
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent" disabled={!d.columns.length}
                onClick={() => edit((x) => ({ ...x, rows: [...x.rows, x.columns.map(() => null as Cell)] }))}>
                {i18n.getText("ADMIN_ADD_ROW")}
              </Button>
              <DeleteRows sel={sel} onDelete={(gone) => edit((x) => ({ ...x, rows: x.rows.filter((_, j) => !gone.has(j)) }))} />
            </>
          )} />
      </GridForm>
    </div>
  );
}

function QuerySection({ d, edit, tried }: Part) {
  const i18n = useI18n();
  const setQuery = (patch: Partial<QueryDef>) => edit((x) => ({ ...x, query: pruneColUi({ ...x.query, ...patch }) }));
  const setOData = (patch: Partial<ODataQuery>) => edit((x) => ({ ...x, query: { ...x.query, query: { ...x.query.query, ...patch } } }));
  return (
    <Form {...FORM}>
      <FormGroup>
        <FormItem labelContent={<Label>{i18n.getText("ADMIN_SOURCE")}</Label>}>
          <Select value={d.query.target} accessibleName={i18n.getText("ADMIN_SOURCE")}
            onChange={(e) => setQuery({ target: e.detail.selectedOption.value as QueryDef["target"] })}>
            <Option value="b1">B1</Option>
            <Option value="beas">Beas</Option>
          </Select>
        </FormItem>
        <FormItem labelContent={<Label required>{i18n.getText("ADMIN_ENTITY_SET")}</Label>}>
          <Input value={d.query.query.entitySet} placeholder="Items" required
            valueState={tried && !d.query.query.entitySet ? "Negative" : "None"}
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
    </Form>
  );
}

function CacheSection({ syncedAt, rowCount, syncError }: { syncedAt: Date | string | null; rowCount: number; syncError: string | null }) {
  const i18n = useI18n();
  return (
    <Form {...FORM} accessibleMode="Display">
      <FormGroup>
        <FormItem labelContent={<Label>{i18n.getText("ADMIN_LAST_SYNCED")}</Label>}>
          <Text>{syncedAt ? new Date(syncedAt).toLocaleString(formatLocale()) : i18n.getText("ADMIN_NEVER")}</Text>
        </FormItem>
        <FormItem labelContent={<Label>{i18n.getText("ADMIN_CACHED_ROWS")}</Label>}>
          <Text>{i18n.getText(rowCount === 1 ? "ADMIN_ROW_ONE" : "ADMIN_ROW_MANY", rowCount)}</Text>
        </FormItem>
        {syncError ? (
          <FormItem labelContent={<Label>{i18n.getText("ADMIN_LAST_ERROR")}</Label>}>
            <MessageStrip design="Negative" hideCloseButton>{syncError}</MessageStrip>
          </FormItem>
        ) : null}
      </FormGroup>
    </Form>
  );
}

function PreviewSection({ d, preview, fetching, error, onFetch }: {
  d: Draft;
  preview: { cols: string[]; rows: Cell[][] } | null;
  fetching: boolean;
  error: Error | null;
  onFetch: () => void;
}) {
  const i18n = useI18n();
  const columns = useMemo<ListColumn[]>(
    () => (preview?.cols ?? []).map((c) => ({ key: c, label: d.query.labels?.[c] || c, sortable: false })),
    [preview, d.query.labels],
  );
  const state = useMemo<GridState>(() => ({ columns: preview?.cols ?? [], sortBy: [], groupBy: [] }), [preview]);
  const rows = useMemo(
    () => (preview?.rows ?? []).map((r): Row => Object.fromEntries((preview?.cols ?? []).map((c, i) => [c, r[i]]))),
    [preview],
  );
  const fetch = (
    <Button design="Transparent" icon="refresh" disabled={fetching || !d.query.query.entitySet} onClick={onFetch}>
      {fetching ? i18n.getText("ADMIN_LOADING") : i18n.getText("ADMIN_TEST_FETCH")}
    </Button>
  );
  return (
    <>
      {error ? <MessageStrip design="Negative" hideCloseButton style={{ marginBlockEnd: "0.5rem" }}>{error.message}</MessageStrip> : null}
      {preview ? (
        <GridForm name={i18n.getText("ADMIN_PREVIEW")}>
          <Grid title={i18n.getText("ADMIN_PREVIEW")} columns={columns} state={state} rows={rows} fill={false}
            showSettings={false} noDataText={i18n.getText("ADMIN_NO_ROWS_RETURNED")} toolbarActions={() => fetch} />
        </GridForm>
      ) : (
        <IllustratedMessage name="NoData" design="Dot" titleText={i18n.getText("ADMIN_NO_PREVIEW")}
          subtitleText={i18n.getText("ADMIN_NO_PREVIEW_SUB", PREVIEW_TOP, i18n.getText("ADMIN_TEST_FETCH"))}>
          {fetch}
        </IllustratedMessage>
      )}
    </>
  );
}

function QueryColumnsSection({ d, edit }: Part) {
  const i18n = useI18n();
  const setQuery = (patch: Partial<QueryDef>) => edit((x) => ({ ...x, query: pruneColUi({ ...x.query, ...patch }) }));
  const columns = useMemo<ListColumn[]>(() => [
    { key: "key", label: i18n.getText("ADMIN_KEY"), width: 260 },
    { key: "label", label: i18n.getText("ADMIN_LABEL") },
    { key: "shown", label: i18n.getText("ADMIN_VALUE_HELP"), width: 128 },
  ], [i18n]);
  // One item per Select column, carrying its label and visibility so an edit of either is a new
  // item and the grid draws it.
  const items = useMemo(
    () => d.query.columns.map((key) => ({ key, label: d.query.labels?.[key] ?? "", shown: !d.query.hidden?.includes(key) })),
    [d.query],
  );
  const grid = useEditGrid(items, columns, {
    // The first two columns of the Select clause are the key and the label by convention
    // (refKeyCols) — the icons say so instead of a line of prose.
    key: (c, i) => (
      <div style={CELL}>
        {i < 2
          ? <Icon name={i === 0 ? "key" : "text"} design="Neutral" accessibleName={i18n.getText(i === 0 ? "ADMIN_KEY_COLUMN" : "ADMIN_LABEL_COLUMN")} />
          : iconSlot}
        <Text>{c.key}</Text>
      </div>
    ),
    label: (c) => (
      <Input placeholder={c.key} value={c.label} style={{ width: "100%" }}
        accessibleName={i18n.getText("ADMIN_LABEL_FOR", c.key)}
        onInput={(e) => setQuery({ labels: { ...d.query.labels, [c.key]: e.target.value } })} />
    ),
    shown: (c) => (
      <CheckBox checked={c.shown} accessibleName={i18n.getText("ADMIN_SHOW_IN_VH")}
        onChange={(e) => setQuery({
          hidden: e.target.checked
            ? (d.query.hidden ?? []).filter((k) => k !== c.key)
            : [...(d.query.hidden ?? []), c.key],
        })} />
    ),
  });
  return (
    <GridForm name={i18n.getText("ADMIN_QUERY_COLUMNS")}>
      <Grid {...grid} title={i18n.getText("ADMIN_QUERY_COLUMNS")} fill={false}
        noDataText={i18n.getText("ADMIN_NO_COLUMNS_SUB", i18n.getText("ADMIN_TEST_FETCH"))} />
    </GridForm>
  );
}
