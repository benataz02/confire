import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicSideContent, Form, FormGroup, FormItem, Input, Label,
  MessageStrip, ObjectPage, ObjectPageSection, ObjectPageSubSection, ObjectPageTitle, ObjectStatus,
  Option, Select, Tag, Text, TextArea, Title, Toolbar,
} from "@ui5/webcomponents-react";
import { propagate, type Entries, type TableRows, type Val } from "@hera/config-engine";
import { mergeQueryPicks, setQueryPick, type QueryPicks } from "./formHelpers.ts";
import { client, orpc } from "../../orpc.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";
import { cleanOverrides, statusUi, toggleSelection, type Sel } from "./runView.ts";
import { BATCHES_SECTION, ConfiguratorForm, ConsistencyStatus, formSections } from "./ConfiguratorForm.tsx";
import { EntityValueHelp } from "../ValueHelp.tsx";
import { StepCandidatesReview } from "./StepCandidatesReview.tsx";
import { StepCreateQuote } from "./StepCreateQuote.tsx";
import { InsightsRail } from "./InsightsRail.tsx";
import { needsCalculation } from "./configProcessState.ts";

// Pinned so the picked row's CardName can be read back off it by name — EntityValueHelp aligns the
// row with [keyField, ...select minus keyField]. Same pair the portal invite dialog uses.
/** The calculation's inputs, edited as one unit — see `draft` below. */
type Draft = { entries: Entries; batches: number[]; tables: TableRows };
/** What configs.get returns. Mutations return a subset of it — `calculate` omits the model, which
 *  cannot change while a configuration has inputs — so the cache is patched, never replaced. */
type Payload = Awaited<ReturnType<typeof client.configs.get>>;

const CUSTOMER_SELECT = ["CardCode", "CardName"];
const CUSTOMER_FILTER = [{ field: "CardType", op: "eq" as const, value: "cCustomer" }];

