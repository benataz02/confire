import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, Button, Dialog, Form, FormGroup, FormItem, Input, MessageStrip, ObjectStatus, Option, Select,
  StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text,
} from "@ui5/webcomponents-react";
import { checkModel, ITEM_COL, QTY_COL, RESERVED_LINE_FIELDS, type LookupRef, type ModelDef, type TableColumn, type TableDef, type Val } from "@confire/config-engine";
import type { B1EntitySchema, B1Field } from "@confire/b1";
import { orpc } from "../../orpc.ts";
import { ValueHelp } from "../ValueHelp.tsx";
import { ExprInput } from "./ExprInput.tsx";
import { NONE, PAIRS, W, lbl, optValue } from "./ParamDialog.tsx";
import { masterdataRef, modelWithTable, rowVars, sourceBadge, type TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

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
  // The same cached Quotations schema the B1 pages read: it is served from entity_meta in Postgres
  // and only re-read from $metadata on an explicit Refresh, so a day in the browser costs nothing
  // and a UDF added in B1 shows up as soon as that row is refreshed.
  const schema = useQuery({
    ...orpc.entities.schema.queryOptions({ input: { entity: "Quotations" } }),
    retry: false,
    staleTime: 24 * 60 * 60_000,
  });
  const lineFields = useMemo(() => (schema.data ? lineFieldsOf(schema.data) : null), [schema.data]);

  // Validate against the draft with this buffered table spliced in, so a cell formula reading
  // another of its own aggregates resolves before the table is committed.
  const scope = useMemo(() => modelWithTable(draft, t), [draft, t]);
  const at = (scope.tables ?? []).findIndex((x) => x.key === t.key);
  const issues = useMemo(() => checkModel(scope, tables), [scope, tables]);
  const mine = issues.filter((x) => x.path.startsWith(`tables[${at}]`));

  const isItems = t.role === "items";
  const locked = lockedColumns(t);
  const keyOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.key);
  const keyTaken = (draft.tables ?? []).some((x) => x.key === t.key && x.key !== initial.key);
  const blocked = !keyOk || keyTaken || !t.columns.length;
  const errors = tried
    ? [...(t.columns.length ? [] : ["Add at least one column."]), ...mine.map((x) => x.message)]
    : [];

  return (
    <Dialog open onClose={onCancel} className="confire-pd"
      accessibleName={`Edit table ${initial.title || initial.key}`}
      style={{ width: "min(76rem, 96vw)" }}
      headerText={isItems ? "Item grid" : "Calculation table"}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized"
              onClick={() => (blocked ? setTried(true) : onOk(t))}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
        {errors.length ? (
          <MessageStrip design="Negative" hideCloseButton>{errors.join(" · ")}</MessageStrip>
        ) : null}
        {isItems ? (
          <ObjectStatus state="Information">Required — these rows become the quotation lines</ObjectStatus>
        ) : null}

        <Form {...PAIRS}>
          <FormGroup accessibleName="Table">
            <FormItem labelContent={lbl("Key", "The name formulas use. This table contributes <key>_count and one sum per numeric column to every expression scope.", true)}>
              <Input value={t.key} style={W} valueState={!tried || (keyOk && !keyTaken) ? "None" : "Negative"}
                valueStateMessage={<div>{keyTaken ? "Another table already uses this key." : "Must be a valid identifier."}</div>}
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

          {t.role === "items" ? (
            // Full width and its own group: an expression needs the room, and it is not a field
            // of the grid — it is how the configuration's price is divided between the rows.
            <FormGroup accessibleName="Cost basis" columnSpan={2} colSpan="S1 M1 L1 XL1">
              <FormItem labelContent={lbl("Cost basis", "How the configuration's price is divided between rows: evaluated once per row, with that row's own columns in scope, then weighted by the row's quantity. Leave it at 1 to split by quantity alone.", true)}>
                <ExprInput value={t.basisExpr} model={scope} tables={tables} rows={2} style={W}
                  extraVars={rowVars(t.columns, tables)}
                  fieldId={`expr-tables[${at}].basisExpr`}
                  issue={tried ? issueFor(issues, `tables[${at}].basisExpr`) : undefined}
                  onChange={(v) => edit({ basisExpr: v ?? "" })} />
              </FormItem>
            </FormGroup>
          ) : null}
        </Form>

        <Table noDataText="No columns." rowActionCount={1} overflowMode="Scroll"
          onRowActionClick={(e) => {
            const j = Number((e.detail.row as unknown as HTMLElement).dataset.idx);
            editCols((cs) => cs.filter((_, k) => k !== j));
          }}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell width="8rem"><span>Key</span></TableHeaderCell>
              <TableHeaderCell minWidth="9rem"><span>Label</span></TableHeaderCell>
              <TableHeaderCell width="8rem"><span>Type</span></TableHeaderCell>
              <TableHeaderCell width="6rem"><span>Unit</span></TableHeaderCell>
              <TableHeaderCell width="9rem"><span>Cell</span></TableHeaderCell>
              <TableHeaderCell minWidth="14rem"><span>Options / formula</span></TableHeaderCell>
              {isItems ? (
                <TableHeaderCell minWidth="11rem"><span>B1 line field</span></TableHeaderCell>
              ) : null}
            </TableHeaderRow>
          }>
          {t.columns.map((c, j) => (
            <TableRow key={j} rowKey={`col-${j}`} data-idx={String(j)}
              actions={locked.has(c.key) ? undefined : <TableRowAction icon="delete" text="Delete" />}>
              <TableCell>
                <Input value={c.key} readonly={locked.has(c.key)}
                  onInput={(e) => setCol(j, { key: e.target.value })} />
              </TableCell>
              <TableCell>
                <Input value={c.label} onInput={(e) => setCol(j, { label: e.target.value })} />
              </TableCell>
              <TableCell>
                <Select style={W} value={c.type}
                  onChange={(e) => setCol(j, { type: optValue(e) as TableColumn["type"] })}>
                  {(["string", "number", "boolean"] as const).map((ty) => (
                    <Option key={ty} value={ty}>{ty}</Option>
                  ))}
                </Select>
              </TableCell>
              <TableCell>
                <Input value={c.unit ?? ""} onInput={(e) => setCol(j, { unit: e.target.value || undefined })} />
              </TableCell>
              <TableCell>
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
              </TableCell>
              <TableCell>
                {c.cell.kind === "formula" ? (
                  // Same scope check.ts applies: the model's identifiers plus this row's
                  // earlier columns. A reference to a later column is an error, not a cycle.
                  <ExprInput value={c.cell.expr} model={scope} tables={tables}
                    extraVars={rowVars(t.columns.slice(0, j), tables)}
                    fieldId={`expr-tables[${at}].columns[${j}]`}
                    issue={tried ? issueFor(issues, `tables[${at}].columns[${j}].cell`) : undefined}
                    onChange={(v) => setCol(j, { cell: { kind: "formula", expr: v ?? "" } })} />
                ) : c.cell.kind === "options" ? (
                  <OptionsCell lookup={c.cell.ref} type={c.type} tables={tables}
                    onChange={(ref) => setCol(j, { cell: { kind: "options", ref } })} />
                ) : (
                  <Text>Typed in by the salesperson</Text>
                )}
              </TableCell>
              {t.role === "items" ? (
                <TableCell>
                  {/* Quantity is not the author's to map: config-quote.ts writes
                      DocumentLine.Quantity itself (row quantity x batch), and RESERVED_LINE_FIELDS
                      rejects a mapping to it — so show where it lands and leave it alone. */}
                  {c.key === QTY_COL ? (
                    <Input style={W} value="Quantity" readonly />
                  ) : (
                    <LineFieldHelp value={t.map?.[c.key] ?? ""}
                      fields={lineFields} loading={schema.isPending}
                      onChange={(field) => {
                        const map = { ...(t.map ?? {}) };
                        if (field) map[c.key] = field;
                        else delete map[c.key];
                        edit({ map: Object.keys(map).length ? map : undefined });
                      }} />
                  )}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </Table>
        <div>
          <Button icon="add" onClick={() =>
            editCols((cs) => [
              ...cs,
              { key: newKey("col", cs.map((c) => c.key)), label: "Column", type: "number", cell: { kind: "input" } },
            ])}>Add column</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Inline source picker: a comma-separated list, or a masterdata source — which takes its key and
 *  label columns by convention (refKeyCols), same as a parameter's domain. */
function OptionsCell({ lookup, type, tables, onChange }: {
  lookup: LookupRef;
  /** the column's type — a manual list is parsed into it */
  type: TableColumn["type"];
  tables: TableCols[];
  onChange: (ref: LookupRef) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "0.25rem", width: "100%" }}>
      <Select style={{ flex: 1 }} value={lookup.source === "manual" ? NONE : lookup.table}
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

/** Every DocumentLine field the tenant's own B1 exposes and a user may set, from the cached
 *  Quotations schema. Not a curated list: the only ones held back are the collections (a cell is
 *  one value) and the four the price split owns — everything else on that customer's line, UDF or
 *  standard, is theirs to map. */
const lineFieldsOf = (schema: B1EntitySchema): B1Field[] =>
  (schema.fields.find((f) => f.name === "DocumentLines")?.fields ?? [])
    .filter((f) => f.kind !== "collection" && !RESERVED_LINE_FIELDS.has(f.name))
    .sort((a, b) => Number(!!b.isUDF) - Number(!!a.isUDF) || a.name.localeCompare(b.name));

const FIELD_LABELS = { name: "Field", label: "Description", type: "Type" };

/** The tenant's own DocumentLine fields as a value help, a free-text field when SAP is unreachable.
 *  A value help rather than a Select because there are hundreds of them: typing filters, and the
 *  F4 dialog shows the description and type next to the name. Search is local — the whole list is
 *  already in memory, so "the server already searched" does not apply here. */
function LineFieldHelp({ value, fields, loading, onChange }: {
  value: string;
  fields: B1Field[] | null;
  loading: boolean;
  onChange: (field: string) => void;
}) {
  const [search, setSearch] = useState<string | null>(null);

  const shown = useMemo(() => {
    const q = (search ?? "").trim().toLowerCase();
    const all = fields ?? [];
    return q ? all.filter((f) => `${f.name} ${f.label ?? ""}`.toLowerCase().includes(q)) : all;
  }, [fields, search]);
  const table = useMemo(
    () => ({
      columns: ["name", "label", "type"],
      rows: shown.map((f) => [f.name, f.label ?? f.name, f.isUDF ? `${f.kind} · UDF` : f.kind] as Val[]),
    }),
    [shown],
  );
  const options = useMemo(
    () => shown.map((f) => ({ value: f.name as Val, label: f.label && f.label !== f.name ? `${f.label} (${f.name})` : f.name })),
    [shown],
  );

  if (!fields)
    return (
      <Input style={W} value={value} disabled={loading}
        placeholder={loading ? "reading SAP..." : "U_... (SAP unreachable)"}
        onInput={(e) => onChange(e.target.value)} />
    );
  // A seeded mapping (U_CF_ItemCode) only resolves if the tenant actually created the UDF. Keep
  // the value and say so, rather than dropping the mapping silently: the alternative surfaces as
  // a 400 from B1 at the moment the quote is posted.
  const missing = !!value && !fields.some((f) => f.name === value);
  return (
    <ValueHelp
      options={options} value={value || undefined} headerText="DocumentLine field"
      table={table} valueCol="name" columns={["label", "type"]} columnLabels={FIELD_LABELS}
      valueState={missing ? "Critical" : undefined}
      valueStateMessage={missing
        ? `${value} does not exist on this tenant's DocumentLines — create the UDF in B1, or map the column to another field.`
        : undefined}
      onChange={(v) => onChange(v === undefined || v === null ? "" : String(v))}
      onSearch={setSearch} onOpen={() => setSearch("")} />
  );
}
