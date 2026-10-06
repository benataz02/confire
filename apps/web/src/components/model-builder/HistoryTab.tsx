import { useQuery } from "@tanstack/react-query";
import {
  Button, Form, FormGroup, FormItem, Label, MessageStrip,
  MultiComboBox, MultiComboBoxItem, Option, Select, StepInput,
} from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { Grid } from "../../shared/list-report/Grid.tsx";
import type { ListColumn } from "../../shared/types.ts";
import { issueFor } from "./useDraftModel.ts";
import { GridForm, positions, useEditGrid } from "./useEditGrid.tsx";
import { MasterdataQuerySelect } from "./MasterdataQuerySelect.tsx";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
type Mapping = History["mappings"][number];
const EMPTY: History = { mappings: [], display: [] };

const FORM = { accessibleMode: "Edit", layout: "S1 M1 L1 XL1", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;
const MAPPING_COLUMNS: ListColumn[] = [
  { key: "param", label: "Parameter" },
  { key: "column", label: "Column" },
  { key: "match", label: "Match" },
  { key: "weight", label: "Weight", width: 160 },
];

// Admin config for the process page's "Similar configurations" pane: which masterdata query to
// rank against, param↔column mappings with match type + weight, and the columns each result shows.
//
// No sync controls here any more. The history query is an ordinary masterdata query now, cached by
// the same circuit as every other one, so "Sync now", "Last synced" and the row count live on the
// masterdata row itself — one place, whatever names it.
//
// The query's fields in one Form, the mappings grid in another (GridForm) — the Grid toolbar names
// the table, with its row count.
export function HistoryTab({ draft, update, issues }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
}) {
  const h = draft.history ?? EMPTY;
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));

  const md = useQuery(orpc.masterdata.list.queryOptions());
  const queries = (md.data ?? []).filter((t) => t.kind === "query");
  const picked = queries.find((t) => t.name === h.table);
  const cols = picked?.query?.columns ?? [];

  const errMsg = (path: string) => issueFor(issues, path)?.message;
  const vs = (msg?: string) => ({
    valueState: (msg ? "Negative" : "None") as "Negative" | "None",
    valueStateMessage: msg ? <div>{msg}</div> : undefined,
  });
  const setM = (i: number, patch: Partial<Mapping>) =>
    setH({ mappings: h.mappings.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const mappings = useEditGrid(h.mappings, MAPPING_COLUMNS, {
    param: (m, i) => (
      <Select style={{ width: "100%" }} value={m.param} onChange={(e) => setM(i, { param: e.detail.selectedOption.value })}>
        {draft.parameters.map((p) => <Option key={p.key} value={p.key}>{p.key}</Option>)}
      </Select>
    ),
    column: (m, i) => (
      <Select style={{ width: "100%" }} value={m.column} onChange={(e) => setM(i, { column: e.detail.selectedOption.value })}>
        {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
      </Select>
    ),
    match: (m, i) => (
      <Select style={{ width: "100%" }} value={m.match}
        onChange={(e) => setM(i, { match: e.detail.selectedOption.value as Mapping["match"] })}>
        {(["exact", "closeness", "contains"] as const).map((t) => <Option key={t} value={t}>{t}</Option>)}
      </Select>
    ),
    weight: (m, i) => (
      <StepInput style={{ width: "100%" }} value={m.weight} min={0.5} step={0.5} valuePrecision={1}
        onChange={(e) => setM(i, { weight: e.target.value ?? 1 })} />
    ),
  });

  // Every error here is reported once, in the page's message popover — the Select's own valueState
  // is the local echo.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <Form {...FORM} headerText="History query">
        <FormGroup accessibleName="History query">
          <FormItem labelContent={<Label>Query</Label>}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
              <MasterdataQuerySelect accessibleName="Masterdata query"
                value={h.table} issue={errMsg("history.table")}
                onChange={(table) => setH({ table })} />
              {h.table && !cols.length ? (
                <MessageStrip design="Information" hideCloseButton>
                  Open the query in Masterdata and save it so its columns are stored.
                </MessageStrip>
              ) : null}
            </div>
          </FormItem>
          <FormItem labelContent={<Label>Columns shown on each result</Label>}>
            <MultiComboBox style={{ width: "100%" }}
              selectedValues={h.display}
              {...vs(h.display.map((_, i) => errMsg(`history.display[${i}]`)).find(Boolean))}
              onSelectionChange={(e) => setH({ display: e.detail.items.flatMap((it) => it.value ? [it.value] : []) })}>
              {cols.map((c) => <MultiComboBoxItem key={c} text={c} value={c} />)}
            </MultiComboBox>
          </FormItem>
        </FormGroup>
      </Form>
      <GridForm name="Parameter mappings">
        <Grid {...mappings} title="Parameter mappings" fill={false} selectionMode="Multiple"
          noDataText="No mappings. Map model parameters to query columns so similar past configurations can be scored."
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                disabled={!cols.length || !draft.parameters.length}
                onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
                Add mapping
              </Button>
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={() => {
                  const gone = positions(sel.rows);
                  sel.clear();
                  setH({ mappings: h.mappings.filter((_, j) => !gone.has(j)) });
                }}>
                Delete
              </Button>
            </>
          )} />
      </GridForm>
    </div>
  );
}
