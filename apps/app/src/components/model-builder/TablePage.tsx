import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CheckBox, ComboBox, ComboBoxItem, Input, Option, Select, Text } from "@ui5/webcomponents-react";
import {
  QTY_COL, REQUIRED_ITEM_COLS, RESERVED_LINE_FIELDS, type LookupRef, type TableColumn, type TableDef,
} from "@confire/config-engine";
import { EditGrid } from "@confire/ui/list-report/EditGrid.tsx";
import { GridForm } from "@confire/ui/list-report/Grid.tsx";
import { ownColumns, useFieldConstraints, type EntityConstraints } from "@confire/ui/metadata.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import type { Control, ListColumn, Row } from "@confire/ui/types.ts";
import {
  checkTable, columnErrors, commitTable, lockedColumns, newColumn, tableIssues, tableSections,
} from "../../features/model/table.ts";
import { useI18n } from "../../i18n.ts";
import { copy, type Translate } from "./builderMessages.ts";
import { builderControls } from "./controls.tsx";
import { useModelDraft } from "./draftScope.tsx";
import { masterdataRef, modelWithTable, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { NONE, W, optValue } from "./ParamForm.tsx";
import type { TableSearch } from "./paramRoute.ts";

/** A manual option list, as one comma-separated field. Enough for "circular, rectangular"; a list
 *  worth maintaining belongs in masterdata, where it is shared across models. */
const manualText = (ref: Extract<LookupRef, { source: "manual" }>) => ref.options.map((o) => String(o.value)).join(", ");
const parseManual = (type: TableColumn["type"], text: string): LookupRef => ({
  source: "manual",
  options: text.split(",").map((s) => s.trim()).filter(Boolean)
    .map((v) => ({ value: type === "number" ? Number(v) : type === "boolean" ? v === "true" : v })),
});

/** One table of the open model, a record of its own. Save writes it into the model record, saves the
 *  model and returns; placement is the structure tree's job. */
export function TablePage({ search }: { search: TableSearch }) {
  const m = useModelDraft();
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  // Read once: a new object resets the record, and a Save renames the table in the model.
  const [initial] = useState(() => (m.def.tables ?? []).find((x) => x.key === search.key));
  const [data] = useState<Row | undefined>(() => initial && structuredClone(initial));
  const sections = useMemo(() => tableSections(tr, initial?.role ?? "calc"), [i18n, initial]);
  // One check per record object: the page's validate and the Fields grid's cells share it.
  const checked = useMemo(() => {
    const seen = new WeakMap<Row, ReturnType<typeof checkTable>>();
    return (r: Row) => {
      let c = seen.get(r);
      if (!c) seen.set(r, (c = checkTable(m.def, m.tableCols, r as TableDef)));
      return c;
    };
  }, [m.def, m.tableCols]);
  const validate = useCallback((r: Row) => tableIssues(r, m.def, m.tableCols, initial?.key ?? "", tr), [m.def, m.tableCols, initial, i18n]);

  if (!initial || !data) return <PageError error={new Error(tr("MODEL_MISSING_TABLE"))} />;
  const back = () => m.id
    ? navigate({ to: "/$slug/models/$id", params: { id: m.id }, search: { section: "params" } })
    : navigate({ to: "/$slug/models/new", search: { section: "params" } });

  return (
    <ObjectPage entity="ModelTable" localViews data={data} sections={sections} validate={validate} alwaysEdit
      header={{
        titleField: "title",
        createTitle: tr("MODEL_DETAIL_TABLE", initial.role === "items" ? tr("MODEL_ITEM_GRID") : tr("MODEL_CALC_TABLE"), initial.title || initial.key),
      }}
      breadcrumbs={[
        { text: tr("NAV_MODELS"), to: "/models" },
        { text: m.def.name.trim() || tr("MODEL_NEW"), to: m.id ? `/models/${m.id}` : "/models/new", search: { section: "params" } },
      ]}
      controls={builderControls({ scope: (c) => modelWithTable(m.def, c.formData as TableDef), tables: m.tableCols })}
      sectionTemplates={{
        fields: (ctx) => (
          <TableFields tb={ctx.formData as TableDef} tables={m.tableCols} checked={checked}
            // One cast, here: spreading a discriminated union loses the tag, and every patch keeps its role.
            edit={(patch) => ctx.update((r) => ({ ...r, ...patch }))} />
        ),
      }}
      onLeave={back}
      onSave={async (_diff, { formData }) => {
        m.saveModel(commitTable(m.def, initial.key, formData as TableDef));
        await back();
      }} />
  );
}

function TableFields({ tb, tables, checked, edit }: {
  tb: TableDef;
  tables: TableCols[];
  checked: (r: Row) => ReturnType<typeof checkTable>;
  edit: (patch: Partial<TableDef>) => void;
}) {
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
  // The grid paints the cells the page's messages list, off the same check.
  const deferred = useDeferredValue(tb);
  const errors = useMemo(() => {
    const c = checked(deferred as unknown as Row);
    return columnErrors(deferred, c.mine, c.at, tr);
  }, [deferred, checked, i18n]);
  const locked = lockedColumns(tb);
  const items = tb.role === "items";

  // Only the column mapping depends on SAP. It failing must not block model authoring, so the map
  // cell falls back to a free-text field rather than this page refusing to render. The same cached
  // Quotations metadata the B1 pages read: served from entity_meta, re-read from $metadata only on an
  // explicit Refresh, so a UDF added in B1 shows up as soon as that row is refreshed.
  const schema = useFieldConstraints(items ? "Quotations" : undefined);
  const lineFields = useMemo(() => (schema.data ? lineFieldsOf(schema.data) : null), [schema.data]);

  // Memoized: EditGrid keeps a cell mounted while its column stays the same.
  const columns = useMemo<ListColumn[]>(() => ownColumns([
    { key: "key", label: tr("MODEL_KEY"), width: 160, controlType: "columnKey", required: true },
    { key: "label", label: tr("MODEL_COL_LABEL"), width: 180, controlType: "text" },
    { key: "type", label: tr("MODEL_COL_TYPE"), width: 128, required: true, options: (["string", "number", "boolean"] as const).map((v) => ({ value: v, label: v })) },
    { key: "unit", label: tr("MODEL_COL_UNIT"), width: 96, controlType: "optionalText" },
    { key: "cell", label: tr("MODEL_COL_CELL"), width: 160, controlType: "cellKind" },
    { key: "value", label: tr("MODEL_COL_OPTIONS"), controlType: "cellValue" },
    ...(items ? [
      { key: "required", label: tr("MODEL_MANDATORY"), width: 112, controlType: "columnRequired" },
      { key: "map", label: tr("MODEL_B1_FIELD"), width: 240, controlType: "lineField" },
    ] : []),
  ]), [i18n, items]);

  const exprs = builderControls({ scope: () => checked(tb as unknown as Row).scope, tables });
  const controls: Record<string, Control> = {
    ...exprs,
    columnKey: (c) => locked.has(String(c.value)) ? <Text>{String(c.value)}</Text> : exprs.text!(c),
    cellKind: (c) => (
      <Select style={W} value={(c.value as TableColumn["cell"]).kind} accessibleName={c.field.label}
        onChange={(e) => {
          const kind = optValue(e) as TableColumn["cell"]["kind"];
          c.onChange(kind === "formula" ? { kind: "formula", expr: "0" }
            : kind === "options" ? { kind: "options", ref: { source: "manual", options: [] } }
            : { kind: "input" });
        }}>
        <Option value="input">{tr("MODEL_CELL_INPUT")}</Option>
        <Option value="options">{tr("MODEL_CELL_OPTIONS")}</Option>
        <Option value="formula">{tr("MODEL_CELL_FORMULA")}</Option>
      </Select>
    ),
    // What the cell holds: a formula (the model's names plus this row's earlier columns — the scope
    // check.ts applies; a later column is an error, not a cycle), a source, or nothing to set.
    cellValue: (c) => {
      const col = c.formData as TableColumn;
      const j = c.rowIndex ?? 0;
      if (col.cell.kind === "formula")
        return exprs.rowExpr!({
          ...c, value: col.cell.expr, formData: { columns: tb.columns.slice(0, j) },
          field: { ...c.field, required: true }, onChange: (v) => c.patch({ cell: { kind: "formula", expr: (v as string | undefined) ?? "" } }),
        });
      if (col.cell.kind === "options")
        return <OptionsCell lookup={col.cell.ref} type={col.type} tables={tables} error={c.error}
          onChange={(ref) => c.patch({ cell: { kind: "options", ref } })} />;
      return <Text>{tr("MODEL_CELL_INPUT_HINT")}</Text>;
    },
    // Code, name and quantity are what make a row a quotation line: ticked, and not the author's to untick.
    columnRequired: (c) => {
      const key = String(c.formData.key);
      return (
        <CheckBox accessibleName={tr("MODEL_IS_MANDATORY", String(c.formData.label || key))}
          checked={!!c.value || REQUIRED_ITEM_COLS.has(key)} disabled={REQUIRED_ITEM_COLS.has(key)}
          onChange={(e) => c.onChange(e.target.checked || undefined)} />
      );
    },
    // Quantity is not the author's to map: config-quote.ts writes DocumentLine.Quantity itself (row
    // quantity x batch), and RESERVED_LINE_FIELDS rejects a mapping to it — so show where it lands.
    lineField: (c) => c.formData.key === QTY_COL ? <Text>Quantity</Text> : (
      <LineFieldHelp value={String(c.value ?? "")} fields={lineFields} loading={schema.isPending} error={c.error}
        onChange={(field) => c.onChange(field || undefined)} />
    ),
  };
  // A line is a column, its SAP field (the table's `map`) riding along so the grid redraws it.
  const map = (tb as { map?: Record<string, string> }).map;
  const rows = useMemo<Row[]>(() => tb.columns.map((c) => ({ ...c, map: map?.[c.key] })), [tb.columns, map]);

  return (
    // A Form of its own for the card padding the definition gets, as the shared table sections do.
    <div data-field="columns">
      <GridForm name={tr("MODEL_FIELDS")}>
        <EditGrid title={tr("MODEL_FIELDS")} table="columns" columns={columns} rows={rows} errors={errors}
          controls={controls}
          newRow={(all) => newColumn(all.map((r) => String(r.key)), copy(tr, "MODEL_DEFAULT_FIELD", "Field")) as unknown as Row}
          onChange={(next) => {
            // Locked fields stay put — their key is read-only for the same reason.
            const kept = next.length < rows.length ? rows.filter((r) => next.includes(r) || locked.has(String(r.key))) : next;
            const map = Object.fromEntries(kept.flatMap((r) => (r.map ? [[String(r.key), String(r.map)]] : [])));
            edit({
              columns: kept.map(({ map: _map, ...c }) => c as TableColumn),
              map: Object.keys(map).length ? map : undefined,
            } as Partial<TableDef>);
          }} />
      </GridForm>
    </div>
  );
}

/** Inline source picker: a comma-separated list, or a masterdata source — which takes its key and
 *  label columns by convention (refKeyCols), same as a parameter's domain. */
function OptionsCell({ lookup, type, tables, error, onChange }: {
  lookup: LookupRef;
  /** the column's type — a manual list is parsed into it */
  type: TableColumn["type"];
  tables: TableCols[];
  /** what is wrong with the picked source — it is always about the masterdata, so it sits on the picker */
  error?: string;
  onChange: (ref: LookupRef) => void;
}) {
  const i18n = useI18n();
  return (
    <div style={{ display: "flex", gap: "0.25rem", width: "100%" }}>
      <Select style={{ flex: 1 }} value={lookup.source === "manual" ? NONE : lookup.table}
        valueState={error ? "Negative" : "None"} valueStateMessage={<div>{error}</div>}
        onChange={(e) => {
          const name = optValue(e);
          onChange(name === NONE ? { source: "manual", options: [] } : masterdataRef(tables.find((t) => t.name === name)));
        }}>
        <Option value={NONE}>{i18n.getText("MODEL_LIST_DOTS")}</Option>
        {tables.map((t) => (
          <Option key={t.name} value={t.name} additionalText={sourceBadge(t, (key, ...params) => i18n.getText(key, ...params))}>{t.name}</Option>
        ))}
      </Select>
      {lookup.source === "manual" ? (
        <Input style={{ flex: 2 }} placeholder={i18n.getText("MODEL_MANUAL_PH")} value={manualText(lookup)}
          onInput={(e) => onChange(parseManual(type, e.target.value))} />
      ) : null}
    </div>
  );
}

type LineField = { name: string; label?: string; type: string; udf: boolean };

/** Every DocumentLine field the tenant's own B1 exposes and a user may set, from the cached
 *  Quotations metadata. Not a curated list: the only ones held back are the collections (a cell is
 *  one value) and the four the price split owns — everything else on that customer's line, UDF or
 *  standard, is theirs to map. UDFs first. */
const lineFieldsOf = (c: EntityConstraints): LineField[] =>
  Object.entries(c.fields.DocumentLines?.Fields ?? {})
    .filter(([name, f]) => f.Type !== "collection" && !RESERVED_LINE_FIELDS.has(name))
    .map(([name, f]) => ({ name, label: f.Label, type: f.Type, udf: !!f.Udf }))
    .sort((a, b) => Number(b.udf) - Number(a.udf) || a.name.localeCompare(b.name));

/** The tenant's own DocumentLine fields as a ComboBox — a local list, not an entity, so no value
 *  help: typing filters it, the description and type ride along as additional text. A free-text
 *  field when SAP is unreachable. */
function LineFieldHelp({ value, fields, loading, error, onChange }: {
  value: string;
  fields: LineField[] | null;
  loading: boolean;
  /** checkModel's verdict on this mapping; outranks the existence warning below */
  error?: string;
  onChange: (field: string) => void;
}) {
  // The items mount on first focus, not with the grid: a tenant's DocumentLine has ~260 fields, and
  // one ComboBoxItem per field per row was ~530ms of the table editor's ~920ms open. Typing and the
  // picker both need focus first, so nothing waits on them.
  const i18n = useI18n();
  const [used, setUsed] = useState(false);
  if (!fields)
    return (
      <Input style={W} value={value} disabled={loading}
        placeholder={loading ? i18n.getText("MODEL_READING_SAP") : i18n.getText("MODEL_SAP_UNREACHABLE")}
        valueState={error ? "Negative" : "None"} valueStateMessage={<div>{error}</div>}
        onInput={(e) => onChange(e.target.value)} />
    );
  // A seeded mapping (U_CF_ItemCode) only resolves if the tenant actually created the UDF. Keep
  // the value and say so, rather than dropping the mapping silently: the alternative surfaces as
  // a 400 from B1 at the moment the quote is posted.
  const missing = !!value && !fields.some((f) => f.name === value);
  return (
    <ComboBox style={W} value={value} filter="Contains" accessibleName={i18n.getText("MODEL_DOCLINE_FIELD")}
      valueState={error ? "Negative" : missing ? "Critical" : "None"}
      valueStateMessage={<div>{error ?? (missing ? i18n.getText("MODEL_FIELD_MISSING", value) : "")}</div>}
      onFocus={() => setUsed(true)}
      onChange={(e) => onChange((e.target.value ?? "").trim())}>
      {used && fields.map((f) => (
        <ComboBoxItem key={f.name} text={f.name}
          additionalText={[f.label && f.label !== f.name ? f.label : "", f.udf ? `${f.type} · UDF` : f.type].filter(Boolean).join(" · ")} />
      ))}
    </ComboBox>
  );
}
