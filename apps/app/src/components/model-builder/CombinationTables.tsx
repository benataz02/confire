import { useMemo, useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label, MultiComboBox, MultiComboBoxItem, Option, Select, Text } from "@ui5/webcomponents-react";
import type { ModelDef, ResolvedLookups, Val } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { FORM_LAYOUT } from "@confire/ui/formLayout.ts";
import { EditGrid } from "@confire/ui/list-report/EditGrid.tsx";
import { Grid, GridForm, type GridState } from "@confire/ui/list-report/Grid.tsx";
import { ownColumns } from "@confire/ui/metadata.ts";
import type { Control, ListColumn, Row } from "@confire/ui/types.ts";
import type { ComboTable } from "../../features/model/record.ts";
import { useI18n } from "../../i18n.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
// Combination-table cells are scalar (no string[] multicombo values), unlike the full Val union.
type Cell = Exclude<Val, string[]>;

// "true"/"false" -> boolean, numeric -> number, "" -> null, else string.
export const parseLit = (s: string): Cell =>
  s === "" ? null : s === "true" ? true : s === "false" ? false : !Number.isNaN(Number(s)) ? Number(s) : s;

/** A grid row's place in its list — what a selection hands back. */
const AT = "#at";

/** The Rules section's combination tables (a template): their list, and the dialog that edits one.
 *  A table's rows are many hand-entered lines, so it opens on its own rather than as a cell. */
export function CombinationTables({ draft, lookups, update }: { draft: ModelDef; lookups?: ResolvedLookups; update: Update }) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const columns = useMemo<ListColumn[]>(() => [
    { key: "params", label: t("MODEL_SECTION_PARAMS"), sortable: false },
    { key: "mode", label: t("MODEL_MODE"), sortable: false },
    { key: "rows", label: t("MODEL_ROWS"), sortable: false },
  ], [i18n]);
  const state = useMemo<GridState>(() => ({ columns: columns.map((c) => c.key), sortBy: [], groupBy: [] }), [columns]);
  // Each with its index into draft.constraints, which is what every edit addresses.
  const tables = draft.constraints.flatMap((c, i) => (c.kind === "table" ? [{ c, i }] : []));
  const rows = tables.map(({ c }, at): Row => ({
    [AT]: at,
    params: c.params.join(" × ") || "—",
    mode: t(c.mode === "allow" ? "MODEL_MODE_ALLOW_SHORT" : "MODEL_MODE_FORBID_SHORT"),
    rows: c.rows.length,
  }));
  const [editing, setEditing] = useState<number | null>(null);
  const setC = (i: number, c: ComboTable) => update((d) => ({ ...d, constraints: d.constraints.map((x, j) => (j === i ? c : x)) }));

  return (
    <>
      <GridForm name={t("MODEL_COMBO_TABLES")}>
        <Grid title={t("MODEL_COMBO_TABLES")} columns={columns} state={state} rows={rows} fill={false} showSettings={false}
          selectionMode="Multiple" onRowClick={(row) => setEditing(tables[row[AT] as number]!.i)}
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => {
                  update((d) => ({ ...d, constraints: [...d.constraints, { kind: "table", params: [], rows: [], mode: "forbid" }] }));
                  setEditing(draft.constraints.length);
                }}>
                {t("MODEL_ADD_COMBO")}
              </Button>
              {/* A combination table can hold a lot of hand-entered rows — confirm before discarding them. */}
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={async () => {
                  const picked = sel.rows.map((r) => tables[r[AT] as number]!);
                  const n = picked.reduce((sum, x) => sum + x.c.rows.length, 0);
                  if (n && !await confirm({
                    title: t("MODEL_DELETE_COMBOS"),
                    message: picked.length === 1
                      ? t(n === 1 ? "MODEL_DELETE_COMBO_ONE_R1" : "MODEL_DELETE_COMBO_ONE_RN", String(n))
                      : t(n === 1 ? "MODEL_DELETE_COMBO_N_R1" : "MODEL_DELETE_COMBO_N_RN", String(picked.length), String(n)),
                    actionText: t("MODEL_DELETE"), destructive: true,
                  })) return;
                  // row ids are positions, so a kept selection would land on the rows that moved up
                  sel.clear();
                  const gone = new Set(picked.map((x) => x.i));
                  update((d) => ({ ...d, constraints: d.constraints.filter((_, j) => !gone.has(j)) }));
                }}>
                {t("MODEL_DELETE")}
              </Button>
            </>
          )} />
      </GridForm>
      {editing !== null && draft.constraints[editing]?.kind === "table" ? (
        <ComboTableDialog draft={draft} lookups={lookups} value={draft.constraints[editing] as ComboTable}
          onOk={(c) => { setC(editing, c); setEditing(null); }}
          onCancel={() => setEditing(null)} />
      ) : null}
    </>
  );
}

