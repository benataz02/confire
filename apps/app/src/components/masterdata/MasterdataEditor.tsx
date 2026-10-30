import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Form, FormGroup, FormItem, Icon, IllustratedMessage, Input, Label, ObjectStatus, Text } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { QuerySource, Val } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { FORM_LAYOUT } from "@confire/ui/formLayout.ts";
import { EditGrid } from "@confire/ui/list-report/EditGrid.tsx";
import { Grid, GridForm, type GridState } from "@confire/ui/list-report/Grid.tsx";
import { ownColumns } from "@confire/ui/metadata.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { useObjectRecord, type RecordIssues } from "@confire/ui/object-page/useObjectRecord.ts";
import type { PageMessage } from "@confire/ui/PageMessages.tsx";
import type { Control, ListColumn, Row, Section } from "@confire/ui/types.ts";
import { useI18n } from "../../i18n.ts";
import { orpc } from "../../orpc.ts";

// One editor for both kinds of masterdata, an always-editing record. The kind is picked once, on
// create: a saved row keeps it, because switching would throw away either the maintained rows or
// the query behind it. The query's parts are flat dotted keys (`query.entitySet`), as the portal
// onboarding form flattens an address.

type Col = { key: string; label: string; type: "string" | "number" | "boolean" };
type Cell = Exclude<Val, string[]>;
type QueryDef = QuerySource & { labels?: Record<string, string>; hidden?: string[]; syncMinutes?: number };
type Draft = { name: string; kind: "table" | "query"; columns: Col[]; rows: Cell[][]; query: QueryDef };
type Translate = (key: string, ...params: Array<string | number>) => string;
type MasterdataRow = NonNullable<Awaited<ReturnType<typeof orpc.masterdata.list.call>>>[number];

const emptyDraft = (): Draft => ({
  name: "",
  kind: "table",
  columns: [{ key: "", label: "", type: "string" }],
  rows: [],
  query: { target: "b1", query: { entitySet: "" }, columns: [] },
});

const toRecord = (d: Draft): Row => ({
  name: d.name, kind: d.kind, columns: d.columns, rows: d.rows,
  "query.target": d.query.target, "query.entitySet": d.query.query.entitySet, "query.filter": d.query.query.filter,
  "query.orderby": d.query.query.orderby, "query.columns": d.query.columns, "query.labels": d.query.labels,
  "query.hidden": d.query.hidden, "query.syncMinutes": d.query.syncMinutes,
});

// A cleared field is null on the record; the stored row has no nulls but the cells.
const opt = <T,>(v: unknown) => (v === null || v === "" ? undefined : (v as T | undefined));
const fromRecord = (r: Row): Draft => ({
  name: String(r.name ?? ""),
  kind: r.kind as Draft["kind"],
  columns: ((r.columns as Col[] | undefined) ?? []).map((c) => ({ key: c.key ?? "", label: c.label ?? "", type: c.type })),
  rows: (r.rows as Cell[][] | undefined) ?? [],
  query: {
    target: r["query.target"] as QueryDef["target"],
    query: { entitySet: String(r["query.entitySet"] ?? ""), filter: opt(r["query.filter"]), orderby: opt(r["query.orderby"]) },
    columns: (r["query.columns"] as string[] | undefined) ?? [],
    labels: opt(r["query.labels"]), hidden: opt(r["query.hidden"]), syncMinutes: opt(r["query.syncMinutes"]),
  },
});

// A preview is a shape check, not a data browse — five rows read as $top=5, server-side.
const PREVIEW_TOP = 5;

const CELL = { display: "flex", alignItems: "center", gap: "0.5rem", width: "100%" } as const;

/** Keeps the text of a row that has no icon aligned with the text of the rows that do. */
const iconSlot = <span style={{ width: "1rem", flex: "none" }} />;

/** Labels and hidden flags for keys the Select clause still names; empty bags omitted so the row
 *  stays sparse. */
