import { useMemo, useState } from "react";
import {
  Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label,
  MultiComboBox, MultiComboBoxItem, Option, Select, Text,
} from "@ui5/webcomponents-react";
import type { Constraint, Issue, ModelDef, ResolvedLookups, Val } from "@confire/config-engine";
import { Grid } from "../../shared/list-report/Grid.tsx";
import type { ListColumn } from "../../shared/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { GridForm, positionOf, positions, useEditGrid } from "./useEditGrid.tsx";
import { confirm } from "../confirm.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type TableConstraint = Extract<Constraint, { kind: "table" }>;
// Combination-table cells are scalar (no string[] multicombo values), unlike the full Val union.
type Cell = Exclude<Val, string[]>;

const FORM = { accessibleMode: "Edit", layout: "S1 M2 L2 XL2", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;

const EXPR_COLUMNS: ListColumn[] = [
  { key: "when", label: "When (optional)" },
  { key: "assert", label: "Must hold" },
  { key: "message", label: "Message" },
];
const TABLE_COLUMNS: ListColumn[] = [
  { key: "params", label: "Parameters" },
  { key: "mode", label: "Mode" },
  { key: "rows", label: "Rows" },
];

// "true"/"false" -> boolean, numeric -> number, "" -> null, else string.
export const parseLit = (s: string): Cell =>
  s === "" ? null : s === "true" ? true : s === "false" ? false : !Number.isNaN(Number(s)) ? Number(s) : s;

// Each table in a Form of its own (GridForm); the Grid toolbar names it, with its row count.
export function RulesTab({ draft, update, issues, lookups, tables = [] }: {
  draft: ModelDef; update: Update; issues: Issue[]; lookups?: ResolvedLookups; tables?: TableCols[];
}) {
  const [editingTable, setEditingTable] = useState<number | null>(null);
  const setC = (i: number, c: Constraint) =>
    update((d) => ({ ...d, constraints: d.constraints.map((x, j) => (j === i ? c : x)) }));
  const removeCs = (gone: Set<number>) =>
    update((d) => ({ ...d, constraints: d.constraints.filter((_, j) => !gone.has(j)) }));

  // Each kind with its index into draft.constraints, which is what every edit addresses.
  const exprs = useMemo(
    () => draft.constraints.flatMap((c, i) => (c.kind === "expr" ? [{ c, i }] : [])),
    [draft.constraints],
  );
  const tablesC = useMemo(
    () => draft.constraints.flatMap((c, i) => (c.kind === "table" ? [{ c, i }] : [])),
    [draft.constraints],
  );

  const exprGrid = useEditGrid(exprs, EXPR_COLUMNS, {
    when: ({ c, i }) => (
      <ExprInput optional value={c.when} model={draft} tables={tables} fieldId={`expr-constraints[${i}].when`}
        issue={issueFor(issues, `constraints[${i}].when`)}
        onChange={(v) => setC(i, { ...c, when: v })} />
    ),
    assert: ({ c, i }) => (
      <ExprInput value={c.assert} model={draft} tables={tables} fieldId={`expr-constraints[${i}].assert`}
        issue={issueFor(issues, `constraints[${i}].assert`)} placeholder='e.g. coating != "none" || material == "steel"'
        onChange={(v) => setC(i, { ...c, assert: v ?? "" })} />
    ),
    message: ({ c, i }) => (
      <Input style={{ width: "100%" }} value={c.message} placeholder="Shown when violated"
        onInput={(e) => setC(i, { ...c, message: e.target.value })} />
    ),
  });

  const tableGrid = useEditGrid(tablesC, TABLE_COLUMNS, {
    params: ({ c }) => c.params.join(" × ") || "—",
    mode: ({ c }) => c.mode,
    rows: ({ c }) => c.rows.length,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <GridForm name="Expression constraints">
        <Grid {...exprGrid} title="Expression constraints" fill={false} selectionMode="Multiple"
          noDataText='No expression constraints. Add rules like coating != "none" that must hold across the configuration.'
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => update((d) => ({ ...d, constraints: [...d.constraints, { kind: "expr", assert: "", message: "" }] }))}>
                Add constraint
              </Button>
              {/* Expression rows are a single line, so they delete without a prompt. */}
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={() => {
                  const gone = new Set([...positions(sel.rows)].map((p) => exprs[p]!.i));
                  sel.clear();
                  removeCs(gone);
                }}>
                Delete
              </Button>
            </>
          )} />
      </GridForm>
      <GridForm name="Combination tables">
        <Grid {...tableGrid} title="Combination tables" fill={false} selectionMode="Multiple"
          noDataText="No combination tables. Add one to allow or forbid specific combinations of parameter values."
          onRowClick={(row) => setEditingTable(tablesC[positionOf(row)]!.i)}
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => {
                  update((d) => ({ ...d, constraints: [...d.constraints, { kind: "table", params: [], rows: [], mode: "forbid" }] }));
                  setEditingTable(draft.constraints.length);
                }}>
                Add combination table
              </Button>
              {/* Combination tables can hold a lot of hand-entered rows — confirm before discarding them. */}
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={async () => {
                  const picked = [...positions(sel.rows)].map((p) => tablesC[p]!);
                  const rows = picked.reduce((n, t) => n + t.c.rows.length, 0);
                  if (rows && !await confirm({
                    title: "Delete combination tables",
                    message: `Delete ${picked.length === 1 ? "this combination table" : `${picked.length} combination tables`} and ${rows} row${rows === 1 ? "" : "s"}?`,
                    actionText: "Delete", destructive: true,
                  })) return;
                  sel.clear();
                  removeCs(new Set(picked.map((t) => t.i)));
                }}>
                Delete
              </Button>
            </>
          )} />
      </GridForm>
      {editingTable !== null && draft.constraints[editingTable]?.kind === "table" ? (
        <ComboTableDialog
          draft={draft} lookups={lookups}
          value={draft.constraints[editingTable] as TableConstraint}
          onOk={(c) => { setC(editingTable, c); setEditingTable(null); }}
          onCancel={() => setEditingTable(null)}
        />
      ) : null}
    </div>
  );
}

