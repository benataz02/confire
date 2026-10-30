import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Button, CheckBox, ComboBox, ComboBoxItem, Form, FormGroup, FormItem, Input, MessageStrip, Option, Select,
  StepInput, Text,
} from "@ui5/webcomponents-react";
import {
  checkModel, isTableGroup, QTY_COL, REQUIRED_ITEM_COLS, RESERVED_LINE_FIELDS,
  type LookupRef, type ModelDef, type TableColumn, type TableDef,
} from "@confire/config-engine";
import { Grid, GridForm } from "@confire/ui/list-report/Grid.tsx";
import { useFieldConstraints, type EntityConstraints } from "@confire/ui/metadata.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import type { ListColumn, Section } from "@confire/ui/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import { NONE, PAIRS, W, lbl, optValue } from "./ParamForm.tsx";
import type { TableSearch } from "./paramRoute.ts";
import { masterdataRef, modelWithTable, rowVars, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { useModelDraft } from "./draftScope.tsx";
import { issueFor } from "./useDraftModel.ts";
import { positions, useEditGrid } from "./useEditGrid.tsx";
import { useI18n } from "../../i18n.ts";
import { copy, type Translate } from "./builderMessages.ts";

/** What is wrong with a table or field key, in the author's words — formulas read both by key. */
const keyProblem = (key: string, t: Translate) =>
  !key ? t("MODEL_KEY_EMPTY")
  : !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? t("MODEL_KEY_CHARS")
  : undefined;

const newKey = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

/** A manual option list, as one comma-separated field. Enough for "circular, rectangular"; a list
 *  worth maintaining belongs in masterdata, where it is shared across models. */
const manualText = (ref: Extract<LookupRef, { source: "manual" }>) =>
  ref.options.map((o) => String(o.value)).join(", ");
const parseManual = (type: TableColumn["type"], text: string): LookupRef => ({
  source: "manual",
  options: text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => ({ value: type === "number" ? Number(v) : type === "boolean" ? v === "true" : v })),
});

/** Columns the table's own definition leans on: renaming or deleting one would break the price
 *  split, silently stop writing a mapped SAP field, or leave the document history with nothing to
 *  match on. Mapped columns are derived, not hardcoded, so the set follows the author if they remap. */
const lockedColumns = (t: TableDef): Set<string> =>
  t.role === "items" ? new Set([...REQUIRED_ITEM_COLS, ...Object.keys(t.map ?? {})]) : new Set<string>();

/** A new calculation table. The role is not a choice: a model has exactly one items table, seeded
 *  by starterModel and undeletable, and every table added in the builder is a calc table. */
export const newCalcTable = (taken: string[], t: Translate): TableDef => ({
  key: newKey("table", taken),
  title: copy(t, "MODEL_DEFAULT_TABLE", "Table"),
  role: "calc",
  columns: [{ key: "value", label: copy(t, "MODEL_COL_VALUE", "Value"), type: "number", cell: { kind: "input" } }],
});

// The table is the record's one field, so the shared ObjectPage's buffer, dirty mark, discard guard
// and Save/Cancel cover it whole; the two sections are templates over that field.
const CONSTRAINTS: EntityConstraints = {
  name: "ModelTable", label: "", keys: [], writable: true, printable: false, flows: [],
  fields: { table: { Type: "string", EdmType: "", Editable: true } },
};

/** The draft with this buffered table spliced in, checked — so a cell formula reading another of
 *  the table's own aggregates resolves before the table is committed. */