function prunedColUi(columns: string[], labels: Record<string, string> | undefined, hidden: string[] | undefined) {
  const keys = new Set(columns);
  const l = Object.fromEntries(Object.entries(labels ?? {}).filter(([k, v]) => keys.has(k) && v.trim() !== ""));
  const h = (hidden ?? []).filter((k) => keys.has(k));
  return { "query.labels": Object.keys(l).length ? l : undefined, "query.hidden": h.length ? h : undefined };
}

/** The maintained rows follow their columns: a column added (at the end) is an empty cell on every
 *  row, one deleted takes its cells along — matched by identity, as the grid hands the kept ones back. */
function rowsFor(prev: Col[], next: Col[], rows: Cell[][]): Cell[][] {
  if (next.length > prev.length) return rows.map((r) => [...r, ...next.slice(prev.length).map(() => null)]);
  if (next.length === prev.length) return rows;
  const kept = prev.map((c) => next.includes(c));
  return rows.map((r) => r.filter((_, i) => kept[i]));
}

const typed = (col: Col, raw: string): Cell =>
  col.type === "number" ? (raw === "" ? null : Number(raw)) : col.type === "boolean" ? raw === "true" : raw;

const sectionsOf = (t: Translate, saved: boolean): Section[] => {
  const kind = (k: Draft["kind"]) => (fd: Row) => fd.kind === k;
  return [
    {
      id: "general", label: t("ADMIN_SECTION_GENERAL"),
      fields: [
        { key: "name", label: t("ADMIN_NAME"), required: true, placeholder: t("ADMIN_NAME_PLACEHOLDER"), help: t("ADMIN_NAME_HINT") },
        // Fixed once saved: the two kinds store different things, and a flip would throw away
        // either the maintained rows or the query.
        {
          key: "kind", label: t("ADMIN_KIND"), required: true, readonly: true, editableOnCreate: true,
          options: [
            { value: "table", label: `${t("ADMIN_KIND_TABLE")} — ${t("ADMIN_MAINTAINED_HERE")}` },
            { value: "query", label: `${t("ADMIN_KIND_QUERY")} — ${t("ADMIN_READ_LIVE")}` },
          ],
        },
      ],
    },
    {
      id: "columns", label: t("ADMIN_COLUMNS"), visible: kind("table"),
      table: {
        key: "columns",
        columns: [
          { key: "key", label: t("ADMIN_KEY"), width: 260, required: true, controlType: "columnKey" },
          { key: "label", label: t("ADMIN_LABEL"), placeholder: t("ADMIN_LABEL_PLACEHOLDER") },
          {
            key: "type", label: t("ADMIN_TYPE"), width: 160, required: true,
            options: (["string", "number", "boolean"] as const).map((v) => ({ value: v, label: t(`ADMIN_TYPE_${v.toUpperCase()}`) })),
          },
        ],
        newRow: () => ({ key: "", label: "", type: "string" }),
        onChange: (cols, _r, prev) => ({ rows: rowsFor(prev.columns as Col[], cols as Col[], prev.rows as Cell[][]) }),
      },
    },
    { id: "rows", label: t("ADMIN_ROWS"), visible: kind("table") },
    {
      id: "query", label: t("ADMIN_KIND_QUERY"), visible: kind("query"),
      fields: [
        { key: "query.target", label: t("ADMIN_SOURCE"), required: true, options: [{ value: "b1", label: "B1" }, { value: "beas", label: "Beas" }] },
        { key: "query.entitySet", label: t("ADMIN_ENTITY_SET"), required: true, placeholder: "Items", help: t("ADMIN_ENTITY_SET_HINT") },
        // `columns` drives $select *and* the label/visibility bags, so it commits on change, never
        // per keystroke, and prunes the bags as it does.
        {
          key: "query.columns", label: t("ADMIN_SELECT"), controlType: "columnList", placeholder: "ItemCode, ItemName",
          onChange: (v, r) => prunedColUi(v as string[], r["query.labels"] as Record<string, string> | undefined, r["query.hidden"] as string[] | undefined),
        },
        { key: "query.filter", label: t("ADMIN_FILTER"), controlType: "textarea", placeholder: "ItemType eq 'itItems' and Frozen eq 'tNO'" },
        { key: "query.orderby", label: t("ADMIN_SORT"), placeholder: "ItemName" },
        // Not a schedule — there is no job runner. It is how old the cache may get before a read
        // refreshes it in the background, so a table nobody opens never costs a call.
        { key: "query.syncMinutes", label: `${t("ADMIN_SYNC_EVERY")} (${t("ADMIN_MINUTES")})`, type: "number", placeholder: t("ADMIN_MANUAL_ONLY") },
      ],
    },
    // A new table has nothing cached yet.
    ...(saved ? [{ id: "cache", label: t("ADMIN_CACHE"), visible: kind("query") }] : []),
    { id: "preview", label: t("ADMIN_PREVIEW"), visible: kind("query") },
    { id: "queryColumns", label: t("ADMIN_QUERY_COLUMNS"), visible: kind("query") },
  ];
};

