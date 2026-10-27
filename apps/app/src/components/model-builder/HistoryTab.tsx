import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Button, Form, FormGroup, FormItem, Label, MessageStrip,
  MultiComboBox, MultiComboBoxItem, Option, Select, StepInput,
} from "@ui5/webcomponents-react";
import { historyFields, historyKey, type Issue, type ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { Grid, TABLE_ITEM } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn } from "@confire/ui/types.ts";
import { issueFor } from "./useDraftModel.ts";
import { DeleteRows, useEditGrid } from "./useEditGrid.tsx";
import { MasterdataQuerySelect } from "./MasterdataQuerySelect.tsx";
import { PAIRS } from "./ParamForm.tsx";
import { useI18n } from "../../i18n.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
type Mapping = History["mappings"][number];
const EMPTY: History = { mappings: [], display: [] };

const MATCH_KEY = { exact: "MODEL_MATCH_EXACT", closeness: "MODEL_MATCH_CLOSENESS", contains: "MODEL_MATCH_CONTAINS" } as const;

/** historyKey's inverse: a dot only ever separates the items grid from its column. */
const fromKey = (key: string): Pick<Mapping, "param" | "table"> => {
  const [a, b] = key.split(".");
  return b ? { table: a, param: b } : { table: undefined, param: a! };
};

// Admin config for the process page's "Similar configurations" pane: which masterdata query to
// rank against, param↔column mappings with match type + weight, and the columns each result shows.
//
// No sync controls here any more. The history query is an ordinary masterdata query now, cached by
// the same circuit as every other one, so "Sync now", "Last synced" and the row count live on the
// masterdata row itself — one place, whatever names it.
//
// One Form, two groups: the query's fields in two columns, then the mappings grid at full width as
// ConfiguratorForm places a table — no group header, the Grid toolbar names it with its row count.
export function HistoryTab({ draft, update, issues }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const mappingColumns = useMemo<ListColumn[]>(() => [
    { key: "param", label: t("MODEL_PARAM") },
    { key: "column", label: t("MODEL_COLUMN") },
    { key: "match", label: t("MODEL_MATCH") },
    { key: "weight", label: t("MODEL_WEIGHT"), width: 160 },
  ], [i18n]);
  const h = draft.history ?? EMPTY;
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));
  // the parameters, then the items grid's columns as `<table>.<column>`
  const fields = [...historyFields(draft).keys()];

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
  const mappings = useEditGrid(h.mappings, mappingColumns, {
    param: (m, i) => (
      <Select style={{ width: "100%" }} value={historyKey(m)} onChange={(e) => setM(i, fromKey(e.detail.selectedOption.value!))}>
        {fields.map((k) => <Option key={k} value={k}>{k}</Option>)}
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
        {(["exact", "closeness", "contains"] as const).map((mode) => <Option key={mode} value={mode}>{t(MATCH_KEY[mode])}</Option>)}
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
    <Form {...PAIRS} accessibleMode="Edit" accessibleName={t("MODEL_SECTION_HISTORY")}>
      <FormGroup headerText={t("MODEL_HISTORY_QUERY")} headerLevel={PAIRS.headerLevel} colSpan={PAIRS.layout}>
        <FormItem labelContent={<Label>{t("MODEL_QUERY")}</Label>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
            <MasterdataQuerySelect accessibleName={t("MODEL_MD_QUERY")}
              value={h.table} issue={errMsg("history.table")}
              onChange={(table) => setH({ table })} />
            {h.table && !cols.length ? (
              <MessageStrip design="Information" hideCloseButton>
                {t("MODEL_HISTORY_COLS_HINT")}
              </MessageStrip>
            ) : null}
          </div>
        </FormItem>
        <FormItem labelContent={<Label>{t("MODEL_HISTORY_DISPLAY")}</Label>}>
          <MultiComboBox style={{ width: "100%" }}
            selectedValues={h.display}
            {...vs(h.display.map((_, i) => errMsg(`history.display[${i}]`)).find(Boolean))}
            onSelectionChange={(e) => setH({ display: e.detail.items.flatMap((it) => it.value ? [it.value] : []) })}>
            {cols.map((c) => <MultiComboBoxItem key={c} text={c} value={c} />)}
          </MultiComboBox>
        </FormItem>
      </FormGroup>
      <FormGroup accessibleName={t("MODEL_MAPPINGS")} colSpan={PAIRS.layout}>
        <FormItem className={TABLE_ITEM}>
          <Grid {...mappings} title={t("MODEL_MAPPINGS")} fill={false} selectionMode="Multiple"
            toolbarActions={(sel) => (
              <>
                <Button icon="add" design="Transparent"
                  disabled={!cols.length || !fields.length}
                  onClick={() => setH({ mappings: [...h.mappings, { ...fromKey(fields[0]!), column: cols[0]!, match: "exact", weight: 1 }] })}>
                  {t("MODEL_ADD_MAPPING")}
                </Button>
                <DeleteRows sel={sel} onDelete={(gone) => setH({ mappings: h.mappings.filter((_, j) => !gone.has(j)) })} />
              </>
            )} />
        </FormItem>
      </FormGroup>
    </Form>
  );
}
