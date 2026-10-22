import { useMemo, useState } from "react";
import {
  Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label,
  MultiComboBox, MultiComboBoxItem, Option, Select, Text,
} from "@ui5/webcomponents-react";
import type { Constraint, Issue, ModelDef, ResolvedLookups, Val } from "@confire/config-engine";
import { Grid, GridForm } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn } from "@confire/ui/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { DeleteRows, positionOf, positions, useEditGrid } from "./useEditGrid.tsx";
import { confirm } from "@confire/ui/confirm.ts";
import { useI18n } from "../../i18n.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type TableConstraint = Extract<Constraint, { kind: "table" }>;
// Combination-table cells are scalar (no string[] multicombo values), unlike the full Val union.
type Cell = Exclude<Val, string[]>;

const FORM = { accessibleMode: "Edit", layout: "S1 M2 L2 XL2", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;


// "true"/"false" -> boolean, numeric -> number, "" -> null, else string.
export const parseLit = (s: string): Cell =>
  s === "" ? null : s === "true" ? true : s === "false" ? false : !Number.isNaN(Number(s)) ? Number(s) : s;

// Each table in a Form of its own (GridForm): the Form titles it, the Grid toolbar repeats the
// name with its row count.
export function RulesTab({ draft, update, issues, lookups, tables = [] }: {
  draft: ModelDef; update: Update; issues: Issue[]; lookups?: ResolvedLookups; tables?: TableCols[];
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const exprColumns = useMemo<ListColumn[]>(() => [
    { key: "when", label: t("MODEL_WHEN") },
    { key: "assert", label: t("MODEL_MUST_HOLD") },
    { key: "message", label: t("MODEL_MESSAGE") },
  ], [i18n]);
  const tableColumns = useMemo<ListColumn[]>(() => [
    { key: "params", label: t("MODEL_SECTION_PARAMS") },
    { key: "mode", label: t("MODEL_MODE") },
    { key: "rows", label: t("MODEL_ROWS") },
  ], [i18n]);
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

  const exprGrid = useEditGrid(exprs, exprColumns, {
    when: ({ c, i }) => (
      <ExprInput optional value={c.when} model={draft} tables={tables} fieldId={`expr-constraints[${i}].when`}
        issue={issueFor(issues, `constraints[${i}].when`)}
        onChange={(v) => setC(i, { ...c, when: v })} />
    ),
    assert: ({ c, i }) => (
      <ExprInput value={c.assert} model={draft} tables={tables} fieldId={`expr-constraints[${i}].assert`}
        issue={issueFor(issues, `constraints[${i}].assert`)} placeholder={t("MODEL_ASSERT_PH")}
        onChange={(v) => setC(i, { ...c, assert: v ?? "" })} />
    ),
    message: ({ c, i }) => {
      const issue = issueFor(issues, `constraints[${i}].message`);
      // The `expr-` id is builderMessages' anchor convention for a rule's cells, not a claim about the input.
      return (
        <Input id={`expr-constraints[${i}].message`} style={{ width: "100%" }} value={c.message}
          placeholder={t("MODEL_MESSAGE_PH")} required
          valueState={issue ? "Negative" : "None"} valueStateMessage={issue ? <div>{issue.message}</div> : undefined}
          onInput={(e) => setC(i, { ...c, message: e.target.value })} />
      );
    },
  });

  const tableGrid = useEditGrid(tablesC, tableColumns, {
    params: ({ c }) => c.params.join(" × ") || "—",
    mode: ({ c }) => t(c.mode === "allow" ? "MODEL_MODE_ALLOW_SHORT" : "MODEL_MODE_FORBID_SHORT"),
    rows: ({ c }) => c.rows.length,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <GridForm headerText={t("MODEL_EXPR_CONSTRAINTS")}>
        <Grid {...exprGrid} title={t("MODEL_EXPR_CONSTRAINTS")} fill={false} selectionMode="Multiple"
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => update((d) => ({ ...d, constraints: [...d.constraints, { kind: "expr", assert: "", message: "" }] }))}>
                {t("MODEL_ADD_CONSTRAINT")}
              </Button>
              {/* Expression rows are a single line, so they delete without a prompt. */}
              <DeleteRows sel={sel} onDelete={(gone) => removeCs(new Set([...gone].map((p) => exprs[p]!.i)))} />
            </>
          )} />
      </GridForm>
      <GridForm headerText={t("MODEL_COMBO_TABLES")}>
        <Grid {...tableGrid} title={t("MODEL_COMBO_TABLES")} fill={false} selectionMode="Multiple"
          onRowClick={(row) => setEditingTable(tablesC[positionOf(row)]!.i)}
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => {
                  update((d) => ({ ...d, constraints: [...d.constraints, { kind: "table", params: [], rows: [], mode: "forbid" }] }));
                  setEditingTable(draft.constraints.length);
                }}>
                {t("MODEL_ADD_COMBO")}
              </Button>
              {/* Combination tables can hold a lot of hand-entered rows — confirm before discarding them. */}
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={async () => {
                  const picked = [...positions(sel.rows)].map((p) => tablesC[p]!);
                  const rows = picked.reduce((n, t) => n + t.c.rows.length, 0);
                  if (rows && !await confirm({
                    title: t("MODEL_DELETE_COMBOS"),
                    message: picked.length === 1
                      ? t(rows === 1 ? "MODEL_DELETE_COMBO_ONE_R1" : "MODEL_DELETE_COMBO_ONE_RN", String(rows))
                      : t(rows === 1 ? "MODEL_DELETE_COMBO_N_R1" : "MODEL_DELETE_COMBO_N_RN", String(picked.length), String(rows)),
                    actionText: t("MODEL_DELETE"), destructive: true,
                  })) return;
                  sel.clear();
                  removeCs(new Set(picked.map((t) => t.i)));
                }}>
                {t("MODEL_DELETE")}
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
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
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
    <Dialog open headerText={t("MODEL_COMBO_TABLE")} onClose={onCancel} style={{ width: "min(52rem, 92vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={c.params.length < 2} onClick={() => onOk(c)}>{t("MODEL_OK")}</Button>
            <Button design="Transparent" onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }>
      <Form {...FORM} headerText={t("MODEL_DEFINITION")}>
        <FormGroup accessibleName={t("MODEL_DEFINITION")}>
          <FormItem labelContent={<Label required>{t("MODEL_PARAMS_MIN")}</Label>}>
            <MultiComboBox style={{ width: "100%" }}
              onSelectionChange={(e) => setParams(e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!))}>
              {eligible.map((p) => (
                <MultiComboBoxItem key={p.key} text={p.key} selected={c.params.includes(p.key)} />
              ))}
            </MultiComboBox>
          </FormItem>
          <FormItem labelContent={<Label>{t("MODEL_MODE")}</Label>}>
            <Select style={{ width: "100%" }} value={c.mode}
              onChange={(e) => setCLocal((x) => ({ ...x, mode: e.detail.selectedOption.value as "allow" | "forbid" }))}>
              <Option value="allow">{t("MODEL_MODE_ALLOW")}</Option>
              <Option value="forbid">{t("MODEL_MODE_FORBID")}</Option>
            </Select>
          </FormItem>
        </FormGroup>
      </Form>
      {c.params.length >= 2 ? (
        <GridForm headerText={t("MODEL_COMBO_ROWS")}>
          <Grid {...grid} title={t("MODEL_COMBO_ROWS")} fill={false} selectionMode="Multiple"
            toolbarActions={(sel) => (
              <>
                <Button icon="add" design="Transparent"
                  onClick={() => setCLocal((x) => ({ ...x, rows: [...x.rows, x.params.map(() => null)] }))}>
                  {t("MODEL_ADD_ROW")}
                </Button>
                <DeleteRows sel={sel} onDelete={(gone) => setCLocal((x) => ({ ...x, rows: x.rows.filter((_, j) => !gone.has(j)) }))} />
              </>
            )} />
        </GridForm>
      ) : <Text>{t("MODEL_PICK_TWO")}</Text>}
    </Dialog>
  );
}