/** A free-text cell: typed back into the literal it reads as. */
const literal: Control = (c) => (
  <Input style={{ width: "100%" }} value={c.value === null || c.value === undefined ? "" : String(c.value)} accessibleName={c.field.label}
    onInput={(e) => c.onChange(parseLit(e.target.value))} />
);
const CONTROLS = { literal };

function ComboTableDialog({ draft, lookups, value, onOk, onCancel }: {
  draft: ModelDef; lookups?: ResolvedLookups; value: ComboTable;
  onOk: (c: ComboTable) => void; onCancel: () => void;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const [c, setC] = useState<ComboTable>(() => structuredClone(value));
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
    setC((x) => ({ ...x, params, rows: x.rows.map((r) => params.map((k) => r[x.params.indexOf(k)] ?? null)) }));

  // Memoized on the parameters: EditGrid keeps a cell mounted while its column stays the same.
  const columns = useMemo<ListColumn[]>(() => ownColumns(c.params.map((k) => {
    const opts = optionsFor(k);
    return opts
      ? { key: k, label: k, options: opts.filter((v): v is Exclude<Cell, null> => v !== null).map((v) => ({ value: v, label: String(v) })) }
      : { key: k, label: k, controlType: "literal" };
  })), [c.params, lookups]);
  // The grid edits lines keyed by parameter; the table stores them positionally.
  const rows = useMemo(() => c.rows.map((r) => Object.fromEntries(c.params.map((k, i) => [k, r[i]]))), [c]);

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
      <Form layout={FORM_LAYOUT} accessibleMode="Edit" accessibleName={t("MODEL_DEFINITION")}>
        <FormGroup>
          <FormItem labelContent={<Label required showColon>{t("MODEL_PARAMS_MIN")}</Label>}>
            <MultiComboBox style={{ width: "100%" }} accessibleName={t("MODEL_PARAMS_MIN")}
              onSelectionChange={(e) => setParams(e.detail.items.map((i) => (i as HTMLElement).getAttribute("text")!))}>
              {eligible.map((p) => <MultiComboBoxItem key={p.key} text={p.key} selected={c.params.includes(p.key)} />)}
            </MultiComboBox>
          </FormItem>
          <FormItem labelContent={<Label showColon>{t("MODEL_MODE")}</Label>}>
            <Select style={{ width: "100%" }} value={c.mode} accessibleName={t("MODEL_MODE")}
              onChange={(e) => setC((x) => ({ ...x, mode: e.detail.selectedOption.value as ComboTable["mode"] }))}>
              <Option value="allow">{t("MODEL_MODE_ALLOW")}</Option>
              <Option value="forbid">{t("MODEL_MODE_FORBID")}</Option>
            </Select>
          </FormItem>
        </FormGroup>
      </Form>
      {c.params.length >= 2 ? (
        <GridForm headerText={t("MODEL_COMBO_ROWS")}>
          <EditGrid title={t("MODEL_COMBO_ROWS")} columns={columns} rows={rows} controls={CONTROLS}
            newRow={() => Object.fromEntries(c.params.map((k) => [k, null]))}
            onChange={(next) => setC((x) => ({ ...x, rows: next.map((r) => x.params.map((k) => (r[k] ?? null) as Cell)) }))} />
        </GridForm>
      ) : <Text>{t("MODEL_PICK_TWO")}</Text>}
    </Dialog>
  );
}