function checkTable(draft: ModelDef, tables: TableCols[], t: TableDef, openedAs: string, tr: Translate) {
  const scope = modelWithTable(draft, t);
  const at = (scope.tables ?? []).findIndex((x) => x.key === t.key);
  const issues = checkModel(scope, tables);
  const mine = issues.filter((x) => x.path.startsWith(`tables[${at}]`));
  const keyTaken = (draft.tables ?? []).some((x) => x.key === t.key && x.key !== openedAs);
  // A mapping to a column the grid no longer has is the one issue with no field here, and nothing
  // here could fix it: it stays the builder's message rather than locking Save.
  const blocked = !!keyProblem(t.key, tr) || keyTaken || !t.columns.length
    || t.columns.some((c) => keyProblem(c.key, tr)) || mine.some((x) => x.path !== `tables[${at}].map`);
  // Every error is shown on the field it is about, and only there — and only once Save was tried.
  const issueAt = (sub: string) => mine.find((x) => x.path === `tables[${at}]${sub}`)?.message;
  return { scope, at, issues, keyTaken, blocked, issueAt };
}

type Part = {
  t: TableDef;
  edit: (patch: Partial<TableDef>) => void;
  draft: ModelDef;
  tables: TableCols[];
  openedAs: string;
  /** Nothing is wrong until the author says they are done: a half-typed key or an empty option
   *  list is a work in progress, not a mistake. Save is the moment that judgement is asked for. */
  tried: boolean;
};

/** One table of the open model. Placement is not here — that is the structure tree's job.
 *  `modelId` absent means the model itself is still unsaved. */
export function TablePage({ modelId, search }: { modelId?: string; search: TableSearch }) {
  const m = useModelDraft();
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  // Read once: a new object resets the page's form, and a Save renames the table in the draft.
  const [initial] = useState(() => (m.draft.tables ?? []).find((x) => x.key === search.key));
  const [data] = useState(() => ({ table: structuredClone(initial) }));
  const [tried, setTried] = useState(false);
  const sections = useMemo<Section[]>(() => [
    { id: "definition", label: tr("MODEL_DEFINITION") },
    { id: "fields", label: tr("MODEL_FIELDS") },
  ], [i18n]);

  const back = () => modelId
    ? navigate({ to: "/$slug/models/$id", params: { id: modelId }, search: { section: "params" } })
    : navigate({ to: "/$slug/models/new", search: { section: "params" } });

  if (!initial)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{tr("MODEL_MISSING_TABLE")}</MessageStrip>;

  const part = (ctx: { formData: Record<string, unknown>; updateField: (key: string, v: unknown) => void }): Part => {
    const t = ctx.formData.table as TableDef;
    // One cast, here, rather than one at every call site: spreading a discriminated union loses
    // the tag, and every patch keeps the role it already had.
    return { t, edit: (patch) => ctx.updateField("table", { ...t, ...patch } as TableDef), draft: m.draft, tables: m.tableCols, openedAs: initial.key, tried };
  };

  return (
    <ObjectPage
      isNew
      entity="ModelTable"
      constraints={CONSTRAINTS}
      data={data}
      sections={sections}
      header={{
        titleField: "table",
        createTitle: tr("MODEL_DETAIL_TABLE", initial.role === "items" ? tr("MODEL_ITEM_GRID") : tr("MODEL_CALC_TABLE"), initial.title || initial.key),
      }}
      localViews
      createLabel={tr("MODEL_SAVE")}
      onCancelCreate={() => void back()}
      breadcrumbs={[
        { text: tr("NAV_MODELS"), to: "/models" },
        { text: m.draft.name.trim() || tr("MODEL_NEW"), to: modelId ? `/models/${modelId}` : "/models/new", search: { section: "params" } },
      ]}
      sectionTemplates={{
        definition: (ctx) => <TableDefinition {...part(ctx)} />,
        fields: (ctx) => <TableFields {...part(ctx)} />,
      }}
      onSave={async (diff) => {
        const t = diff.table as TableDef | undefined;
        if (t) {
          if (checkTable(m.draft, m.tableCols, t, initial.key, tr).blocked) {
            setTried(true);
            throw new Error(tr("MODEL_CHECK_FIELDS"));
          }
          const next = commitTable(m.draft, initial.key, t);
          m.update(() => next);
          // A model that still fails elsewhere keeps the table in its draft and shows why on the
          // page this returns to.
          m.save(next);
        }
        await back();
      }}
    />
  );
}

