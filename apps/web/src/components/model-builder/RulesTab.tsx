import { useState } from "react";
import {
  Bar, Button, Dialog, Form, FormGroup, FormItem, IllustratedMessage, Input, Label,
  MultiComboBox, MultiComboBoxItem, ObjectPageSubSection, Option, Select, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { Constraint, Issue, ModelDef, ResolvedLookups, Val } from "@confire/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { confirm } from "../confirm.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type TableConstraint = Extract<Constraint, { kind: "table" }>;
// Combination-table cells are scalar (no string[] multicombo values), unlike the full Val union.
type Cell = Exclude<Val, string[]>;

const TABLE_FORM = { accessibleMode: "Edit", layout: "S1 M1 L1 XL1", headerLevel: "H5" } as const;
const FIELD_FORM = { accessibleMode: "Edit", layout: "S1 M2 L2 XL2", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;

// "true"/"false" -> boolean, numeric -> number, "" -> null, else string.
export const parseLit = (s: string): Cell =>
  s === "" ? null : s === "true" ? true : s === "false" ? false : !Number.isNaN(Number(s)) ? Number(s) : s;

const titled = (label: string, n: number) => (n ? `${label} (${n})` : label);

export function RulesTab({ draft, update, issues, lookups, tables = [] }: {
  draft: ModelDef; update: Update; issues: Issue[]; lookups?: ResolvedLookups; tables?: TableCols[];
}) {
  const [editingTable, setEditingTable] = useState<number | null>(null);
  const setC = (i: number, c: Constraint) =>
    update((d) => ({ ...d, constraints: d.constraints.map((x, j) => (j === i ? c : x)) }));
  const removeC = (i: number) => update((d) => ({ ...d, constraints: d.constraints.filter((_, j) => j !== i) }));
  // Combination tables can hold a lot of hand-entered rows — confirm before discarding a non-empty one.
  // Expression rows are a single line, so they delete without a prompt.
  const removeTableC = async (i: number) => {
    const c = draft.constraints[i];
    const rows = c?.kind === "table" ? c.rows.length : 0;
    if (rows === 0 || await confirm({ title: "Delete combination table", message: `Delete this combination table and its ${rows} row${rows === 1 ? "" : "s"}?`, actionText: "Delete", destructive: true }))
      removeC(i);
  };

  const exprs = draft.constraints.map((c, i) => [c, i] as const).filter(([c]) => c.kind === "expr");
  const tablesC = draft.constraints.map((c, i) => [c, i] as const).filter(([c]) => c.kind === "table");

  return (
    <>
      <ObjectPageSubSection id="expr-constraints" titleText={titled("Expression constraints", exprs.length)}
        actions={
          <Button icon="add" design="Transparent"
            onClick={() => update((d) => ({ ...d, constraints: [...d.constraints, { kind: "expr", assert: "", message: "" }] }))}>
            Add constraint
          </Button>
        }>
        <Form {...TABLE_FORM}>
          <FormGroup accessibleName="Expression constraints">
            <Table accessibleName="Expression constraints" overflowMode="Popin" rowActionCount={1}
              noData={<IllustratedMessage name="NoData" design="Dot" titleText="No expression constraints"
                subtitleText='Add rules like coating != "none" that must hold across the configuration.' />}
              onRowActionClick={(e) => removeC(Number(((e.detail.row as unknown) as HTMLElement).dataset.idx))}
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem" width="28%">When (optional)</TableHeaderCell>
                  <TableHeaderCell minWidth="16rem" width="36%">Must hold</TableHeaderCell>
                  <TableHeaderCell minWidth="10rem">Message</TableHeaderCell>
                </TableHeaderRow>
              }>
              {exprs.map(([c, i]) => c.kind === "expr" ? (
                <TableRow key={i} rowKey={`ec-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
                  <TableCell>
                    <ExprInput optional value={c.when} model={draft} tables={tables} fieldId={`expr-constraints[${i}].when`}
                      issue={issueFor(issues, `constraints[${i}].when`)}
                      onChange={(v) => setC(i, { ...c, when: v })} />
                  </TableCell>
                  <TableCell>
                    <ExprInput value={c.assert} model={draft} tables={tables} fieldId={`expr-constraints[${i}].assert`}
                      issue={issueFor(issues, `constraints[${i}].assert`)} placeholder='e.g. coating != "none" || material == "steel"'
                      onChange={(v) => setC(i, { ...c, assert: v ?? "" })} />
                  </TableCell>
                  <TableCell>
                    <Input value={c.message} placeholder="Shown when violated"
                      onInput={(e) => setC(i, { ...c, message: e.target.value })} />
                  </TableCell>
                </TableRow>
              ) : null)}
            </Table>
          </FormGroup>
        </Form>
      </ObjectPageSubSection>

      <ObjectPageSubSection id="combination-tables" titleText={titled("Combination tables", tablesC.length)}
        actions={
          <Button icon="add" design="Transparent"
            onClick={() => {
              update((d) => ({ ...d, constraints: [...d.constraints, { kind: "table", params: [], rows: [], mode: "forbid" }] }));
              setEditingTable(draft.constraints.length);
            }}>
            Add combination table
          </Button>
        }>
        <Form {...TABLE_FORM}>
          <FormGroup accessibleName="Combination tables">
            <Table accessibleName="Combination tables" overflowMode="Popin" rowActionCount={2}
              noData={<IllustratedMessage name="NoData" design="Dot" titleText="No combination tables"
                subtitleText="Add a table to allow or forbid specific combinations of parameter values." />}
              onRowActionClick={(e) => {
                const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
                const icon = ((e.detail.action as unknown) as HTMLElement).getAttribute("icon");
                if (icon === "delete") void removeTableC(i);
                else setEditingTable(i);
              }}
              headerRow={
                <TableHeaderRow>
                  <TableHeaderCell minWidth="12rem">Parameters</TableHeaderCell>
                  <TableHeaderCell minWidth="8rem">Mode</TableHeaderCell>
                  <TableHeaderCell minWidth="6rem">Rows</TableHeaderCell>
                </TableHeaderRow>
              }>
              {tablesC.map(([c, i]) => c.kind === "table" ? (
                <TableRow key={i} rowKey={`tc-${i}`} data-idx={String(i)}
                  actions={<><TableRowAction icon="edit" text="Edit" /><TableRowAction icon="delete" text="Delete" /></>}>
                  <TableCell><Text>{c.params.join(" × ") || "—"}</Text></TableCell>
                  <TableCell><Text>{c.mode}</Text></TableCell>
                  <TableCell><Text>{String(c.rows.length)}</Text></TableCell>
                </TableRow>
              ) : null)}
            </Table>
          </FormGroup>
        </Form>
      </ObjectPageSubSection>

      {editingTable !== null && draft.constraints[editingTable]?.kind === "table" ? (
        <ComboTableDialog
          draft={draft} lookups={lookups}
          value={draft.constraints[editingTable] as TableConstraint}
          onOk={(c) => { setC(editingTable, c); setEditingTable(null); }}
          onCancel={() => setEditingTable(null)}
        />
      ) : null}
    </>
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
      <Form {...FIELD_FORM} headerText="Definition">
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
      </Form>
      <Form {...TABLE_FORM} headerText={titled("Rows", c.rows.length)}>
        <FormGroup accessibleName="Rows">
          {c.params.length >= 2 ? (
            <>
              <Toolbar design="Transparent" accessibleName="Combination row actions">
                <ToolbarButton icon="add" design="Transparent" text="Add row"
                  onClick={() => setCLocal((x) => ({ ...x, rows: [...x.rows, x.params.map(() => null)] }))} />
              </Toolbar>
              <Table accessibleName="Combination rows" noDataText="No rows yet." rowActionCount={1}
                onRowActionClick={(e) => {
                  const r = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
                  setCLocal((x) => ({ ...x, rows: x.rows.filter((_, j) => j !== r) }));
                }}
                headerRow={
                  <TableHeaderRow>
                    {c.params.map((k) => <TableHeaderCell key={k} minWidth="8rem">{k}</TableHeaderCell>)}
                  </TableHeaderRow>
                }>
                {c.rows.map((row, ri) => (
                  <TableRow key={ri} rowKey={`r-${ri}`} data-idx={String(ri)} actions={<TableRowAction icon="delete" text="Delete" />}>
                    {c.params.map((k, ci) => {
                      const opts = optionsFor(k);
                      const setCell = (v: Cell) =>
                        setCLocal((x) => ({ ...x, rows: x.rows.map((r, j) => (j === ri ? r.map((cell, cj) => (cj === ci ? v : cell)) : r)) }));
                      return (
                        <TableCell key={k}>
                          {opts ? (
                            <Select value={JSON.stringify(row[ci] ?? null)}
                              onChange={(e) => setCell(JSON.parse((e.detail.selectedOption as HTMLElement).dataset.j!))}>
                              <Option value="null" data-j="null">—</Option>
                              {opts.map((v, oi) => (
                                <Option key={oi} value={JSON.stringify(v)} data-j={JSON.stringify(v)}>{String(v)}</Option>
                              ))}
                            </Select>
                          ) : (
                            <Input value={String(row[ci] ?? "")} onInput={(e) => setCell(parseLit(e.target.value))} />
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </Table>
            </>
          ) : <Text>Pick at least two parameters, then add rows.</Text>}
        </FormGroup>
      </Form>
    </Dialog>
  );
}