// One scroll: Configure, Candidates, Create quote. Missing run or selection is an empty state.
// Local overlays (override ?? server) until persist.
export function ConfigProcessPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  const modelId = q.data?.project.modelId;
  const lookups = useQuery({
    ...orpc.configs.lookups.queryOptions({ input: { modelId: modelId!, entries: q.data?.project.entries ?? {} } }),
    // Canonical page is per-model. Entries only enrich that first fetch; putting them in the key
    // remounts every control after autosave and retriggers UI5 onChange → another calculate.
    queryKey: orpc.configs.lookups.queryOptions({ input: { modelId: modelId! } }).queryKey,
    enabled: !!modelId,
    staleTime: 5 * 60_000, // matches the server-side cache window
    placeholderData: keepPreviousData,
    retry: false, // agent-offline should show its message, not spin
  });

  const models = useQuery(orpc.configs.models.queryOptions());

  const [picks, setPicks] = useState<QueryPicks>({});
  // The unsaved edit, or null when the page is showing exactly what the server holds. One object,
  // not three overlays: `draft !== null` IS the dirty flag, so nothing has to diff against the
  // server row, and configs.calculate clears it by returning the saved project.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  // Which insight panels are expanded. Lives here (not in the rail) so scrolling past Configure
  // doesn't reset it. Panel's `fixed` keeps the last open one from collapsing.
  const [openPanels, setOpenPanels] = useState(new Set(["costs"]));
  // Rail visibility. Two flags, not one: DynamicSideContent hides its side column with a hard
  // display:none, so the exit animation has to finish before the column goes.
  const [railOpen, setRailOpen] = useState(true);
  const [railMounted, setRailMounted] = useState(true);
  const togglePanel = (k: string) =>
    setOpenPanels((o) => {
      if (!o.has(k)) return new Set(o).add(k);
      if (o.size === 1) return o; // last one open — `fixed` blocks this anyway
      const n = new Set(o);
      n.delete(k);
      return n;
    });
  // Every mutation returns the part of configs.get's payload it could have changed, so the
  // response IS the refetch — no invalidate, no second round trip per edit.
  const setProject = (patch: Partial<Payload>) =>
    qc.setQueryData(orpc.configs.get.queryOptions({ input: { id } }).queryKey,
      (prev) => (prev ? { ...prev, ...patch } : prev));
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: setProject }));
  const reject = useMutation(orpc.configs.reject.mutationOptions({
    onSuccess: (data) => { setRejectOpen(false); setProject(data); },
  }));
  const calc = useMutation(orpc.configs.calculate.mutationOptions({
    onSuccess: (data) => {
      setDraft(null);  // the server now holds what the draft held
      setSel([]);      // a new calculation invalidates any previous candidate picks
      setProject(data);
    },
  }));
  const select = useMutation(orpc.configs.select.mutationOptions({
    onSuccess: (data) => {
      setSel(null); // use persisted selection after save
      setProject(data);
      toast("Selection saved");
    },
  }));
  // The two actions that leave this page. Neither can use setProject: duplicate answers with a
  // different id and delete leaves nothing to patch, so both invalidate the list keys instead.
  const invalidateLists = () => {
    void qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
  };
  const duplicate = useMutation(orpc.configs.duplicate.mutationOptions({
    onSuccess: (r) => { invalidateLists(); toast("Configuration duplicated"); void navigate({ to: "/configs/$id", params: { id: r.id } }); },
  }));
  const remove = useMutation(orpc.configs.remove.mutationOptions({
    onSuccess: () => { invalidateLists(); toast("Configuration deleted"); void navigate({ to: "/configs" }); },
  }));

  const project = q.data?.project;
  const model = q.data?.model;
  const createdByEmail = q.data?.createdByEmail;
  const { entries, batches, tables } = draft ?? {
    entries: project?.entries ?? {}, batches: project?.batches ?? [], tables: project?.tables ?? {},
  };
  // Quoted is the server's lock (assertConfigMutable fences update/calculate/select; remove
  // refuses quoted with the same CONFLICT). The page goes read-only rather than letting every
  // edit walk into that error.
  const locked = project?.status === "quoted";
  const candidates = project?.candidates ?? [];
  const selection = selOverride ?? project?.selection ?? [];
  // Candidates are emptied by the same write that changes their inputs, so holding any is proof
  // they match — there is no `calculated` status to consult.
  const runReady = candidates.length > 0;
  // Anything a model switch would throw away. Checked against the live values, not the persisted
  // ones, so the field locks on the first keystroke rather than a second later.
  const modelLocked =
    Object.keys(entries).length > 0 || Object.values(tables).some((rows) => rows.length > 0);
  const lk = lookups.data ? mergeQueryPicks(lookups.data, picks) : undefined;
  const prop = model && lk ? propagate(model.definition, lk, entries, tables) : null;
  const conflicted = !!prop && prop.conflicts.length > 0;
  // calc.reset() reopens the effect's isError gate — the same reason select.reset() runs on a
  // candidate edit below. Without it one failing calculation retries every second forever.
  const edit = (patch: Partial<Draft>) => {
    calc.reset();
    setDraft({ entries, batches, tables, ...patch });
  };
  // Everything set on the configuration itself that Calculate needs. cardCode, not just a truthy
  // customer: a half-filled one would otherwise pass the gate and reach the B1 quotation seed.
  const missing = [
    ...(project?.name.trim() ? [] : ["name"]),
    ...(project?.customer?.cardCode ? [] : ["business partner"]),
  ];
  const calcBusy = update.isPending || calc.isPending;
  const shouldCalc = !!project && needsCalculation({
    locked,
    conflicted,
    missingCount: missing.length,
    batchCount: batches.length,
    lookupsReady: !!lk,
    dirty: draft !== null,
    runReady,
  });

  // One call writes the edit and returns the calculation it produced. `draft` in the deps is what
  // restarts the debounce per keystroke; `calc.isError` stops a hopeless input retrying forever.
  useEffect(() => {
    if (!shouldCalc || calcBusy || calc.isError) return;
    const t = setTimeout(() => calc.mutate({ id, ...(draft ?? {}) }), 1000);
    return () => clearTimeout(t);
  }, [shouldCalc, calcBusy, calc.isError, draft, id]);

  // A quoted configuration has nothing to configure, so the rail starts collapsed and stays that
  // way. ponytail: one timer matched to the keyframe, not an animationend listener — if the two
  // durations ever drift apart, swap this for onAnimationEnd on the rail.
  const railShown = railOpen && !locked;
  useEffect(() => {
    if (railShown) { setRailMounted(true); return; }
    const t = setTimeout(() => setRailMounted(false), 200);
    return () => clearTimeout(t);
  }, [railShown]);

  const copyValues = (values: Record<string, Val>) => {
    const next = { ...entries };
    for (const [k, v] of Object.entries(values)) {
      const cur = next[k];
      if ((cur === undefined || cur === null || cur === "") && v !== null && v !== undefined) next[k] = v;
    }
    edit({ entries: next }); // fills only empty params; page-level propagate() takes it from here
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
  const st = statusUi[project.status] ?? statusUi.draft;

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
        <Button design="Emphasized" disabled={locked || select.isPending || selection.length === 0}
          onClick={saveSelection}>
          {select.isPending ? "Saving…" : "Save selection"}
        </Button>
      } />
  );

  // No ObjectPageHeader: the "requested" context moved into the title's subHeader (with Reject next
  // to the other title actions), and the errors into the title's own content slot — they render
  // only when there is something to say, so nothing eats vertical space in the normal case.
  const messages = locked || lookups.error || update.error || calc.error || duplicate.error || remove.error ? (
    <div style={{ paddingBlockStart: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
      {lookups.error ? (
        <div style={{ display: "flex", alignItems: "center"}}>
          <MessageStrip design="Negative" hideCloseButton style={{ flex: 1 }}>{lookups.error.message}</MessageStrip>
          <Button onClick={() => lookups.refetch()}>Retry</Button>
        </div>
      ) : null}
      {update.error || calc.error || duplicate.error || remove.error ? (
        <MessageStrip design="Negative" hideCloseButton>
          {(update.error ?? calc.error ?? duplicate.error ?? remove.error)!.message}
        </MessageStrip>
      ) : null}
    </div>
  ) : null;

  // The rail sits OUTSIDE the ObjectPage: ObjectPage collects sub-tabs from direct children only,
  // so wrapping the subsections would silently drop Configure's sub-anchor tabs.
  // DynamicSideContent handles the responsive drop-below itself — no media queries. Its own
  // show/hide is a hard display:none though, so the slide lives on the rail (.hera-rail).
  return (
    <>
    <DynamicSideContent
      sideContentVisibility="AlwaysShow"
      hideSideContent={!railShown && !railMounted}
      sideContent={
        <InsightsRail projectId={id} model={model.definition} lk={lk} prop={prop} entries={entries}
          onCopy={copyValues} open={openPanels} onToggle={togglePanel}
          className={railShown ? "hera-rail" : "hera-rail hera-rail-out"} />
      }>

    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      titleArea={
        <ObjectPageTitle
          header={<Title>{project.name.trim() || "New configuration"}</Title>}
          subHeader={
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
              {project.customer?.cardName ? <Text>{project.customer.cardName}</Text> : null}
              {project.status === "requested" ? (
                <Text>Requested by {createdByEmail ?? "a portal user"}</Text>
              ) : null}
            </div>
          }
          actionsBar={
            <Toolbar design="Transparent">
              <Button design="Transparent" disabled={locked}
                icon={railShown ? "close-command-field" : "open-command-field"}
                tooltip={locked ? "A quoted configuration has nothing left to configure"
                  : railShown ? "Hide insights" : "Show insights"}
                onClick={() => setRailOpen((o) => !o)} />
              {/* Duplicate copies what is stored and recalculates it, so an unsaved draft would
                  not be in the copy — disabled until the pending edits have been calculated. */}
              <Button icon="copy" design="Transparent" disabled={draft !== null || duplicate.isPending}
                tooltip={draft !== null ? "Calculate first" : "Duplicate configuration"}
                onClick={() => duplicate.mutate({ id })}>
                {duplicate.isPending ? "Duplicating…" : "Duplicate"}
              </Button>
              <Button icon="delete" design="Transparent" disabled={locked || remove.isPending}
                tooltip={locked ? "A quoted configuration cannot be deleted" : "Delete configuration"}
                onClick={async () => {
                  if (await confirm({
                    title: "Delete configuration",
                    // Same fallback as the title: a configuration is created unnamed.
                    message: `Delete "${project.name.trim() || "New configuration"}"? This can't be undone.`,
                    actionText: "Delete", destructive: true,
                  })) remove.mutate({ ids: [id] });
                }}>
                Delete
              </Button>
              {project.status === "requested" ? (
                <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
              ) : null}
            </Toolbar>
          }
          // ObjectPageTitle has no `snappedHeading` — that is DynamicPageTitle's. Its content rows
          // are snapped/expandedContent, and `snappedHeader` would *replace* the Title. With no
          // headerArea this title is permanently snapped (ObjectPage only sets
          // data-header-content-visible when there is one), so snappedContent is the one that
          // renders; expandedContent is fed the same node for the day a headerArea appears.
          snappedContent={messages}
          expandedContent={messages}>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>
            {st.text}
          </Tag>
        </ObjectPageTitle>
      }
      footerArea={!locked ? footer : undefined}
    >
      <ObjectPageSection id="configure" titleText="Configure">
        <ObjectPageSubSection id="general" titleText="General">
          {/* The configuration's own attributes. No draft state: each control commits on change
              (UI5 fires that on blur/Enter) against the server value, and `required` + a negative
              valueState on the empty case is the Fiori way to say the same thing the footer does.
              Display mode is Text, matching ConfiguratorForm — accessibleMode only announces it. */}
          <Form labelSpan="S12 M12 L12 XL12" layout="S1 M2 L3 XL3"
            accessibleMode={locked ? "Display" : "Edit"} itemSpacing={locked ? "Large" : "Normal"}>
            <FormGroup>
              <FormItem labelContent={<Label for={locked ? undefined : "cfg-name"} required>Name</Label>}>
                {locked ? <Text>{project.name}</Text> : (
                <Input id="cfg-name" value={project.name} style={{ width: "100%" }}
                  disabled={update.isPending}
                  valueState={project.name.trim() ? "None" : "Negative"}
                  onChange={(e) => {
                    const v = (e.target.value ?? "").trim();
                    if (v && v !== project.name) update.mutate({ id, name: v });
                  }} />
                )}
              </FormItem>
              <FormItem labelContent={<Label required>Model</Label>}>
                {locked ? (
                  <Text>{(models.data ?? []).find((m) => m.id === project.modelId)?.name ?? ""}</Text>
                ) : (
                /* Switching the model wipes every entry, batch and table row, because a param key
                    only means something inside its own model. Rather than warn about that, the
                    field simply stops being editable once there is anything to lose — which is
                    also why configs.calculate does not bother returning the model definition. */
                <Select value={project.modelId} style={{ width: "100%" }}
                  disabled={update.isPending || modelLocked}
                  onChange={(e) => {
                    const v = e.detail.selectedOption.value ?? "";
                    if (!v || v === project.modelId) return;
                    // A model switch wipes entries/batches/tables server-side; drop the local
                    // overlays too, or the old model's values are re-applied on top of the new form.
                    setDraft(null); setSel(null); setPicks({});
                    update.mutate({ id, modelId: v });
                  }}>
                  {(models.data ?? []).map((m) => (
                    <Option key={m.id} value={m.id}>{m.name}</Option>
                  ))}
                </Select>
                )}
              </FormItem>
              <FormItem labelContent={<Label required>Customer</Label>}>
                {locked ? <Text>{project.customer?.cardName ?? ""}</Text> : (
                <EntityValueHelp entitySet="BusinessPartners" keyField="CardCode"
                  select={CUSTOMER_SELECT} filter={CUSTOMER_FILTER}
                  value={project.customer?.cardCode}
                  valueState={project.customer?.cardCode ? "None" : "Negative"}
                  headerText="Select a customer"
                  onChange={(v, row) => update.mutate({
                    id,
                    customer: v == null || v === "" ? null : {
                      cardCode: String(v),
                      // by name, not a literal 1, so reordering CUSTOMER_SELECT can't swap the fields
                      cardName: String(row?.[CUSTOMER_SELECT.indexOf("CardName")] ?? project.customer?.cardName ?? ""),
                    },
                  })} />
                )}
              </FormItem>
            </FormGroup>
          </Form>
        </ObjectPageSubSection>
        <ObjectPageSubSection id="batches" titleText="Batch quantities">
          {lookups.data && lk && prop ? (
            <ConfiguratorForm section={BATCHES_SECTION} model={model.definition} lookups={lookups.data}
              lk={lk} prop={prop} entries={entries} onChange={(next) => edit({ entries: next })}
              onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
              querySource={{ kind: "project", modelId: project.modelId }} readOnly={locked}
              batches={batches} onBatchesChange={(next) => edit({ batches: next })} />
          ) : lookups.error ? null : <BusyIndicator active delay={0} />}
        </ObjectPageSubSection>
        {/* formSections, not structure.sections: a table the author never placed gets a trailing
            subsection of its own, and the anchor bar has to show it. */}
        {formSections(model.definition).map((s) => (
          <ObjectPageSubSection key={s.key} id={s.key} titleText={s.title}>
            {lookups.data && lk && prop ? (
              <ConfiguratorForm section={s.key} model={model.definition} lookups={lookups.data} lk={lk} prop={prop} entries={entries}
                onChange={(next) => edit({ entries: next })}
                onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
                querySource={{ kind: "project", modelId: project.modelId }} readOnly={locked}
                tables={tables} onTablesChange={(next) => edit({ tables: next })} />
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
            capped={q.data.capped}
            widest={q.data.widest}
            error={select.error?.message ?? null} saved={select.isSuccess} readOnly={locked} />
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