function ComboTableDialog({ draft, lookups, value, onOk, onCancel }: {
  draft: ModelDef; lookups?: ResolvedLookups; value: TableConstraint;
  onOk: (c: TableConstraint) => void; onCancel: () => void;
}) {
  const [c, setCLocal] = useState<TableConstraint>(structuredClone(value));
  // Only finite params can appear in a combination table (checkModel enforces the same).
  const eligible = draft.parameters.filter((p) => !p.excludeFromDomains && (p.domain?.kind === "options" || p.type === "boolean"));
  const optionsFor = (key: string): Cell[] | null => {
    const p = draft.parameters.find((x) => x.key === key);
    if (p?.type === "boolean") return [true, false];
    // Combination-eligible params carry scalar option values; narrow the wider Val to Cell.
    if (p?.domain?.kind === "options" && p.domain.ref.source === "manual") return p.domain.ref.options.map((o) => o.value as Cell);
    // Empty (a query domain the preview no longer resolves eagerly) falls back to free text.
    const dom = lookups?.domains[key];
    return dom?.length ? dom.map((o) => o.value as Cell) : null;
  };

  const setParams = (params: string[]) =>
    setCLocal((x) => ({
      ...x,
      params,
      rows: x.rows.map((r) => params.map((k) => r[x.params.indexOf(k)] ?? null)),
    }));

  const columns = useMemo<ListColumn[]>(() => c.params.map((k) => ({ key: k, label: k })), [c.params]);
  const setCell = (ri: number, ci: number, v: Cell) =>
    setCLocal((x) => ({ ...x, rows: x.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? v : cell)) : r)) }));
  const grid = useEditGrid(c.rows, columns, Object.fromEntries(c.params.map((k, ci) => {
    const opts = optionsFor(k);
    return [k, (row: TableConstraint["rows"][number], ri: number) => opts ? (
      <Select style={{ width: "100%" }} value={JSON.stringify(row[ci] ?? null)}
        onChange={(e) => setCell(ri, ci, JSON.parse((e.detail.selectedOption as HTMLElement).dataset.j!))}>
        <Option value="null" data-j="null">—</Option>
        {opts.map((v, oi) => (
          <Option key={oi} value={JSON.stringify(v)} data-j={JSON.stringify(v)}>{String(v)}</Option>
        ))}
      </Select>
    ) : (
      <Input style={{ width: "100%" }} value={String(row[ci] ?? "")} onInput={(e) => setCell(ri, ci, parseLit(e.target.value))} />
    )];
  })));

  return (
    <Dialog open headerText="Combination table" onClose={onCancel} style={{ width: "min(52rem, 92vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={c.params.length < 2} onClick={() => onOk(c)}>OK</Button>
            <Button design="Transparent" onClick={onCancel}>Cancel</Button>
          </>
        } />
      }>
      <Form {...FORM} headerText="Definition">
        <FormGroup accessibleName="Definition">
          <FormItem labelContent={<Label required>Parameters (2+)</Label>}>
            <MultiComboBox style={{ width: "100%" }}
              onSelectionChange={(e) => setParams(e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!))}>
              {eligible.map((p) => (
                <MultiComboBoxItem key={p.key} text={p.key} selected={c.params.includes(p.key)} />
              ))}
            </MultiComboBox>
          </FormItem>
          <FormItem labelContent={<Label>Mode</Label>}>
            <Select style={{ width: "100%" }} value={c.mode}
              onChange={(e) => setCLocal((x) => ({ ...x, mode: e.detail.selectedOption.value as "allow" | "forbid" }))}>
              <Option value="allow">Allow only these</Option>
              <Option value="forbid">Forbid these</Option>
            </Select>
          </FormItem>
        </FormGroup>
      </Form>
      {c.params.length >= 2 ? (
        <GridForm name="Combination rows">
          <Grid {...grid} title="Combination rows" fill={false} selectionMode="Multiple" noDataText="No rows yet."
            toolbarActions={(sel) => (
              <>
                <Button icon="add" design="Transparent"
                  onClick={() => setCLocal((x) => ({ ...x, rows: [...x.rows, x.params.map(() => null)] }))}>
                  Add row
                </Button>
                <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                  onClick={() => {
                    const gone = positions(sel.rows);
                    sel.clear();
                    setCLocal((x) => ({ ...x, rows: x.rows.filter((_, j) => !gone.has(j)) }));
                  }}>
                  Delete
                </Button>
              </>
            )} />
        </GridForm>
      ) : <Text>Pick at least two parameters, then add rows.</Text>}
    </Dialog>
  );
}
