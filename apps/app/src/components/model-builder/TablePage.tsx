import { useMemo, useState } from "react";
import {
  Bar, Button, CheckBox, ComboBox, ComboBoxItem, Dialog, Form, FormGroup, FormItem, Input, Option, Select,
  StepInput, Text,
} from "@ui5/webcomponents-react";
import { checkModel, QTY_COL, REQUIRED_ITEM_COLS, RESERVED_LINE_FIELDS, type LookupRef, type ModelDef, type TableColumn, type TableDef } from "@confire/config-engine";
import { Grid, GridForm } from "@confire/ui/list-report/Grid.tsx";
import { useFieldConstraints, type EntityConstraints } from "@confire/ui/metadata.ts";
import type { ListColumn } from "@confire/ui/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import { NONE, PAIRS, W, lbl, optValue } from "./ParamForm.tsx";
import { masterdataRef, modelWithTable, rowVars, sourceBadge, type TableCols } from "./exprHelpers.ts";
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

// One row per TableColumn. Module constants: useEditGrid rebuilds its cell templates when the
// column set changes, and a rebuild remounts the input under the cursor.

/** A new calculation table. The role is not a choice: a model has exactly one items table, seeded
 *  by starterModel and undeletable, and every table added in the builder is a calc table. */
export const newCalcTable = (taken: string[], t: Translate): TableDef => ({
  key: newKey("table", taken),
  title: copy(t, "MODEL_DEFAULT_TABLE", "Table"),
  role: "calc",
  columns: [{ key: "value", label: copy(t, "MODEL_COL_VALUE", "Value"), type: "number", cell: { kind: "input" } }],
});