/** The table written back over the one the page opened; a rename follows into placement, or the
 *  group points at a table that is gone. */
function commitTable(d: ModelDef, openedAs: string, t: TableDef): ModelDef {
  return {
    ...d,
    tables: (d.tables ?? []).map((x) => (x.key === openedAs ? t : x)),
    structure: openedAs === t.key ? d.structure : {
      sections: d.structure.sections.map((sec) => ({
        ...sec,
        groups: sec.groups.map((g) => (isTableGroup(g) && g.table === openedAs ? { table: t.key } : g)),
      })),
    },
  };
}

function TableDefinition({ t, edit, draft, tables, openedAs, tried }: Part) {
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
  const c = useMemo(() => checkTable(draft, tables, t, openedAs, tr), [draft, tables, t, openedAs, i18n]);
  // An issue on the table as a whole (its key colliding with a parameter, say) belongs to its key.
  const keyError = tried
    ? (keyProblem(t.key, tr) ?? (c.keyTaken ? tr("MODEL_TABLE_KEY_TAKEN", t.key) : c.issueAt("")))
    : undefined;
  return (
    <Form {...PAIRS} accessibleMode="Edit">
      <FormGroup accessibleName={tr("MODEL_DEFINITION")} columnSpan={2}>
        <FormItem labelContent={lbl(tr("MODEL_KEY"), tr("MODEL_KEY_HELP"), true)}>
          <Input value={t.key} style={W} valueState={keyError ? "Negative" : "None"}
            valueStateMessage={<div>{keyError}</div>}
            onInput={(e) => edit({ key: e.target.value })} />
        </FormItem>
        <FormItem labelContent={lbl(tr("MODEL_TITLE"), tr("MODEL_TITLE_HELP"))}>
          <Input value={t.title} style={W}
            onInput={(e) => edit({ title: e.target.value })} />
        </FormItem>
        {t.role === "calc" ? (
          <>
            <FormItem labelContent={lbl(tr("MODEL_MIN_ROWS"), tr("MODEL_MIN_ROWS_HELP"))}>
              <StepInput style={W} min={0} value={t.minRows ?? 0}
                onChange={(e) => edit({ minRows: e.target.value || undefined })} />
            </FormItem>
            <FormItem labelContent={lbl(tr("MODEL_MAX_ROWS"), tr("MODEL_MAX_ROWS_HELP"))}>
              <StepInput style={W} min={0} value={t.maxRows ?? 0}
                onChange={(e) => edit({ maxRows: e.target.value || undefined })} />
            </FormItem>
          </>
        ) : null}
      </FormGroup>

      {t.role === "items" ? (
        // Full width and its own group: an expression needs the room, and it is not a field
        // of the grid — it is how the configuration's price is divided between the rows.
        // columnSpan={2} alone is not enough: a group's span is also its inner column-count, so
        // the one item would sit in the left half. ui5-form-group is display:contents, which
        // makes the item a direct child of that multicol box — so column-span reaches it.
        <FormGroup accessibleName={tr("MODEL_COST_BASIS")} columnSpan={2}>
          <FormItem style={{ columnSpan: "all" }}
            labelContent={lbl(tr("MODEL_COST_BASIS"), tr("MODEL_COST_BASIS_HELP"), true)}>
            <ExprInput value={t.basisExpr} model={c.scope} tables={tables} rows={2} style={W}
              extraVars={rowVars(t.columns, tables)}
              fieldId={`expr-tables[${c.at}].basisExpr`}
              issue={tried ? issueFor(c.issues, `tables[${c.at}].basisExpr`) : undefined}
              onChange={(v) => edit({ basisExpr: v ?? "" })} />
          </FormItem>
        </FormGroup>
      ) : null}
    </Form>
  );
}

