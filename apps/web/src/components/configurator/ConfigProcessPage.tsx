import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, Dialog, DynamicSideContent, Form, FormGroup, FormItem, IllustratedMessage,
  Input, Label, MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle, ObjectStatus,
  Option, Panel, Select, Tag, Text, TextArea, Title, ToggleButton, Toolbar, ToolbarButton, ToolbarItem,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { evalTableRows, propagate, type Entries, type ItemsTable, type TableRows, type Val } from "@confire/config-engine";
import { mergeQueryPicks, setQueryPick, type QueryPicks } from "./formHelpers.ts";
import { client, meQuery, orpc, useCurrency } from "../../orpc.ts";
import { money as formatMoney } from "../../lib/money.ts";
import { confirm } from "../confirm.ts";
import { toast } from "../toast.ts";
import { statusUi, toggleSelection, toPriced, unpricedItems, type Sel } from "./runView.ts";
import { BATCHES_SECTION, ConfiguratorForm, ConsistencyStatus } from "./ConfiguratorForm.tsx";
import { CflField } from "../../shared/cfl/CflField.tsx";
import { cfl } from "../../shared/cfl/cfl-configs.ts";
import { PriceAnalysis } from "./PriceAnalysis.tsx";
import { CostBody, OptionPrices } from "./InsightsRail.tsx";
import { SimilarConfigs } from "./SimilarConfigs.tsx";
import { paramPrices } from "./costElements.ts";
import { itemMoney, moneyTotals } from "./itemMoney.ts";
import { needsCalculation } from "./configProcessState.ts";
import { configMessages } from "./configMessages.ts";
import { PageMessages } from "../PageMessages.tsx";
import { useSectionParam } from "../../lib/sectionParam.ts";

/** The calculation's inputs, edited as one unit — see `draft` below. */
type Draft = { entries: Entries; batches: number[]; tables: TableRows };
/** What configs.get returns. Mutations return a subset of it — `calculate` omits the model, which
 *  cannot change while a configuration has inputs — so the cache is patched, never replaced. */
type Payload = Awaited<ReturnType<typeof client.configs.get>>;

// One shared empty array, so `?? []` does not mint a new reference every render and bust the
// memos below.
const NONE: never[] = [];

/** The customer value help: customers only, with a link to the BP for whoever may open /b1. */
const CUSTOMER = { dialogConfig: cfl.customers() };

/** One insights panel's content column. */
const PANEL_BODY = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0 0.25rem 0.5rem" } as const;