// Buffer-and-commit, like the parameter page: edits land on a local copy so a half-renamed key never runs
// through the draft's checkModel. Placement is not here — that is the structure tree's job.
export function TableDialog({ draft, tables, initial, onCancel, onOk }: {
  draft: ModelDef;
  tables: TableCols[];
  initial: TableDef;
  onCancel: () => void;
  onOk: (t: TableDef) => void;
}) {
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
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
  const [t, setT] = useState<TableDef>(initial);
  // Nothing is wrong until the author says they are done: a half-typed key or an empty option
  // list is a work in progress, not a mistake. Save is the moment that judgement is asked for.
  const [tried, setTried] = useState(false);
  // One cast, here, rather than one at every call site: spreading a discriminated union loses the
  // tag, and every patch below keeps the role it already had.
  const edit = (patch: Partial<TableDef>) => setT((x) => ({ ...x, ...patch }) as TableDef);
  const editCols = (fn: (c: TableColumn[]) => TableColumn[]) =>
    setT((x) => ({ ...x, columns: fn(x.columns) }) as TableDef);
  const setCol = (j: number, patch: Partial<TableColumn>) =>
    editCols((cs) => cs.map((c, k) => (k === j ? ({ ...c, ...patch } as TableColumn) : c)));

  // Only the column mapping depends on SAP. It failing must not block model authoring, so the map
  // cell falls back to a free-text field rather than this dialog refusing to render.
  // The same cached Quotations metadata the B1 pages read: it is served from entity_meta in
  // Postgres and only re-read from $metadata on an explicit Refresh, so a day in the browser costs
  // nothing and a UDF added in B1 shows up as soon as that row is refreshed.
  const schema = useFieldConstraints("Quotations");
  const lineFields = useMemo(() => (schema.data ? lineFieldsOf(schema.data) : null), [schema.data]);

  // Validate against the draft with this buffered table spliced in, so a cell formula reading
  // another of its own aggregates resolves before the table is committed.
  const scope = useMemo(() => modelWithTable(draft, t), [draft, t]);
  const at = (scope.tables ?? []).findIndex((x) => x.key === t.key);
  const issues = useMemo(() => checkModel(scope, tables), [scope, tables]);
  const mine = issues.filter((x) => x.path.startsWith(`tables[${at}]`));

  const isItems = t.role === "items";
  const locked = lockedColumns(t);
  const keyTaken = (draft.tables ?? []).some((x) => x.key === t.key && x.key !== initial.key);
  // Every error is shown on the field it is about, and only there. An issue on the table as a whole
  // (its key colliding with a parameter, say) belongs to the table's key. A mapping to a column the
  // grid no longer has is the one with no field here, and nothing here could fix it: it stays the
  // builder's message rather than locking Save.
  const issueAt = (sub: string) => (tried ? mine.find((x) => x.path === `tables[${at}]${sub}`)?.message : undefined);
  const tableKeyError = tried
    ? (keyProblem(t.key, tr) ?? (keyTaken ? tr("MODEL_TABLE_KEY_TAKEN", t.key) : issueAt("")))
    : undefined;
  const colKeyError = (key: string, j: number) =>
    tried ? (keyProblem(key, tr) ?? issueAt(`.columns[${j}]`) ?? issueAt(`.columns[${j}].key`)) : undefined;
  const blocked = !!keyProblem(t.key, tr) || keyTaken || !t.columns.length
    || t.columns.some((c) => keyProblem(c.key, tr)) || mine.some((x) => x.path !== `tables[${at}].map`);

  const grid = useEditGrid(t.columns, isItems ? itemColumns : columns, {
    key: (c, j) => (
      <Input style={W} value={c.key} readonly={locked.has(c.key)}
        valueState={colKeyError(c.key, j) ? "Negative" : "None"}
        valueStateMessage={<div>{colKeyError(c.key, j)}</div>}
        onInput={(e) => setCol(j, { key: e.target.value })} />
    ),
    label: (c, j) => <Input style={W} value={c.label} onInput={(e) => setCol(j, { label: e.target.value })} />,
    type: (c, j) => (
      <Select style={W} value={c.type}
        onChange={(e) => setCol(j, { type: optValue(e) as TableColumn["type"] })}>
        {(["string", "number", "boolean"] as const).map((ty) => (
          <Option key={ty} value={ty}>{ty}</Option>
        ))}
      </Select>
    ),
    unit: (c, j) => (
      <Input style={W} value={c.unit ?? ""} onInput={(e) => setCol(j, { unit: e.target.value || undefined })} />
    ),
    cell: (c, j) => (
      <Select style={W} value={c.cell.kind}
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
    value: (c, j) =>
      c.cell.kind === "formula" ? (
        // Same scope check.ts applies: the model's identifiers plus this row's
        // earlier columns. A reference to a later column is an error, not a cycle.
        <ExprInput value={c.cell.expr} model={scope} tables={tables}
          extraVars={rowVars(t.columns.slice(0, j), tables)}
          fieldId={`expr-tables[${at}].columns[${j}]`}
          issue={tried ? issueFor(issues, `tables[${at}].columns[${j}].cell`) : undefined}
          onChange={(v) => setCol(j, { cell: { kind: "formula", expr: v ?? "" } })} />
      ) : c.cell.kind === "options" ? (
        <OptionsCell lookup={c.cell.ref} type={c.type} tables={tables} error={issueAt(`.columns[${j}].cell`)}
          onChange={(ref) => setCol(j, { cell: { kind: "options", ref } })} />
      ) : (
        <Text>{tr("MODEL_CELL_INPUT_HINT")}</Text>
      ),
    // Code, name and quantity are what make a row a quotation line: ticked, and not the author's to untick.
    required: (c, j) => (
      <CheckBox accessibleName={tr("MODEL_IS_MANDATORY", c.label || c.key)}
        checked={!!c.required || REQUIRED_ITEM_COLS.has(c.key)} disabled={REQUIRED_ITEM_COLS.has(c.key)}
        onChange={(e) => setCol(j, { required: e.target.checked || undefined })} />
    ),
    // Quantity is not the author's to map: config-quote.ts writes DocumentLine.Quantity itself
    // (row quantity x batch), and RESERVED_LINE_FIELDS rejects a mapping to it — so show where it
    // lands and leave it alone.
    map: (c) =>
      t.role !== "items" ? null
      : c.key === QTY_COL ? (
        <Input style={W} value="Quantity" readonly />
      ) : (
        <LineFieldHelp value={t.map?.[c.key] ?? ""}
          fields={lineFields} loading={schema.isPending} error={issueAt(`.map.${c.key}`)}
          onChange={(field) => {
            const map = { ...(t.map ?? {}) };
            if (field) map[c.key] = field;
            else delete map[c.key];
            edit({ map: Object.keys(map).length ? map : undefined });
          }} />
      ),
  });

  return (
    // Draggable and resizable: the column grid is wide, and the author may want the model behind it.
    <Dialog open onClose={onCancel} className="confire-pd" draggable resizable
      accessibleName={tr("MODEL_EDIT_TABLE", initial.title || initial.key)}
      style={{ width: "min(76rem, 96vw)" }}
      headerText={tr("MODEL_DETAIL_TABLE", isItems ? tr("MODEL_ITEM_GRID") : tr("MODEL_CALC_TABLE"), initial.title || initial.key)}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized"
              onClick={() => (blocked ? setTried(true) : onOk(t))}>{tr("MODEL_SAVE")}</Button>
            <Button design="Transparent" onClick={onCancel}>{tr("MODEL_CANCEL")}</Button>
          </>
        } />
      }
    >

      <Form {...PAIRS} accessibleMode="Edit" headerText={tr("MODEL_DEFINITION")}>
        <FormGroup accessibleName={tr("MODEL_DEFINITION")} columnSpan={2}>
          <FormItem labelContent={lbl(tr("MODEL_KEY"), tr("MODEL_KEY_HELP"), true)}>
            <Input value={t.key} style={W} valueState={tableKeyError ? "Negative" : "None"}
              valueStateMessage={<div>{tableKeyError}</div>}
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

        {isItems ? (
          // Full width and its own group: an expression needs the room, and it is not a field
          // of the grid — it is how the configuration's price is divided between the rows.
          // columnSpan={2} alone is not enough: a group's span is also its inner column-count, so
          // the one item would sit in the left half. ui5-form-group is display:contents, which
          // makes the item a direct child of that multicol box — so column-span reaches it.
          <FormGroup accessibleName={tr("MODEL_COST_BASIS")} columnSpan={2}>
            <FormItem style={{ columnSpan: "all" }}
              labelContent={lbl(tr("MODEL_COST_BASIS"), tr("MODEL_COST_BASIS_HELP"), true)}>
              <ExprInput value={t.basisExpr} model={scope} tables={tables} rows={2} style={W}
                extraVars={rowVars(t.columns, tables)}
                fieldId={`expr-tables[${at}].basisExpr`}
                issue={tried ? issueFor(issues, `tables[${at}].basisExpr`) : undefined}
                onChange={(v) => edit({ basisExpr: v ?? "" })} />
            </FormItem>
          </FormGroup>
        ) : null}
      </Form>

      <GridForm headerText={tr("MODEL_FIELDS")}>
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
                    { key: newKey("col", cs.map((c) => c.key)), label: copy(tr, "MODEL_DEFAULT_FIELD", "Field"), type: "number", cell: { kind: "input" } },
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
    </Dialog>
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
  // one ComboBoxItem per field per row was ~530ms of the dialog's ~920ms open. Typing and the
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