function TableFields({ t, edit, draft, tables, openedAs, tried }: Part) {
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
  const c = useMemo(() => checkTable(draft, tables, t, openedAs, tr), [draft, tables, t, openedAs, i18n]);
  const issueAt = (sub: string) => (tried ? c.issueAt(sub) : undefined);
  const colKeyError = (key: string, j: number) =>
    tried ? (keyProblem(key, tr) ?? c.issueAt(`.columns[${j}]`) ?? c.issueAt(`.columns[${j}].key`)) : undefined;
  const locked = lockedColumns(t);
  const editCols = (fn: (cs: TableColumn[]) => TableColumn[]) => edit({ columns: fn(t.columns) });
  const setCol = (j: number, patch: Partial<TableColumn>) =>
    editCols((cs) => cs.map((x, k) => (k === j ? ({ ...x, ...patch } as TableColumn) : x)));

  // Memoized: useEditGrid rebuilds its cell templates when the column set changes, and a rebuild
  // remounts the input under the cursor.
  const columns = useMemo<ListColumn[]>(() => [
    { key: "key", label: tr("MODEL_KEY"), width: 160 },
    { key: "label", label: tr("MODEL_COL_LABEL"), width: 180 },
    { key: "type", label: tr("MODEL_COL_TYPE"), width: 128 },
    { key: "unit", label: tr("MODEL_COL_UNIT"), width: 96 },
    { key: "cell", label: tr("MODEL_COL_CELL"), width: 160 },
    { key: "value", label: tr("MODEL_COL_OPTIONS") },
  ], [i18n]);
  const itemColumns = useMemo<ListColumn[]>(() => [
    ...columns,
    { key: "required", label: tr("MODEL_MANDATORY"), width: 112 },
    { key: "map", label: tr("MODEL_B1_FIELD"), width: 240 },
  ], [columns, i18n]);

  // Only the column mapping depends on SAP. It failing must not block model authoring, so the map
  // cell falls back to a free-text field rather than this page refusing to render.
  // The same cached Quotations metadata the B1 pages read: it is served from entity_meta in
  // Postgres and only re-read from $metadata on an explicit Refresh, so a day in the browser costs
  // nothing and a UDF added in B1 shows up as soon as that row is refreshed.
  const schema = useFieldConstraints("Quotations");
  const lineFields = useMemo(() => (schema.data ? lineFieldsOf(schema.data) : null), [schema.data]);

  const grid = useEditGrid(t.columns, t.role === "items" ? itemColumns : columns, {
    key: (col, j) => (
      <Input style={W} value={col.key} readonly={locked.has(col.key)}
        valueState={colKeyError(col.key, j) ? "Negative" : "None"}
        valueStateMessage={<div>{colKeyError(col.key, j)}</div>}
        onInput={(e) => setCol(j, { key: e.target.value })} />
    ),
    label: (col, j) => <Input style={W} value={col.label} onInput={(e) => setCol(j, { label: e.target.value })} />,
    type: (col, j) => (
      <Select style={W} value={col.type}
        onChange={(e) => setCol(j, { type: optValue(e) as TableColumn["type"] })}>
        {(["string", "number", "boolean"] as const).map((ty) => (
          <Option key={ty} value={ty}>{ty}</Option>
        ))}
      </Select>
    ),
    unit: (col, j) => (
      <Input style={W} value={col.unit ?? ""} onInput={(e) => setCol(j, { unit: e.target.value || undefined })} />
    ),
    cell: (col, j) => (
      <Select style={W} value={col.cell.kind}
        onChange={(e) => {
          const kind = optValue(e) as TableColumn["cell"]["kind"];
          setCol(j, {
            cell:
              kind === "formula" ? { kind: "formula", expr: "0" }
              : kind === "options" ? { kind: "options", ref: { source: "manual", options: [] } }
              : { kind: "input" },
          });
        }}>
        <Option value="input">{tr("MODEL_CELL_INPUT")}</Option>
        <Option value="options">{tr("MODEL_CELL_OPTIONS")}</Option>
        <Option value="formula">{tr("MODEL_CELL_FORMULA")}</Option>
      </Select>
    ),
    value: (col, j) =>
      col.cell.kind === "formula" ? (
        // Same scope check.ts applies: the model's identifiers plus this row's
        // earlier columns. A reference to a later column is an error, not a cycle.
        <ExprInput value={col.cell.expr} model={c.scope} tables={tables}
          extraVars={rowVars(t.columns.slice(0, j), tables)}
          fieldId={`expr-tables[${c.at}].columns[${j}]`}
          issue={tried ? issueFor(c.issues, `tables[${c.at}].columns[${j}].cell`) : undefined}
          onChange={(v) => setCol(j, { cell: { kind: "formula", expr: v ?? "" } })} />
      ) : col.cell.kind === "options" ? (
        <OptionsCell lookup={col.cell.ref} type={col.type} tables={tables} error={issueAt(`.columns[${j}].cell`)}
          onChange={(ref) => setCol(j, { cell: { kind: "options", ref } })} />
      ) : (
        <Text>{tr("MODEL_CELL_INPUT_HINT")}</Text>
      ),
    // Code, name and quantity are what make a row a quotation line: ticked, and not the author's to untick.
    required: (col, j) => (
      <CheckBox accessibleName={tr("MODEL_IS_MANDATORY", col.label || col.key)}
        checked={!!col.required || REQUIRED_ITEM_COLS.has(col.key)} disabled={REQUIRED_ITEM_COLS.has(col.key)}
        onChange={(e) => setCol(j, { required: e.target.checked || undefined })} />
    ),
    // Quantity is not the author's to map: config-quote.ts writes DocumentLine.Quantity itself
    // (row quantity x batch), and RESERVED_LINE_FIELDS rejects a mapping to it — so show where it
    // lands and leave it alone.
    map: (col) =>
      t.role !== "items" ? null
      : col.key === QTY_COL ? (
        <Input style={W} value="Quantity" readonly />
      ) : (
        <LineFieldHelp value={t.map?.[col.key] ?? ""}
          fields={lineFields} loading={schema.isPending} error={issueAt(`.map.${col.key}`)}
          onChange={(field) => {
            const map = { ...(t.map ?? {}) };
            if (field) map[col.key] = field;
            else delete map[col.key];
            edit({ map: Object.keys(map).length ? map : undefined });
          }} />
      ),
  });

  return (
    // A Form of its own for the card padding the definition gets, as the shared table sections do.
    <GridForm name={tr("MODEL_FIELDS")}>
      {/* Not an empty-state hint: the one place "no fields" (which blocks Save) is reported. */}
      <Grid {...grid} title={tr("MODEL_FIELDS")} fill={false} selectionMode="Multiple"
        noDataText={tried ? tr("MODEL_FIELDS_EMPTY") : undefined}
        toolbarActions={(sel) => {
          // Locked fields stay put — their key is read-only for the same reason.
          const gone = new Set([...positions(sel.rows)].filter((j) => !locked.has(t.columns[j]?.key ?? "")));
          return (
            <>
              <Button icon="add" design="Transparent" onClick={() =>
                editCols((cs) => [
                  ...cs,
                  { key: newKey("col", cs.map((x) => x.key)), label: copy(tr, "MODEL_DEFAULT_FIELD", "Field"), type: "number", cell: { kind: "input" } },
                ])}>{tr("MODEL_ADD_FIELD")}</Button>
              <Button icon="delete" design="Transparent" disabled={!gone.size}
                onClick={() => {
                  // row ids are positions, so a kept selection would land on the rows that moved up
                  sel.clear();
                  editCols((cs) => cs.filter((_, k) => !gone.has(k)));
                }}>{tr("MODEL_DELETE")}</Button>
            </>
          );
        }} />
    </GridForm>
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
          onChange(name === NONE
            ? { source: "manual", options: [] }
            : masterdataRef(tables.find((t) => t.name === name)));
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
