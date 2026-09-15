import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Form, FormGroup, FormItem, IllustratedMessage, Input, Label, MessageStrip,
  MultiComboBox, MultiComboBoxItem, ObjectStatus, Option, Select, StepInput,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
  Text, TextArea, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { Issue, ModelDef, QuerySource, Val } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };
const EMPTY_QUERY: QuerySource = { target: "b1", query: { entitySet: "" }, columns: [] };

const FORM = { accessibleMode: "Edit", layout: "S1 M1 L1 XL1", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;
const titled = (label: string, n: number) => (n ? `${label} (${n})` : label);

// Admin config for the similarity half of the process page's help pane: the query, param↔column
// mappings with match type + weight, and the columns each result shows. Exact help is not
// configured here — it matches on the project's customer and the items grid's item codes.
export function HistoryTab({ draft, update, issues, modelId, dirty }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
  modelId: string;
  dirty: boolean;
}) {
  const qc = useQueryClient();
  const [preview, setPreview] = useState<{ cols: string[]; rows: Val[][] } | null>(null);
  const h = draft.history ?? EMPTY;
  // Saved models may still carry the pre-OData `{ path, target, columns }` query; never assume `.query`.
  const q: QuerySource = {
    target: h.query?.target ?? EMPTY_QUERY.target,
    columns: h.query?.columns ?? EMPTY_QUERY.columns,
    query: { entitySet: h.query?.query?.entitySet ?? "", filter: h.query?.query?.filter, orderby: h.query?.query?.orderby },
  };
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));
  const setQ = (query: QuerySource) => setH({ query });
  const cols = q.columns;
  const testFetch = useMutation(orpc.masterdata.queryPage.mutationOptions({
    onSuccess: (r) => {
      setQ({ ...q, columns: r.columns });
      setPreview({ cols: r.columns, rows: r.rows.slice(0, 10) });
    },
    onError: () => setPreview(null),
  }));

  const info = useQuery({ ...orpc.models.historyInfo.queryOptions({ input: { id: modelId } }), enabled: !!modelId });
  const sync = useMutation(orpc.models.syncHistory.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.models.historyInfo.queryOptions({ input: { id: modelId } }).queryKey }),
  }));

  const errMsg = (path: string) => issueFor(issues, path)?.message;
  const strip = (msg?: string, key?: string) =>
    msg ? <MessageStrip key={key} design="Negative" hideCloseButton>{msg}</MessageStrip> : null;
  // Field-level issues render on the field itself; valueStateMessage is a slot, so it needs an element.
  const vs = (msg?: string) => ({
    valueState: (msg ? "Negative" : "None") as "Negative" | "None",
    valueStateMessage: msg ? <div>{msg}</div> : undefined,
  });

  return (
    <Form {...FORM}>
      <FormGroup headerText="History query" headerLevel="H5" accessibleName="History query">
        <Toolbar design="Transparent" accessibleName="History query actions">
          <ToolbarButton icon="show" design="Transparent"
            disabled={testFetch.isPending || !q.query.entitySet}
            text={testFetch.isPending ? "Testing…" : "Test fetch"}
            onClick={() => testFetch.mutate({ target: q.target, query: q.query, columns: q.columns })} />
          <ToolbarButton icon="synchronize" design="Transparent"
            disabled={sync.isPending || dirty || !modelId}
            text={sync.isPending ? "Syncing…" : "Sync now"}
            onClick={() => sync.mutate({ id: modelId })} />
        </Toolbar>
        <FormItem labelContent={<Label>Source</Label>}>
          <Select value={q.target}
            onChange={(e) => setQ({ ...q, target: e.detail.selectedOption.value as QuerySource["target"] })}>
            <Option value="b1">B1</Option>
            <Option value="beas">Beas</Option>
          </Select>
        </FormItem>
        <FormItem labelContent={<Label>Entity set</Label>}>
          <Input value={q.query.entitySet} placeholder="Items"
            onInput={(e) => setQ({ ...q, query: { ...q.query, entitySet: e.target.value.trim() } })} />
        </FormItem>
        <FormItem labelContent={<Label>Select</Label>}>
          <Input value={q.columns.join(", ")} placeholder="ItemCode, ItemName"
            onChange={(e) => setQ({ ...q, columns: [...new Set(e.target.value.split(/[,\s]+/).filter(Boolean))] })} />
        </FormItem>
        <FormItem labelContent={<Label>Filter</Label>}>
          <TextArea growing growingMaxRows={4} rows={1} value={q.query.filter ?? ""}
            placeholder="ItemType eq 'itItems' and Frozen eq 'tNO'"
            onInput={(e) => setQ({ ...q, query: { ...q.query, filter: e.target.value || undefined } })} />
        </FormItem>
        <FormItem labelContent={<Label>Sort</Label>}>
          <Input value={q.query.orderby ?? ""} placeholder="ItemName"
            onInput={(e) => setQ({ ...q, query: { ...q.query, orderby: e.target.value || undefined } })} />
        </FormItem>
        {testFetch.error ? <MessageStrip design="Negative" hideCloseButton>{testFetch.error.message}</MessageStrip> : null}
        {strip(errMsg("history.query"))}
        {sync.error?.message ? strip(sync.error.message) : null}
        {dirty || !modelId ? (
          <MessageStrip design="Critical" hideCloseButton>Save the model first — sync runs the saved query.</MessageStrip>
        ) : null}
        {info.data ? (
          <>
            <FormItem labelContent={<Label>Rows</Label>}>
              <ObjectStatus state={info.data.count ? "Positive" : "None"}>{`${info.data.count}`}</ObjectStatus>
            </FormItem>
            <FormItem labelContent={<Label>Last synced</Label>}>
              <Text>
                {info.data.lastSyncedAt
                  ? `${new Date(info.data.lastSyncedAt).toLocaleString()} · refreshes hourly`
                  : "Never · refreshes hourly"}
              </Text>
            </FormItem>
          </>
        ) : null}
        <Table accessibleName="Query preview" overflowMode="Popin"
          noData={<IllustratedMessage name="NoData" design="Dot"
            titleText={preview ? "No rows returned" : "No preview yet"}
            subtitleText={preview ? "The query ran but SAP sent back an empty page." : "Run Test fetch to read rows from SAP."} />}
          headerRow={
            <TableHeaderRow>
              {(preview?.cols ?? cols).map((c) => <TableHeaderCell key={c} minWidth="8rem">{c}</TableHeaderCell>)}
            </TableHeaderRow>
          }>
          {preview?.rows.map((row, ri) => (
            <TableRow key={ri} rowKey={`q-${ri}`}>
              {row.map((cell, ci) => <TableCell key={ci}><Text>{String(cell ?? "")}</Text></TableCell>)}
            </TableRow>
          ))}
        </Table>
      </FormGroup>

      <FormGroup headerText={titled("Parameter mappings", h.mappings.length)} headerLevel="H5" accessibleName="Parameter mappings">
        <Toolbar design="Transparent" accessibleName="Parameter mapping actions">
          <ToolbarButton icon="add" design="Transparent" text="Add mapping"
            disabled={!cols.length || !draft.parameters.length}
            onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })} />
        </Toolbar>
        {h.query && !cols.length ? (
          <MessageStrip design="Information" hideCloseButton>Run Test fetch first — this needs the query's columns.</MessageStrip>
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
        {h.mappings.map((_, i) => strip(errMsg(`history.mappings[${i}]`), `m-${i}`))}
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
  );
}
