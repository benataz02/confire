import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicSideContent, Label, MessageStrip, ObjectPage,
  ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, ObjectStatus, Tag,
  Text, TextArea, Title, Toolbar,
} from "@ui5/webcomponents-react";
import { propagate, type Entries, type TableRows, type Val } from "@hera/config-engine";
import { mergeQueryPicks, setQueryPick, type QueryPicks } from "./formHelpers.ts";
import { orpc } from "../../orpc.ts";
import { toast } from "../toast.ts";
import { cleanOverrides, statusUi, toggleSelection, type Sel } from "./runView.ts";
import { BatchEditor, ConfiguratorForm, ConsistencyStatus, formSections } from "./ConfiguratorForm.tsx";
import { ConfigGeneral, missingGeneral } from "./ConfigGeneral.tsx";
import { StepCandidatesReview } from "./StepCandidatesReview.tsx";
import { StepCreateQuote } from "./StepCreateQuote.tsx";
import { InsightsRail } from "./InsightsRail.tsx";
import { buildCalculationUpdate, needsCalculation, sameEntries, sameTables } from "./configProcessState.ts";

// One scroll: Configure, Candidates, Create quote. Missing run or selection is an empty state.
// Local overlays (override ?? server) until persist.
export function ConfigProcessPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  const modelId = q.data?.project.modelId;
  const lookups = useQuery({
    ...orpc.configs.lookups.queryOptions({ input: { modelId: modelId!, entries: q.data?.project.entries ?? {} } }),
    // Canonical page is per-model. Entries only enrich that first fetch; putting them in the key
    // remounts every control after autosave and retriggers UI5 onChange → update/get/run.
    queryKey: orpc.configs.lookups.queryOptions({ input: { modelId: modelId! } }).queryKey,
    enabled: !!modelId,
    staleTime: 5 * 60_000, // matches the server-side cache window
    placeholderData: keepPreviousData,
    retry: false, // agent-offline should show its message, not spin
  });

  const [picks, setPicks] = useState<QueryPicks>({});
  const [entriesOverride, setEntries] = useState<Entries | null>(null);
  const [batchesOverride, setBatches] = useState<number[] | null>(null);
  const [tablesOverride, setTables] = useState<TableRows | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  const [runMeta, setRunMeta] = useState<{ capped: boolean; widest?: { key: string; size: number } } | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  // Which insight panels are expanded. Lives here (not in the rail) so scrolling past Configure
  // doesn't reset it. Panel's `fixed` keeps the last open one from collapsing.
  const [openPanels, setOpenPanels] = useState(new Set(["costs"]));
  const togglePanel = (k: string) =>
    setOpenPanels((o) => {
      if (!o.has(k)) return new Set(o).add(k);
      if (o.size === 1) return o; // last one open — `fixed` blocks this anyway
      const n = new Set(o);
      n.delete(k);
      return n;
    });
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: orpc.configs.get.queryOptions({ input: { id } }).queryKey });
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: invalidate }));
  const reject = useMutation(orpc.configs.reject.mutationOptions({
    onSuccess: () => { setRejectOpen(false); invalidate(); },
  }));
  const run = useMutation(
    orpc.configs.run.mutationOptions({
      onSuccess: (r) => {
        setRunMeta({ capped: r.capped, widest: r.widest });
        setSel([]); // a new run invalidates any previous candidate picks
        invalidate();
      },
    }),
  );
  const select = useMutation(orpc.configs.select.mutationOptions({
    onSuccess: () => {
      setSel(null); // use persisted selection after save
      invalidate();
      toast("Selection saved");
    },
  }));

  const project = q.data?.project;
  const model = q.data?.model;
  const createdByEmail = q.data?.createdByEmail;
  const entries = entriesOverride ?? project?.entries ?? {};
  const batches = batchesOverride ?? project?.batches ?? [];
  const tables = tablesOverride ?? project?.tables ?? {};
  const candidates = project?.candidates ?? [];
  const selection = selOverride ?? project?.selection ?? [];
  const runReady = candidates.length > 0 && project?.status !== "draft";
  const lk = lookups.data ? mergeQueryPicks(lookups.data, picks) : undefined;
  const prop = model && lk ? propagate(model.definition, lk, entries, tables) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  const entriesDirty = !!project && !sameEntries(entries, project.entries);
  const batchesDirty = !!project && JSON.stringify(batches) !== JSON.stringify(project.batches);
  const tablesDirty = !!project && !sameTables(tables, project.tables);
  const missing = missingGeneral({ name: project?.name ?? "", customer: project?.customer ?? null });
  const calcBusy = update.isPending || run.isPending;
  const shouldCalc = !!project && needsCalculation({
    conflicted,
    missingCount: missing.length,
    batchCount: batches.length,
    lookupsReady: !!lk,
    entriesDirty,
    batchesDirty,
    tablesDirty,
    runReady,
  });

  const calculateRef = useRef<() => Promise<void>>(async () => {});
  calculateRef.current = async () => {
    if (!project) return;
    try {
      const updateInput = buildCalculationUpdate(
        id, project.entries, entries, project.batches, batches, project.tables, tables,
      );
      if (updateInput) await update.mutateAsync(updateInput);
      run.mutate({ projectId: id });
    } catch {
      /* update.error renders below */
    }
  };

  useEffect(() => {
    if (!shouldCalc || calcBusy) return;
    const t = setTimeout(() => void calculateRef.current(), 1000);
    return () => clearTimeout(t);
  }, [shouldCalc, calcBusy, entries, batches, tables]);

  const copyValues = (values: Record<string, Val>) => {
    const next = { ...entries };
    for (const [k, v] of Object.entries(values)) {
      const cur = next[k];
      if ((cur === undefined || cur === null || cur === "") && v !== null && v !== undefined) next[k] = v;
    }
    setEntries(next); // fills only empty params; page-level propagate() takes it from here
  };

  const changeEntries = (next: Entries) => {
    if (sameEntries(next, entries)) return;
    setEntries(next);
  };

  const saveSelection = () => {
    if (!candidates.length || selection.length === 0) return;
    select.mutate({
      projectId: id,
      selection: selection.map((s) => ({
        candidateIdx: s.candidateIdx, batchQty: s.batchQty, overrides: cleanOverrides(s.overrides),
      })),
    });
  };

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  if (!project || !model) return null;
  const st = statusUi[project.status];

  const footer = (
    <Bar design="FloatingFooter"
      startContent={
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {prop ? <ConsistencyStatus prop={prop} /> : null}
          {missing.length ? <ObjectStatus state="Critical">{missing.join(" and ")} required</ObjectStatus> : null}
          {shouldCalc || calcBusy ? <BusyIndicator active delay={0} size="S" /> : null}
          {candidates.length > 0 ? (
            <Text>
              {selection.length} quotation line{selection.length === 1 ? "" : "s"} selected
            </Text>
          ) : null}
        </div>
      }
      endContent={
        <Button design="Emphasized" disabled={select.isPending || selection.length === 0} onClick={saveSelection}>
          {select.isPending ? "Saving…" : "Save selection"}
        </Button>
      } />
  );

  // No ObjectPageHeader: the "requested" context moved into the title's subHeader (with Reject next
  // to the other title actions), and the errors below the title — they render only when there is
  // something to say, so nothing eats vertical space in the normal case.
  const messages = lookups.error || update.error || run.error ? (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 1rem 0" }}>
      {lookups.error ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookups.error.message}</MessageStrip>
          <Button onClick={() => lookups.refetch()}>Retry</Button>
        </div>
      ) : null}
      {update.error || run.error ? (
        <MessageStrip design="Negative" hideCloseButton>
          {update.error?.message ?? run.error?.message}
        </MessageStrip>
      ) : null}
    </div>
  ) : null;

  // The rail sits OUTSIDE the ObjectPage: ObjectPage collects sub-tabs from direct children only,
  // so wrapping the subsections would silently drop Configure's sub-anchor tabs.
  // DynamicSideContent handles the responsive drop-below itself — no media queries, no animation.
  return (
    <>
    <DynamicSideContent
      sideContentVisibility="AlwaysShow"
      sideContent={
        <InsightsRail projectId={id} model={model.definition} lk={lk} prop={prop} entries={entries}
          onCopy={copyValues} open={openPanels} onToggle={togglePanel} />
      }>
    
    {messages}
    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title>{project.name}</Title>}
          subHeader={
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              <Text>{model.name}</Text>
              {project.status === "requested" ? (
                <Text>
                  Requested by {createdByEmail ?? "a portal user"} for {project.customer?.cardName ?? "—"}
                </Text>
              ) : null}
            </div>
          }
          actionsBar={
            project.status === "requested" ? (
              <Toolbar design="Transparent">
                <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
              </Toolbar>
            ) : undefined
          }>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>
            {st.text}
          </Tag>
        </ObjectPageTitle>
      }
      footerArea={footer}
    >
      <ObjectPageSection id="configure" titleText="Configure">
        <ObjectPageSubSection id="general" titleText="General">
          <ConfigGeneral name={project.name} modelId={project.modelId} customer={project.customer ?? null}
            disabled={update.isPending}
            onChange={(patch) => {
              // A model switch wipes entries/batches server-side; drop the local overlays too,
              // or the old model's values would be re-applied on top of the new form.
              if (patch.modelId) { setEntries(null); setBatches(null); setTables(null); setSel(null); setPicks({}); }
              update.mutate({ id, ...patch });
            }} />
        </ObjectPageSubSection>
        <ObjectPageSubSection id="batches" titleText="Batch quantities">
          <BatchEditor batches={batches} onChange={setBatches} />
        </ObjectPageSubSection>
        {/* formSections, not structure.sections: a table the author never placed gets a trailing
            subsection of its own, and the anchor bar has to show it. */}
        {formSections(model.definition).map((s) => (
          <ObjectPageSubSection key={s.key} id={s.key} titleText={s.title}>
            {lookups.data && lk && prop ? (
              <ConfiguratorForm section={s.key} model={model.definition} lookups={lookups.data} lk={lk} prop={prop} entries={entries}
                onChange={changeEntries}
                onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
                querySource={{ kind: "project", modelId: project.modelId }}
                tables={tables} onTablesChange={setTables} />
            ) : lookups.error ? null : <BusyIndicator active delay={0} />}
          </ObjectPageSubSection>
        ))}
      </ObjectPageSection>
      <ObjectPageSection id="candidates" titleText="Candidates">
        {candidates.length > 0 && model && lk ? (
          <StepCandidatesReview model={model.definition} lookups={lk}
            entries={project!.entries} candidates={candidates}
            selection={selection}
            onToggle={(i, b) => { if (select.isSuccess) select.reset(); setSel(toggleSelection(selection, i, b)); }}
            onChange={(next) => { if (select.isSuccess) select.reset(); setSel(next); }}
            capped={runMeta?.capped ?? candidates.length >= 200}
            widest={runMeta?.widest}
            error={select.error?.message ?? null} saved={select.isSuccess} />
        ) : (
          <Text>No candidates yet.</Text>
        )}
      </ObjectPageSection>
      <ObjectPageSection id="quote" titleText="Create quote">
        {project?.selection?.length || select.isSuccess ? (
          <StepCreateQuote projectId={id} />
        ) : (
          <Text>Save a candidate selection to continue.</Text>
        )}
      </ObjectPageSection>
    </ObjectPage>
    </DynamicSideContent>

    <Dialog open={rejectOpen} headerText="Reject request" onClose={() => setRejectOpen(false)}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Negative" disabled={!note.trim() || reject.isPending}
              onClick={() => reject.mutate({ id, note: note.trim() })}>
              {reject.isPending ? "Rejecting…" : "Reject with note"}
            </Button>
            <Button onClick={() => setRejectOpen(false)}>Cancel</Button>
          </>
        } />
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0" }}>
        {reject.error ? <MessageStrip design="Negative" hideCloseButton>{reject.error.message}</MessageStrip> : null}
        <Label for="reject-note" required>What should the client change?</Label>
        <TextArea id="reject-note" rows={4} value={note} onInput={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
    </>
  );
}
