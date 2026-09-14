import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, Button, Dialog, Form, FormGroup, FormItem, Input, MessageStrip, ObjectStatus, Option, Select,
  StepInput, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text,
} from "@ui5/webcomponents-react";
import { checkModel, QTY_COL, type LookupRef, type ModelDef, type TableColumn, type TableDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { ExprInput } from "./ExprInput.tsx";
import { PAIRS, W, lbl } from "./ParamDialog.tsx";
import { modelWithTable, type TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

const optValue = (e: { detail: { selectedOption: unknown } }) => (e.detail.selectedOption as HTMLElement).dataset.v!;

const newKey = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

/** A manual option list, as one comma-separated field. Enough for "circular, rectangular"; a list
 *  worth maintaining belongs in masterdata, where it is shared across models. */
const manualText = (ref: LookupRef) =>
  ref.source === "manual" ? ref.options.map((o) => String(o.value)).join(", ") : "";
const parseManual = (type: TableColumn["type"], text: string): LookupRef => ({
  source: "manual",
  options: text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((v) => ({ value: type === "number" ? Number(v) : type === "boolean" ? v === "true" : v })),
});

/** Columns the table's own definition leans on: renaming or deleting one would either break the
 *  price split or silently stop writing a mapped SAP field, so both are withheld. Derived rather
 *  than a hardcoded list, so it follows the author if they remap. */
const lockedColumns = (t: TableDef): Set<string> =>
  t.role === "items" ? new Set([QTY_COL, ...Object.keys(t.map ?? {})]) : new Set<string>();

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
  const edit = (fn: (x: TableDef) => TableDef) => setT((x) => fn(x));
  const editCols = (fn: (c: TableColumn[]) => TableColumn[]) =>
    edit((x) => ({ ...x, columns: fn(x.columns) }) as TableDef);
  const setCol = (j: number, patch: Partial<TableColumn>) =>
    editCols((cs) => cs.map((c, k) => (k === j ? ({ ...c, ...patch } as TableColumn) : c)));

  // Only the mapping dropdown depends on SAP. It failing must not block model authoring, so the
  // map cell falls back to a free-text field rather than this dialog refusing to render.
  const lineFields = useQuery({ ...orpc.models.lineFields.queryOptions(), retry: false, staleTime: 60 * 60_000 });

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

  return (
    <Dialog open onClose={onCancel} className="confire-pd"
      accessibleName={`Edit table ${initial.title || initial.key}`}
      style={{ width: "min(76rem, 96vw)" }}
      headerText={isItems ? "Item grid" : "Calculation table"}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!keyOk || keyTaken || !t.columns.length}
              onClick={() => onOk(t)}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "1rem" }}>
        {mine.length ? (
          <MessageStrip design="Negative" hideCloseButton>{mine.map((x) => x.message).join(" · ")}</MessageStrip>
        ) : null}
        {isItems ? (
          <ObjectStatus state="Information">Required — these rows become the quotation lines</ObjectStatus>
        ) : null}

        <Form {...PAIRS}>
          <FormGroup accessibleName="Table">
            <FormItem labelContent={lbl("Key", "The name formulas use. This table contributes <key>_count and one sum per numeric column to every expression scope.", true)}>
              <Input value={t.key} style={W} valueState={keyOk && !keyTaken ? "None" : "Negative"}
                valueStateMessage={<div>{keyTaken ? "Another table already uses this key." : "Must be a valid identifier."}</div>}
                onInput={(e) => edit((x) => ({ ...x, key: e.target.value }) as TableDef)} />
            </FormItem>
            <FormItem labelContent={lbl("Title", "The heading the salesperson sees above the grid on the configuration form.")}>
              <Input value={t.title} style={W}
                onInput={(e) => edit((x) => ({ ...x, title: e.target.value }) as TableDef)} />
            </FormItem>
            {t.role === "calc" ? (
              <>
                <FormItem labelContent={lbl("Minimum rows", "Rows the grid starts with and refuses to drop below. Zero lets the salesperson leave it empty.")}>
                  <StepInput style={W} min={0} value={t.minRows ?? 0}
                    onChange={(e) => edit((x) => ({ ...x, minRows: e.target.value || undefined }) as TableDef)} />
                </FormItem>
                <FormItem labelContent={lbl("Maximum rows", "Caps how many rows can be added. Zero means no cap.")}>
                  <StepInput style={W} min={0} value={t.maxRows ?? 0}
                    onChange={(e) => edit((x) => ({ ...x, maxRows: e.target.value || undefined }) as TableDef)} />
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
                  extraVars={t.columns.map((c) => c.key)}
                  fieldId={`expr-tables[${at}].basisExpr`}
                  issue={issueFor(issues, `tables[${at}].basisExpr`)}
                  onChange={(v) => edit((x) => ({ ...x, basisExpr: v ?? "" }) as TableDef)} />
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
                    <Option key={ty} value={ty} data-v={ty} selected={c.type === ty}>{ty}</Option>
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
                  <Option value="input" data-v="input" selected={c.cell.kind === "input"}>Typed in</Option>
                  <Option value="options" data-v="options" selected={c.cell.kind === "options"}>Options</Option>
                  <Option value="formula" data-v="formula" selected={c.cell.kind === "formula"}>Computed</Option>
                </Select>
              </TableCell>
              <TableCell>
                {c.cell.kind === "formula" ? (
                  // Same scope check.ts applies: the model's identifiers plus this row's
                  // earlier columns. A reference to a later column is an error, not a cycle.
                  <ExprInput value={c.cell.expr} model={scope} tables={tables}
                    extraVars={t.columns.slice(0, j).map((x) => x.key)}
                    fieldId={`expr-tables[${at}].columns[${j}]`}
                    issue={issueFor(issues, `tables[${at}].columns[${j}].cell`)}
                    onChange={(v) => setCol(j, { cell: { kind: "formula", expr: v ?? "" } })} />
                ) : c.cell.kind === "options" ? (
                  <OptionsCell col={c} tables={tables}
                    onChange={(ref) => setCol(j, { cell: { kind: "options", ref } })} />
                ) : (
                  <Text>Typed in by the salesperson</Text>
                )}
              </TableCell>
              {isItems ? (
                <TableCell>
                  <LineFieldSelect value={t.map?.[c.key] ?? ""}
                    fields={lineFields.data ?? null} loading={lineFields.isPending}
                    onChange={(field) =>
                      edit((x) => {
                        const map = { ...((x as Extract<TableDef, { role: "items" }>).map ?? {}) };
                        if (field) map[c.key] = field;
                        else delete map[c.key];
                        return { ...x, map: Object.keys(map).length ? map : undefined } as TableDef;
                      })} />
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

/** Inline source picker: a comma-separated list, or a masterdata table/query column. */
function OptionsCell({ col, tables, onChange }: {
  col: TableColumn;
  tables: TableCols[];
  onChange: (ref: LookupRef) => void;
}) {
  if (col.cell.kind !== "options") return null;
  const ref = col.cell.ref;
  const src = ref.source === "manual" ? "" : ref.table;
  const cols = ref.source === "manual" ? [] : (tables.find((t) => t.name === ref.table)?.columns ?? []);

  return (
    <div style={{ display: "flex", gap: "0.25rem", width: "100%" }}>
      <Select style={{ flex: 1 }} value={src}
        onChange={(e) => {
          const name = optValue(e);
          if (!name) return onChange({ source: "manual", options: [] });
          const kind = tables.find((t) => t.name === name)?.kind;
          // a query ref takes its key/label columns by convention (refKeyCols); a table names one
          onChange(kind === "query" ? { source: "query", table: name } : { source: "table", table: name, valueCol: "" });
        }}>
        <Option value="" data-v="" selected={ref.source === "manual"}>List...</Option>
        {tables.map((t) => (
          <Option key={t.name} value={t.name} data-v={t.name} selected={src === t.name}>{t.name}</Option>
        ))}
      </Select>
      {ref.source === "manual" ? (
        <Input style={{ flex: 2 }} placeholder="circular, rectangular" value={manualText(ref)}
          onInput={(e) => onChange(parseManual(col.type, e.target.value))} />
      ) : ref.source === "table" ? (
        <Select style={{ flex: 1 }} value={ref.valueCol}
          onChange={(e) => onChange({ ...ref, valueCol: optValue(e) })}>
          <Option value="" data-v="" selected={!ref.valueCol}>value column...</Option>
          {cols.map((c) => <Option key={c} value={c} data-v={c} selected={ref.valueCol === c}>{c}</Option>)}
        </Select>
      ) : null}
    </div>
  );
}

/** The tenant's own DocumentLine UDFs when SAP answers, a free-text field when it does not. */
function LineFieldSelect({ value, fields, loading, onChange }: {
  value: string;
  fields: { name: string; label: string; isUDF: boolean }[] | null;
  loading: boolean;
  onChange: (field: string) => void;
}) {
  if (!fields)
    return (
      <Input style={W} value={value} disabled={loading}
        placeholder={loading ? "reading SAP..." : "U_... (SAP unreachable)"}
        onInput={(e) => onChange(e.target.value)} />
    );
  // A seeded mapping (U_CF_ItemCode) only resolves if the tenant actually created the UDF. Keep
  // the value and say so, rather than letting the Select fall blank and drop the mapping silently:
  // the alternative surfaces as a 400 from B1 at the moment the quote is posted.
  const missing = !!value && !fields.some((f) => f.name === value);
  return (
    <Select style={W} value={value} valueState={missing ? "Critical" : "None"}
      valueStateMessage={<div>{`${value} does not exist on this tenant's DocumentLines — create the UDF in B1, or map the column to another field.`}</div>}
      onChange={(e) => onChange(optValue(e))}>
      <Option value="" data-v="" selected={!value}>— not written —</Option>
      {missing ? <Option value={value} data-v={value} selected additionalText="missing">{value}</Option> : null}
      {fields.map((f) => (
        <Option key={f.name} value={f.name} data-v={f.name} selected={value === f.name}
          additionalText={f.isUDF ? "UDF" : undefined}>
          {f.label === f.name ? f.name : `${f.label} (${f.name})`}
        </Option>
      ))}
    </Select>
  );
}