/** The same rules masterdata.save enforces, in words a person can act on — the server's are zod's. */
function issuesOf(r: Row, t: Translate): RecordIssues {
  const d = fromRecord(r);
  const fields: Record<string, string> = {};
  const columns: Record<string, string> = {};
  if (!d.name.trim()) fields.name = t("ADMIN_MD_NEED_NAME");
  if (d.kind === "query") {
    if (!d.query.query.entitySet) fields["query.entitySet"] = t("ADMIN_MD_NEED_ENTITY");
    const n = d.query.syncMinutes;
    if (n !== undefined && !(Number.isInteger(n) && n > 0)) fields["query.syncMinutes"] = t("ADMIN_SYNC_MINUTES_ERR");
    return { fields };
  }
  d.columns.forEach((c, i) => { if (!c.key.trim()) columns[`${i}:key`] = t("ADMIN_NEED_KEY"); });
  return {
    fields, cells: { columns },
    other: d.columns.length ? [] : [{ id: "columns", text: t("ADMIN_MD_NEED_COLUMN"), section: "columns" }],
  };
}

export function MasterdataEditor({ id }: { id?: string }) {
  const i18n = useI18n();
  const list = useQuery(orpc.masterdata.list.queryOptions());
  const row = id ? list.data?.find((x) => x.id === id) : undefined;
  if (!id) return <Editor />;
  if (list.error) return <PageError error={list.error} />;
  if (list.data && !row)
    return <IllustratedMessage name="NoData" design="Auto" titleText={i18n.getText("ADMIN_TABLE_NOT_FOUND")} subtitleText={i18n.getText("ADMIN_TABLE_NOT_FOUND_SUB")} />;
  return row ? <Editor row={row} /> : <ObjectPageSkeleton />;
}

