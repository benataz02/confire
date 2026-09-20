import { useQuery } from "@tanstack/react-query";
import {
  Button, Form, FormGroup, FormItem, IllustratedMessage, Label, MessageStrip,
  MultiComboBox, MultiComboBoxItem, ObjectPageSubSection, Option, Select, StepInput,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { Issue, ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";
import { MasterdataQuerySelect } from "./MasterdataQuerySelect.tsx";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

const FORM = { accessibleMode: "Edit", layout: "S1 M1 L1 XL1", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;
const titled = (label: string, n: number) => (n ? `${label} (${n})` : label);

// Admin config for the process page's "Similar configurations" pane: which masterdata query to
// rank against, param↔column mappings with match type + weight, and the columns each result shows.
//
// No sync controls here any more. The history query is an ordinary masterdata query now, cached by
// the same circuit as every other one, so "Sync now", "Last synced" and the row count live on the
// masterdata row itself — one place, whatever names it.
//
// A hook, not a component: ObjectPage builds the anchor bar's sub-tabs by scanning
// section.props.children for ObjectPageSubSection *elements*, so a component in between hides
// them. ModelBuilderPage calls this and drops the result straight into its ObjectPageSection.
export function useHistoryTab({ draft, update, issues }: {
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
  // Every error here is reported once, in the page's message popover — the Select's own valueState
  // is the local echo.
  const subSections = [
    <ObjectPageSubSection key="history-query" id="history-query" titleText="History query">
      <Form {...FORM}>
        <FormGroup accessibleName="History query">
          <FormItem labelContent={<Label>Query</Label>}>
            <MasterdataQuerySelect accessibleName="Masterdata query"
              value={h.table} issue={errMsg("history.table")}
              onChange={(table) => setH({ table })} />
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
    </ObjectPageSubSection>,

    <ObjectPageSubSection key="history-mappings" id="history-mappings" titleText={titled("Parameter mappings", h.mappings.length)}
      actions={
        <Button icon="add" design="Transparent"
          disabled={!cols.length || !draft.parameters.length}
          onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })}>
          Add mapping
        </Button>
      }>
      {h.table && !cols.length ? (
        <MessageStrip design="Information" hideCloseButton>
          Open the query in Masterdata and save it so its columns are stored.
        </MessageStrip>
      ) : null}
      <Table accessibleName="Parameter mappings" overflowMode="Popin" rowActionCount={1}
        noData={<IllustratedMessage name="NoData" design="Dot" titleText="No mappings"
          subtitleText="Map model parameters to query columns so similar past configurations can be scored." />}
        onRowActionClick={(e) => {
          const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
          setH({ mappings: h.mappings.filter((_, j) => j !== i) });
        }}
        headerRow={
          <TableHeaderRow>
            <TableHeaderCell minWidth="10rem">Parameter</TableHeaderCell>
            <TableHeaderCell minWidth="10rem">Column</TableHeaderCell>
            <TableHeaderCell minWidth="8rem">Match</TableHeaderCell>
            <TableHeaderCell minWidth="7rem" width="8rem">Weight</TableHeaderCell>
          </TableHeaderRow>
        }>
        {h.mappings.map((m, i) => {
          const setM = (patch: Partial<History["mappings"][number]>) =>
            setH({ mappings: h.mappings.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          return (
            <TableRow key={i} rowKey={`m-${i}`} data-idx={String(i)}
              actions={<TableRowAction icon="delete" text="Delete" />}>
              <TableCell>
                <Select value={m.param} onChange={(e) => setM({ param: e.detail.selectedOption.value })}>
                  {draft.parameters.map((p) => <Option key={p.key} value={p.key}>{p.key}</Option>)}
                </Select>
              </TableCell>
              <TableCell>
                <Select value={m.column} onChange={(e) => setM({ column: e.detail.selectedOption.value })}>
                  {cols.map((c) => <Option key={c} value={c}>{c}</Option>)}
                </Select>
              </TableCell>
              <TableCell>
                <Select value={m.match}
                  onChange={(e) => setM({ match: e.detail.selectedOption.value as History["mappings"][number]["match"] })}>
                  {(["exact", "closeness", "contains"] as const).map((t) => <Option key={t} value={t}>{t}</Option>)}
                </Select>
              </TableCell>
              <TableCell>
                <StepInput value={m.weight} min={0.5} step={0.5} valuePrecision={1} onChange={(e) => setM({ weight: e.target.value ?? 1 })} />
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
    </ObjectPageSubSection>,
  ];

  return { subSections };
}
