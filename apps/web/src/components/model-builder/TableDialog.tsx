import { useMemo, useState } from "react";
import {
  Bar, Button, ComboBox, ComboBoxItem, Dialog, Form, FormGroup, FormItem, Input, Option, Select,
  StepInput, Text,
} from "@ui5/webcomponents-react";
import { checkModel, ITEM_COL, QTY_COL, RESERVED_LINE_FIELDS, type LookupRef, type ModelDef, type TableColumn, type TableDef } from "@confire/config-engine";
import { Grid } from "../../shared/list-report/Grid.tsx";
import { useFieldConstraints, type EntityConstraints } from "../../shared/metadata.ts";
import type { ListColumn } from "../../shared/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import { NONE, PAIRS, W, lbl, optValue } from "./ParamDialog.tsx";
import { masterdataRef, modelWithTable, rowVars, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { GridForm, positions, useEditGrid } from "./useEditGrid.tsx";

/** What is wrong with a table or field key, in the author's words — formulas read both by key. */
const keyProblem = (key: string) =>
  !key ? "Enter a key: formulas use it to read this value."
  : !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? "Use letters, digits and underscores only, and don't start with a digit."
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
  t.role === "items" ? new Set([QTY_COL, ITEM_COL, ...Object.keys(t.map ?? {})]) : new Set<string>();

// One row per TableColumn. Module constants: useEditGrid rebuilds its cell templates when the
// column set changes, and a rebuild remounts the input under the cursor.
const COLUMNS: ListColumn[] = [
  { key: "key", label: "Key", width: 160 },
  { key: "label", label: "Label", width: 180 },
  { key: "type", label: "Type", width: 128 },
  { key: "unit", label: "Unit", width: 96 },
  { key: "cell", label: "Cell", width: 160 },
  { key: "value", label: "Options / formula" },
];
// The items table also says where each column lands on the quotation line.
const ITEM_COLUMNS: ListColumn[] = [...COLUMNS, { key: "map", label: "B1 line field", width: 240 }];

/** A new calculation table. The role is not a choice: a model has exactly one items table, seeded
 *  by starterModel and undeletable, and every table added in the builder is a calc table. */
export const newCalcTable = (taken: string[]): TableDef => ({
  key: newKey("table", taken),
  title: "Table",
  role: "calc",
  columns: [{ key: "value", label: "Value", type: "number", cell: { kind: "input" } }],
});

// Buffer-and-commit, like ParamDialog: edits land on a local copy so a half-renamed key never runs
// through the draft's checkModel. Placement is not here — that is the structure tree's job.
export function TableDialog({ draft, tables, initial, onCancel, onOk }: {
  draft: ModelDef;
  tables: TableCols[];
  initial: TableDef;
  onCancel: () => void;
  onOk: (t: TableDef) => void;
}) {
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
    ? (keyProblem(t.key) ?? (keyTaken ? `Another table is already called '${t.key}'.` : issueAt("")))
    : undefined;
  const colKeyError = (key: string, j: number) =>
    tried ? (keyProblem(key) ?? issueAt(`.columns[${j}]`) ?? issueAt(`.columns[${j}].key`)) : undefined;
  const blocked = !!keyProblem(t.key) || keyTaken || !t.columns.length
    || t.columns.some((c) => keyProblem(c.key)) || mine.some((x) => x.path !== `tables[${at}].map`);

  const grid = useEditGrid(t.columns, isItems ? ITEM_COLUMNS : COLUMNS, {
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
        <Option value="input">Typed in</Option>
        <Option value="options">Options</Option>
        <Option value="formula">Computed</Option>
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
        <Text>Typed in by the salesperson</Text>
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
      accessibleName={`Edit table ${initial.title || initial.key}`}
      style={{ width: "min(76rem, 96vw)" }}
      headerText={`${isItems ? "Item grid" : "Calculation table"} · ${initial.title || initial.key}`}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized"
              onClick={() => (blocked ? setTried(true) : onOk(t))}>Save</Button>
            <Button design="Transparent" onClick={onCancel}>Cancel</Button>
          </>
        } />
      }
    >

      <Form {...PAIRS} accessibleMode="Edit" >
        <FormGroup accessibleName="Definition" columnSpan={2}>
          <FormItem labelContent={lbl("Key", "The name formulas use. This table contributes <key>_count and one sum per numeric column to every expression scope.", true)}>
            <Input value={t.key} style={W} valueState={tableKeyError ? "Negative" : "None"}
              valueStateMessage={<div>{tableKeyError}</div>}
              onInput={(e) => edit({ key: e.target.value })} />
          </FormItem>
          <FormItem labelContent={lbl("Title", "The heading the salesperson sees above the grid on the configuration form.")}>
            <Input value={t.title} style={W}
              onInput={(e) => edit({ title: e.target.value })} />
          </FormItem>
          {t.role === "calc" ? (
            <>
              <FormItem labelContent={lbl("Minimum rows", "Rows the grid starts with and refuses to drop below. Zero lets the salesperson leave it empty.")}>
                <StepInput style={W} min={0} value={t.minRows ?? 0}
                  onChange={(e) => edit({ minRows: e.target.value || undefined })} />
              </FormItem>
              <FormItem labelContent={lbl("Maximum rows", "Caps how many rows can be added. Zero means no cap.")}>
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
          <FormGroup accessibleName="Cost basis" columnSpan={2}>
            <FormItem style={{ columnSpan: "all" }}
              labelContent={lbl("Cost basis", "How the configuration's price is divided between rows: evaluated once per row, with that row's own columns in scope, then weighted by the row's quantity. Leave it at 1 to split by quantity alone.", true)}>
              <ExprInput value={t.basisExpr} model={scope} tables={tables} rows={2} style={W}
                extraVars={rowVars(t.columns, tables)}
                fieldId={`expr-tables[${at}].basisExpr`}
                issue={tried ? issueFor(issues, `tables[${at}].basisExpr`) : undefined}
                onChange={(v) => edit({ basisExpr: v ?? "" })} />
            </FormItem>
          </FormGroup>
        ) : null}
      </Form>

      <GridForm name="Fields">
        <Grid {...grid} title="Fields" fill={false} selectionMode="Multiple"
          noDataText={tried ? "Add at least one field: the salesperson needs something to fill in." : "No fields yet"}
          toolbarActions={(sel) => {
            // Locked fields stay put — their key is read-only for the same reason.
            const gone = new Set([...positions(sel.rows)].filter((j) => !locked.has(t.columns[j]?.key ?? "")));
            return (
              <>
                <Button icon="add" design="Transparent" onClick={() =>
                  editCols((cs) => [
                    ...cs,
                    { key: newKey("col", cs.map((c) => c.key)), label: "Field", type: "number", cell: { kind: "input" } },
                  ])}>Add field</Button>
                <Button icon="delete" design="Transparent" disabled={!gone.size}
                  onClick={() => {
                    // row ids are positions, so a kept selection would land on the rows that moved up
                    sel.clear();
                    editCols((cs) => cs.filter((_, k) => !gone.has(k)));
                  }}>Delete</Button>
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
        <Option value={NONE}>List...</Option>
        {tables.map((t) => (
          <Option key={t.name} value={t.name} additionalText={sourceBadge(t)}>{t.name}</Option>
        ))}
      </Select>
      {lookup.source === "manual" ? (
        <Input style={{ flex: 2 }} placeholder="circular, rectangular" value={manualText(lookup)}
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
  const [used, setUsed] = useState(false);
  if (!fields)
    return (
      <Input style={W} value={value} disabled={loading}
        placeholder={loading ? "reading SAP..." : "U_... (SAP unreachable)"}
        valueState={error ? "Negative" : "None"} valueStateMessage={<div>{error}</div>}
        onInput={(e) => onChange(e.target.value)} />
    );
  // A seeded mapping (U_CF_ItemCode) only resolves if the tenant actually created the UDF. Keep
  // the value and say so, rather than dropping the mapping silently: the alternative surfaces as
  // a 400 from B1 at the moment the quote is posted.
  const missing = !!value && !fields.some((f) => f.name === value);
  return (
    <ComboBox style={W} value={value} filter="Contains" accessibleName="DocumentLine field"
      valueState={error ? "Negative" : missing ? "Critical" : "None"}
      valueStateMessage={<div>{error ?? (missing
        ? `${value} isn't a field on this company's quotation lines — create the UDF in B1, or pick another field.`
        : "")}</div>}
      onFocus={() => setUsed(true)}
      onChange={(e) => onChange((e.target.value ?? "").trim())}>
      {used && fields.map((f) => (
        <ComboBoxItem key={f.name} text={f.name}
          additionalText={[f.label && f.label !== f.name ? f.label : "", f.udf ? `${f.type} · UDF` : f.type].filter(Boolean).join(" · ")} />
      ))}
    </ComboBox>
  );
}