// One scroll: Configure, Candidates, Create quote. Missing run or selection is an empty state.
// Local overlays (override ?? server) until persist.
export function ConfigProcessPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const currency = useCurrency();
  const sectionParam = useSectionParam();
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  // Cached by _authed's beforeLoad, so this costs nothing. /b1 is admin/owner only.
  const me = useQuery(meQuery);
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
  // The batch quantity the items grid is priced at. Read through `batches` below, so a deleted
  // quantity falls back to the first rather than pricing at a batch that no longer exists.
  const [viewQty, setViewQty] = useState<number | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [railOpen, setRailOpen] = useState(true);
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
      setDraft(null); // the server now holds what the draft held
      setSel(null);   // and dropped the selection along with the candidates it indexed
      setProject(data);
    },
  }));
  // Saved by the effect below. The overlay clears only if no click landed while this save was in
  // flight — otherwise it holds the newer picks, and the effect sends those next.
  const select = useMutation(orpc.configs.select.mutationOptions({
    onSuccess: (data, vars) => {
      setSel((cur) => (cur === vars.selection ? null : cur));
      setProject(data);
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
  // Refill the cache the form is drawn from. Not setProject: the answer changes the *lookups*, not
  // the project, so the lookups query is what gets invalidated.
  const sync = useMutation(orpc.configs.sync.mutationOptions({
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: orpc.configs.lookups.queryOptions({ input: { modelId: modelId! } }).queryKey });
      toast(r.tables ? `Synced ${r.count} rows from ${r.tables} ${r.tables === 1 ? "query" : "queries"}` : "Nothing to sync");
    },
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
  const candidates = project?.candidates ?? NONE;
  const selection = selOverride ?? project?.selection ?? NONE;
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
  // The items grid's cost and price, derived on every render and stored nowhere — see itemMoney.ts.
  // Same itemSplit the server posts with, so the grid cannot show a price the quotation will not
  // carry. One batch quantity at a time, picked in the items section's header.
  const itemsDef = (model?.definition.tables ?? NONE).find((t): t is ItemsTable => t.role === "items");
  const itemQty = batches.find((b) => b === viewQty) ?? batches[0];
  const money = useMemo(
    () => (model && lk && itemsDef && itemQty !== undefined
      ? itemMoney({
          model: model.definition, lookups: lk, items: itemsDef,
          tables, candidates, selection, batchQty: itemQty,
        })
      : null),
    [model, lk, itemsDef, tables, candidates, selection, itemQty],
  );
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

  // Picks save themselves, like the inputs: `selOverride !== null` is their dirty flag. One save at
  // a time, so the server applies them in click order; `select.isError` stops a refused pick
  // retrying forever, and the next click's select.reset() reopens it.
  useEffect(() => {
    if (selOverride === null || select.isPending || select.isError) return;
    select.mutate({ projectId: id, selection: selOverride });
  }, [selOverride, select.isPending, select.isError, id]);

  // A quoted configuration has nothing to configure, so the rail starts collapsed and stays that way.
  const railShown = railOpen && !locked;

  // Fills only empty params; page-level propagate() takes it from here. Nothing to fill is not an
  // edit: a draft equal to the saved inputs would still cost a calculation.
  const copyValues = (values: Record<string, Val>) => {
    const next = { ...entries };
    let n = 0;
    for (const [k, v] of Object.entries(values)) {
      const cur = next[k];
      if ((cur === undefined || cur === null || cur === "") && v !== null && v !== undefined) { next[k] = v; n++; }
    }
    if (n) edit({ entries: next });
    toast(n ? `Filled ${n} field${n === 1 ? "" : "s"}` : "Those fields already have values");
  };

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  if (!project || !model) return null;
  const st = statusUi[project.status] ?? statusUi.draft;
  // What the picked cells price at, before any hand-typed price in the items grid moves it — the
  // grid and the quotation, not this figure, are what the customer is charged.
  const selectedTotal = selection.reduce((n, s) =>
    n + (candidates[s.candidateIdx]?.perBatch.find((b) => b.batchQty === s.batchQty)?.outputs.batchTotal ?? 0), 0);
  // The rail's figures. Evaluated rows, not the raw cells, so a computed item code counts — the
  // same evalTableRows the grid and the quotation's lines are drawn from. The raw rows are where a
  // typed price lives.
  const rawItems = itemsDef ? tables[itemsDef.key] ?? NONE : NONE;
  const itemRows = itemsDef ? evalTableRows(itemsDef, rawItems, prop?.values ?? {}, lk?.tables) : NONE;
  const totals = money ? moneyTotals(money, rawItems) : null;
  // Same paramPrices() the per-field badges read, so the two cannot disagree.
  const optionPrices = lk && prop ? paramPrices(model.definition, prop, lk.tables) : NONE;

  const footer = (
    <Bar design="FloatingFooter"
      startContent={
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {prop ? <ConsistencyStatus prop={prop} /> : null}
          {missing.length ? <ObjectStatus state="Critical">{missing.join(" and ")} required</ObjectStatus> : null}
          {shouldCalc || calcBusy || select.isPending ? <BusyIndicator active delay={0} size="S" /> : null}
          {selection.length ? <Text>Selected: {formatMoney(selectedTotal, currency)}</Text> : null}
        </div>
      }
      endContent={
        <>
          {/* The finalizing action, and the only Emphasized one on the page — the Fiori rule.
              configs.quoteDraft builds from the *saved* selection, so a pick still saving or a
              pending edit has nothing to quote yet. */}
          <Button design="Emphasized"
            disabled={locked || draft !== null || selOverride !== null || !project.selection?.length}
            tooltip={draft !== null ? "Calculate first"
              : selOverride !== null ? (select.isError ? "The selection was not saved — see messages" : "Saving the selection…")
              : !project.selection?.length ? "Pick at least one price under Candidates" : "Create the quotation in SAP"}
            onClick={() => navigate({ to: "/configs/$id/quote", params: { id } })}>
            Create quote
          </Button>
          {/* Answering a portal request is finalizing too, so it sits with Create quote, not in the
              title's object actions. */}
          {project.status === "requested" ? (
            <Button design="Negative" onClick={() => setRejectOpen(true)}>Reject</Button>
          ) : null}
        </>
      } />
  );

  // No ObjectPageHeader and no message strips: everything the page has to say is one list behind
  // the title's MessageViewButton, grouped by the section it belongs to.
  const messages = configMessages({
    model: model.definition,
    name: project.name,
    customer: !!project.customer?.cardCode,
    prop,
    candidates: candidates.length,
    unpriced: unpricedItems(candidates),
    capped: q.data.capped,
    widest: q.data.widest,
    lookupsError: lookups.error as Error | null,
    sync: lookups.data?.sync,
    syncError: sync.error as Error | null,
    configError: (update.error ?? calc.error ?? duplicate.error ?? remove.error) as Error | null,
    selectError: select.error as Error | null,
    locked,
  });

  return (
    <>
    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      {...sectionParam.props}
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
          navigationBar={
            <Toolbar design="Transparent">
              {/* A Toolbar only measures — and overflows — its own item types: the two plain
                  controls are wrapped, everything else is a ToolbarButton. */}
              <ToolbarItem overflowPriority="NeverOverflow">
                <PageMessages messages={messages} okText="No issues — everything checks out."
                  onSection={sectionParam.go} />
              </ToolbarItem>
              {/* A toggle, so the pressed state is announced — Fiori's trigger for side content. */}
              <ToolbarItem overflowPriority="NeverOverflow">
                <ToggleButton design="Transparent" disabled={locked} pressed={railShown}
                  icon={railShown ? "close-command-field" : "open-command-field"}
                  tooltip={locked ? "A quoted configuration has nothing left to configure"
                    : railShown ? "Hide insights" : "Show insights"}
                  onClick={() => setRailOpen((o) => !o)} />
              </ToolbarItem>
              <ToolbarButton icon="synchronize" design="Transparent" disabled={sync.isPending}
                tooltip="Refresh the SAP data this model reads"
                onClick={() => sync.mutate({ id })} />
              {project.b1DocEntry !== null && (me.data?.role === "admin" || me.data?.role === "owner") ? (
                <ToolbarButton icon="document-text" design="Transparent" text="Open quotation"
                  onClick={() => navigate({
                    to: "/b1/$entity/$key",
                    params: { entity: "Quotations", key: String(project.b1DocEntry) },
                  })} />
              ) : null}
            </Toolbar>
          }
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarButton icon="copy" design="Transparent" disabled={draft !== null || duplicate.isPending}
                tooltip={draft !== null ? "Calculate first" : "Duplicate configuration"}
                text={duplicate.isPending ? "Duplicating…" : "Duplicate"}
                onClick={() => duplicate.mutate({ id })} />
              <ToolbarButton icon="delete" design="Transparent" disabled={locked || remove.isPending}
                tooltip={locked ? "A quoted configuration cannot be deleted" : "Delete configuration"}
                text="Delete"
                onClick={async () => {
                  if (await confirm({
                    title: "Delete configuration",
                    // Same fallback as the title: a configuration is created unnamed.
                    message: `Delete "${project.name.trim() || "New configuration"}"? This can't be undone.`,
                    actionText: "Delete", destructive: true,
                  })) remove.mutate({ ids: [id] });
                }} />
            </Toolbar>
          }>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>
            {st.text}
          </Tag>
        </ObjectPageTitle>
      }
      footerArea={!locked ? footer : undefined}
    >
      <ObjectPageSection id="configure" titleText="Configure" fitContent>
        <DynamicSideContent style={{ flex: 1, minHeight: 0 }} sideContentVisibility="AlwaysShow"
          hideSideContent={!railShown} accessibilityAttributes={{ sideContent: { ariaLabel: "Insights" } }}
          sideContent={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem" }}>
              {/* The total rides in headerText rather than a `header` slot: a custom header is only
                  toggled by its arrow, this one by the whole bar — and the figure survives collapsing. */}
              <Panel accessibleRole="Region" headerLevel="H5"
                headerText={totals ? `Cost elements · ${formatMoney(totals.cost, currency)}` : "Cost elements"}>
                <div style={PANEL_BODY}>
                  {money && totals ? (
                    <CostBody rows={itemRows} money={money} totals={totals} cur={currency} />
                  ) : (
                    <IllustratedMessage name="NoData" design="ExtraSmall" titleText="No costs yet"
                      subtitleText="Add at least one item with a quantity — the calculation fills this in." />
                  )}
                  {optionPrices.length ? <OptionPrices rows={optionPrices} cur={currency} /> : null}
                </div>
              </Panel>
              <Panel accessibleRole="Region" headerLevel="H5" headerText="Similar configurations" collapsed>
                <div style={PANEL_BODY}>
                  <SimilarConfigs projectId={id} model={model.definition} entries={entries} onCopy={copyValues} />
                </div>
              </Panel>
            </div>
          }>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", paddingBlockEnd: "1rem" }}>
            {/* The configuration's own attributes. No draft state: each control commits on change
                (UI5 fires that on blur/Enter) against the server value, and `required` + a negative
                valueState on the empty case is the Fiori way to say the same thing the footer does.
                Display mode is Text, matching ConfiguratorForm — accessibleMode only announces it. */}
            <Form headerText="General" headerLevel="H5" labelSpan="S12 M12 L12 XL12" layout="S1 M2 L3 XL3"
              accessibleMode={locked ? "Display" : "Edit"} itemSpacing={locked ? "Large" : "Normal"}>
              <FormGroup>
                <FormItem labelContent={<Label for={locked ? undefined : "cfg-name"} required>Name</Label>}>
                  {locked ? <Text>{project.name}</Text> : (
                  <Input id="cfg-name" value={project.name} style={{ width: "100%" }}
                    disabled={update.isPending}
                    valueState={project.name.trim() ? "None" : "Negative"}
                    valueStateMessage={<div>The configuration needs a name before it can be quoted.</div>}
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
                  /* Wrapper, not a prop: the id is only a jump target for the message popover. */
                  <div id="cfg-customer" style={{ width: "100%" }}>
                  {/* Only a customer SAP knows is saved: the row select — a pick, or a typed code the
                      existence check found — writes the pair. A keystroke writes nothing; clearing
                      the field clears the customer. */}
                  <CflField config={CUSTOMER} value={project.customer?.cardCode ?? null} link
                    disabled={update.isPending}
                    error={project.customer?.cardCode ? null : "Pick the customer the quote is written for — SAP needs a business partner on the document."}
                    onValueChange={(v) => {
                      if ((v === null || v === "") && project.customer) update.mutate({ id, customer: null });
                    }}
                    onRowSelect={(row) => update.mutate({
                      id,
                      customer: { cardCode: String(row.CardCode ?? ""), cardName: String(row.CardName ?? "") },
                    })} />
                  </div>
                  )}
                </FormItem>
              </FormGroup>
            </Form>
            {lookups.data && lk && prop ? (
              <>
                <ConfiguratorForm section={BATCHES_SECTION} model={model.definition} lookups={lookups.data}
                  lk={lk} prop={prop} entries={entries} onChange={(next) => edit({ entries: next })}
                  onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
                  querySource={{ kind: "project", modelId: project.modelId }} readOnly={locked}
                  batches={batches} onBatchesChange={(next) => edit({ batches: next })} />
                <ConfiguratorForm model={model.definition} lookups={lookups.data} lk={lk} prop={prop} entries={entries}
                  onChange={(next) => edit({ entries: next })}
                  onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
                  querySource={{ kind: "project", modelId: project.modelId }} readOnly={locked}
                  tables={tables} onTablesChange={(next) => edit({ tables: next })} itemMoney={money}
                  batches={batches} itemBatch={itemQty} onItemBatchChange={setViewQty} />
              </>
            ) : lookups.error ? (
              /* Why the options are missing is a page message; the retry it needs is not something
                 a message can carry, so the button stays here. */
              <Button icon="refresh" onClick={() => void lookups.refetch()}>Retry loading options</Button>
            ) : <BusyIndicator active delay={0} />}
          </div>
        </DynamicSideContent>
      </ObjectPageSection>
      <ObjectPageSection id="candidates" titleText="Candidates">
        {/* capped/widest are not passed: this page reports them in its message popover. No lookups
            needed either — the prices are the calculation's own, so they render with the agent off.
            A pending edit is about to replace these candidates, so they stop taking picks. */}
        {candidates.length > 0 ? (
          <PriceAnalysis model={model.definition} entries={project.entries}
            candidates={candidates.map(toPriced)} selection={selection}
            onToggle={(i, b) => { select.reset(); setSel(toggleSelection(selection, i, b)); }}
            disabled={locked || draft !== null} />
        ) : (
          <IllustratedMessage name="NoData" design="Medium" titleText="No candidates yet"
            subtitleText="They appear here once the configuration is complete and has calculated." />
        )}
      </ObjectPageSection>
    </ObjectPage>

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