function Editor({ row }: { row?: MasterdataRow }) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const id = row?.id;
  // Taken once: a background refetch must not reset the record; a Save rebases it.
  const [data] = useState(() => toRecord(row ? {
    name: row.name, kind: row.kind,
    columns: row.kind === "table" ? (row.columns as Col[]) : emptyDraft().columns,
    rows: row.rows as Cell[][], query: row.query ?? emptyDraft().query,
  } : emptyDraft()));
  const sections = useMemo(() => sectionsOf(t, !!id), [i18n, id]);
  const validate = useCallback((r: Row) => issuesOf(r, t), [i18n]);
  const [preview, setPreview] = useState<{ cols: string[]; rows: Cell[][] } | null>(null);

  // Both keys: `list` is what this editor and the model builder read, `rows` is the list page's
  // display projection. A write invalidates both or the list shows a stale row.
  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: orpc.masterdata.rows.key() }),
  ]);
  const testFetch = useMutation(orpc.masterdata.queryPage.mutationOptions({
    onSuccess: (r) => setPreview({ cols: r.columns, rows: r.rows as Cell[][] }),
    onError: () => setPreview(null),
  }));
  // Refill this table's cache now. `rowCount` and `syncedAt` are on the row, so the list page is as
  // stale as this editor after one.
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
  // Copies the *stored* row, which is why the button is disabled while dirty.
  const duplicate = useMutation(orpc.masterdata.duplicate.mutationOptions({
    onSuccess: (r) => { void invalidate(); toast(t("ADMIN_TABLE_DUPLICATED")); void navigate({ to: "/$slug/masterdata/$id", params: { id: r.id } }); },
  }));

  const queryOf = (d: Draft) => ({ target: d.query.target, query: d.query.query, columns: d.query.columns, top: PREVIEW_TOP });
  const record = useObjectRecord({
    data, sections, validate, isNew: !id, alwaysEdit: true,
    onLeave: () => navigate({ to: "/$slug/masterdata" }),
    onSave: async (_diff, { formData }) => {
      let d = fromRecord(formData);
      if (d.kind === "query") {
        // What gets stored is what the response returned, never what was typed: a saved $select
        // answered by B1 once. A query B1 refuses fails the save right here.
        const r = await testFetch.mutateAsync(queryOf(d));
        const ui = prunedColUi(r.columns, d.query.labels, d.query.hidden);
        d = { ...d, query: { ...d.query, columns: r.columns, labels: ui["query.labels"], hidden: ui["query.hidden"] } };
      }
      const saved = await save.mutateAsync(d.kind === "table"
        ? { id, name: d.name.trim(), kind: "table", columns: d.columns, rows: d.rows }
        : { id, name: d.name.trim(), kind: "query", query: d.query });
      // Awaited: the page a create moves to reads its row from this list.
      await invalidate();
      toast(t("ADMIN_MD_SAVED"));
      if (!id) await navigate({ to: "/$slug/masterdata/$id", params: { id: saved.id }, replace: true });
      return toRecord(d);
    },
  });
  const d = fromRecord(record.formData);

  const messages: PageMessage[] = [
    ...[remove.error, duplicate.error, sync.error].flatMap((e, i) => (e ? [{
      id: `action:${i}`, type: "Negative" as const, text: e.message, detail: t("ADMIN_ACTION_FAILED"), group: t("ADMIN_SECTION_GENERAL"),
    }] : [])),
    ...(testFetch.error ? [{ id: "preview", type: "Negative" as const, text: testFetch.error.message, detail: t("ADMIN_TEST_FETCH"), group: t("ADMIN_PREVIEW"), section: "preview" }] : []),
    ...(row?.syncError ? [{ id: "sync", type: "Negative" as const, text: row.syncError, detail: t("ADMIN_LAST_ERROR"), group: t("ADMIN_CACHE"), section: "cache" }] : []),
  ];

  const controls: Record<string, Control> = {
    // 1st column = key, 2nd = label (refKeyCols) — the same convention the query's columns state,
    // and what a model's lookup reads.
    columnKey: (c) => (
      <div style={CELL}>
        {c.rowIndex !== undefined && c.rowIndex < 2
          ? <Icon name={c.rowIndex === 0 ? "key" : "text"} design="Neutral" accessibleName={t(c.rowIndex === 0 ? "ADMIN_LOOKUP_KEY" : "ADMIN_LABEL_COLUMN")} />
          : iconSlot}
        <Input placeholder={t("ADMIN_KEY_PLACEHOLDER")} value={String(c.value ?? "")} style={{ width: "100%" }} accessibleName={c.field.label}
          valueState={c.error ? "Negative" : "None"} valueStateMessage={<div>{c.error}</div>}
          onInput={(e) => c.onChange(e.target.value)} />
      </div>
    ),
    columnList: (c) => (
      <Input value={((c.value as string[] | undefined) ?? []).join(", ")} placeholder={c.field.placeholder} accessibleName={c.field.label}
        style={{ width: "100%" }}
        onChange={(e) => c.onChange([...new Set((e.target.value ?? "").split(/[,\s]+/).filter(Boolean))])} />
    ),
  };

  return (
    <ObjectPage record={record} entity="Masterdata" localViews
      header={{
        titleField: "name",
        createTitle: t("ADMIN_NEW_TABLE"),
        actions: id ? () => (
          <>
            {d.kind === "query" ? (
              // Disabled while dirty for the same reason Duplicate is: the sync runs the SAVED query,
              // so running it against edits still on screen would cache the wrong answer.
              <Button design="Transparent" icon="synchronize" disabled={record.dirty || sync.isPending}
                tooltip={record.dirty ? t("ADMIN_SYNC_SAVE_FIRST") : t("ADMIN_SYNC_TOOLTIP")}
                onClick={() => sync.mutate({ id })}>
                {sync.isPending ? t("ADMIN_SYNCING") : t("ADMIN_SYNC_NOW")}
              </Button>
            ) : null}
            <Button design="Transparent" icon="copy" disabled={record.dirty || duplicate.isPending}
              tooltip={record.dirty ? t("ADMIN_SAVE_FIRST") : t("ADMIN_DUPLICATE_TABLE")}
              onClick={() => duplicate.mutate({ id })}>
              {t("ADMIN_DUPLICATE")}
            </Button>
            <Button design="Transparent" icon="delete" disabled={remove.isPending} tooltip={t("ADMIN_DELETE_TABLE")}
              onClick={async () => {
                if (await confirm({
                  title: t("ADMIN_DELETE_TABLE"), message: t("ADMIN_MD_DELETE_MSG", d.name),
                  actionText: t("ADMIN_DELETE"), destructive: true,
                })) remove.mutate({ ids: [id] });
              }}>
              {t("ADMIN_DELETE")}
            </Button>
          </>
        ) : undefined,
      }}
      breadcrumbs={[{ text: t("NAV_MASTERDATA"), to: "/masterdata" }]}
      messages={messages}
      controls={controls}
      sectionTemplates={{
        rows: (ctx) => <RowsSection d={fromRecord(ctx.formData)} onRows={(rows) => ctx.updateField("rows", rows)} />,
        cache: () => <CacheSection syncedAt={row?.syncedAt ?? null} rowCount={row?.rowCount ?? 0} syncError={row?.syncError ?? null} />,
        preview: (ctx) => {
          const cur = fromRecord(ctx.formData);
          return <PreviewSection d={cur} preview={preview} fetching={testFetch.isPending}
            // What the response returned becomes the Select clause, never what was typed.
            onFetch={() => testFetch.mutate(queryOf(cur), { onSuccess: (r) => ctx.updateField("query.columns", r.columns) })} />;
        },
        queryColumns: (ctx) => <QueryColumnsSection d={fromRecord(ctx.formData)} update={ctx.update} />,
      }} />
  );
}

