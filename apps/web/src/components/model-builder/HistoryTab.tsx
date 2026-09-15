import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, Card, CardHeader, Form, FormGroup, FormItem, Icon, IllustratedMessage, Label, Link,
  MessageStrip, MultiComboBox, MultiComboBoxItem, Option, Select, StepInput, Table, TableCell,
  TableHeaderCell, TableHeaderRow, TableRow, TableRowAction, Text, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { Issue, ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type History = NonNullable<ModelDef["history"]>;
const EMPTY: History = { mappings: [], display: [] };

const FORM = { accessibleMode: "Edit", layout: "S1 M1 L1 XL1", labelSpan: "S12 M12 L12 XL12", headerLevel: "H5" } as const;
const titled = (label: string, n: number) => (n ? `${label} (${n})` : label);
const PAD = { padding: "0.75rem 1rem 1rem", display: "flex", flexDirection: "column", gap: "0.75rem" } as const;

// Admin config for the similarity half of the process page's help pane: which masterdata query
// to cache, param↔column mappings with match type + weight, and the columns each result shows.
// Exact help is not configured here — it matches on the project's customer and the items grid.
export function HistoryTab({ draft, update, issues, modelId, dirty }: {
  draft: ModelDef;
  update: Update;
  issues: Issue[];
  modelId: string;
  dirty: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const h = draft.history ?? EMPTY;
  const setH = (patch: Partial<History>) => update((d) => ({ ...d, history: { ...EMPTY, ...d.history, ...patch } }));

  const md = useQuery(orpc.masterdata.list.queryOptions());
  const queries = (md.data ?? []).filter((t) => t.kind === "query");
  const picked = queries.find((t) => t.name === h.table);
  const cols = picked?.query?.columns ?? [];

  const info = useQuery({ ...orpc.models.historyInfo.queryOptions({ input: { id: modelId } }), enabled: !!modelId });
  const sync = useMutation(orpc.models.syncHistory.mutationOptions({
    onSuccess: () => qc.invalidateQueries({ queryKey: orpc.models.historyInfo.queryOptions({ input: { id: modelId } }).queryKey }),
  }));

  const errMsg = (path: string) => issueFor(issues, path)?.message;
  const strip = (msg?: string, key?: string) =>
    msg ? <MessageStrip key={key} design="Negative" hideCloseButton>{msg}</MessageStrip> : null;
  const vs = (msg?: string) => ({
    valueState: (msg ? "Negative" : "None") as "Negative" | "None",
    valueStateMessage: msg ? <div>{msg}</div> : undefined,
  });
  const tableIssue = errMsg("history.table");
  const lastSynced = info.data?.lastSyncedAt
    ? `Last synced ${new Date(info.data.lastSyncedAt).toLocaleString()}`
    : info.isFetched || !modelId ? "Never synced" : "Checking cache…";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <Card accessibleName="History query" header={
        <CardHeader
          titleText={picked?.name ?? "History query"}
          subtitleText={lastSynced}
          additionalText={info.data ? `${info.data.count} rows` : undefined}
          avatar={<Icon name="history" mode="Decorative" design="NonInteractive" />}
          action={
            <Button design="Transparent" icon="synchronize" loading={sync.isPending}
              disabled={sync.isPending || dirty || !modelId || !h.table}
              tooltip={dirty ? "Save the model first — sync runs the saved query." : !h.table ? "Pick a query first" : "Sync now"}
              onClick={() => sync.mutate({ id: modelId })}>
              Sync now
            </Button>
          }
        />
      }>
        <div style={PAD}>
          <Form {...FORM}>
            <FormGroup>
              <FormItem labelContent={<Label>Query</Label>}>
                <Select value={h.table ?? ""} accessibleName="Masterdata query"
                  valueState={tableIssue ? "Negative" : !queries.length ? "Information" : "None"}
                  valueStateMessage={<div>{tableIssue
                    ?? (queries.length ? "Choose a query." : "No queries are defined yet — add one on the Masterdata page.")}</div>}
                  onChange={(e) => setH({ table: e.detail.selectedOption.value || undefined })}>
                  <Option value="">{queries.length ? "— none —" : "— none defined —"}</Option>
                  {queries.map((q) => (
                    <Option key={q.id} value={q.name} additionalText={q.query?.query.entitySet}>
                      {q.name}
                    </Option>
                  ))}
                </Select>
              </FormItem>
            </FormGroup>
          </Form>
          {picked ? (
            <Link icon="inspect" wrappingType="None"
              onClick={() => void navigate({ to: "/masterdata/$id", params: { id: picked.id } })}>
              Open in Masterdata
            </Link>
          ) : (
            <Link icon="add" wrappingType="None"
              onClick={() => void navigate({ to: "/masterdata/new" })}>
              Create a query
            </Link>
          )}
          {strip(tableIssue)}
          {sync.error?.message ? strip(sync.error.message) : null}
          {h.table && (dirty || !modelId) ? (
            <MessageStrip design="Critical" hideCloseButton>Save the model first — sync runs the saved query.</MessageStrip>
          ) : null}
        </div>
      </Card>

      <Form {...FORM}>
        <FormGroup headerText={titled("Parameter mappings", h.mappings.length)} headerLevel="H5" accessibleName="Parameter mappings">
          <Toolbar design="Transparent" accessibleName="Parameter mapping actions">
            <ToolbarButton icon="add" design="Transparent" text="Add mapping"
              disabled={!cols.length || !draft.parameters.length}
              onClick={() => setH({ mappings: [...h.mappings, { param: draft.parameters[0]!.key, column: cols[0]!, match: "exact", weight: 1 }] })} />
          </Toolbar>
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
    </div>
  );
}