function RowsSection({ d, onRows }: { d: Draft; onRows: (rows: Cell[][]) => void }) {
  const i18n = useI18n();
  // Keyed by position: a column's key may be empty or doubled while it is being typed. The column's
  // own type rather than a text box for everything: a boolean reads as a checkbox, a number gets
  // the numeric keypad.
  const columns = useMemo<ListColumn[]>(
    () => ownColumns(d.columns.map((c, i) => ({ key: `c${i}`, label: c.label || c.key, type: c.type }))),
    [d.columns],
  );
  const rows = useMemo(() => d.rows.map((r) => Object.fromEntries(d.columns.map((_, i) => [`c${i}`, r[i] ?? null]))), [d.rows, d.columns]);
  const toCells = (next: Row[]) => next.map((r) => d.columns.map((_, i) => (r[`c${i}`] ?? null) as Cell));

  // Excel/Sheets clipboard = TSV. Types applied per column.
  const pasteRows = (text: string) => {
    const parsed = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.split("\t"));
    if (!parsed.length) return;
    onRows([...d.rows, ...parsed.map((cells) => d.columns.map((c, i) => typed(c, cells[i] ?? "")))]);
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
        <EditGrid title={i18n.getText("ADMIN_ROWS")} columns={columns} rows={rows}
          newRow={() => Object.fromEntries(d.columns.map((_, i) => [`c${i}`, null]))}
          onChange={(next) => onRows(toCells(next))} />
      </GridForm>
    </div>
  );
}

function CacheSection({ syncedAt, rowCount, syncError }: { syncedAt: Date | string | null; rowCount: number; syncError: string | null }) {
  const i18n = useI18n();
  return (
    <Form layout={FORM_LAYOUT} accessibleMode="Display" itemSpacing="Large">
      <FormGroup>
        <FormItem labelContent={<Label showColon>{i18n.getText("ADMIN_LAST_SYNCED")}</Label>}>
          <Text>{syncedAt ? new Date(syncedAt).toLocaleString(formatLocale()) : i18n.getText("ADMIN_NEVER")}</Text>
        </FormItem>
        <FormItem labelContent={<Label showColon>{i18n.getText("ADMIN_CACHED_ROWS")}</Label>}>
          <Text>{i18n.getText(rowCount === 1 ? "ADMIN_ROW_ONE" : "ADMIN_ROW_MANY", rowCount)}</Text>
        </FormItem>
        {syncError ? (
          <FormItem labelContent={<Label showColon>{i18n.getText("ADMIN_LAST_ERROR")}</Label>}>
            <ObjectStatus state="Negative">{syncError}</ObjectStatus>
          </FormItem>
        ) : null}
      </FormGroup>
    </Form>
  );
}

function PreviewSection({ d, preview, fetching, onFetch }: {
  d: Draft;
  preview: { cols: string[]; rows: Cell[][] } | null;
  fetching: boolean;
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
  return preview ? (
    <GridForm name={i18n.getText("ADMIN_PREVIEW")}>
      <Grid title={i18n.getText("ADMIN_PREVIEW")} columns={columns} state={state} rows={rows} fill={false}
        showSettings={false} noDataText={i18n.getText("ADMIN_NO_ROWS_RETURNED")} toolbarActions={() => fetch} />
    </GridForm>
  ) : (
    <IllustratedMessage name="NoData" design="Dot" titleText={i18n.getText("ADMIN_NO_PREVIEW")}
      subtitleText={i18n.getText("ADMIN_NO_PREVIEW_SUB", PREVIEW_TOP, i18n.getText("ADMIN_TEST_FETCH"))}>
      {fetch}
    </IllustratedMessage>
  );
}

/** The Select clause's columns: a label each and whether the value help shows it. Deleting a line
 *  takes the column out of the Select clause. */
function QueryColumnsSection({ d, update }: { d: Draft; update: (fn: (r: Row) => Row) => void }) {
  const i18n = useI18n();
  const columns = useMemo<ListColumn[]>(() => ownColumns([
    { key: "key", label: i18n.getText("ADMIN_KEY"), width: 260, readonly: true },
    { key: "label", label: i18n.getText("ADMIN_LABEL") },
    { key: "shown", label: i18n.getText("ADMIN_VALUE_HELP"), width: 128, type: "boolean" },
  ]), [i18n]);
  const rows = useMemo<Row[]>(
    () => d.query.columns.map((key) => ({ key, label: d.query.labels?.[key] ?? null, shown: !d.query.hidden?.includes(key) })),
    [d.query],
  );
  return (
    <GridForm name={i18n.getText("ADMIN_QUERY_COLUMNS")}>
      <EditGrid title={i18n.getText("ADMIN_QUERY_COLUMNS")} columns={columns} rows={rows} fixedRows
        onChange={(next) => update((r) => {
          const keys = next.map((x) => String(x.key));
          const labels = Object.fromEntries(next.flatMap((x) => (x.label ? [[String(x.key), String(x.label)]] : [])));
          const hidden = next.filter((x) => x.shown === false).map((x) => String(x.key));
          return { ...r, "query.columns": keys, ...prunedColUi(keys, labels, hidden) };
        })} />
    </GridForm>
  );
}
