import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, Button, BusyIndicator, DynamicSideContent, Form, FormGroup, FormItem, IllustratedMessage,
  Input, Label, MessageStrip, MultiInput, ObjectPage, ObjectPageSection, ObjectPageTitle,
  Option, Panel, Select, Tag, Text, Title, ToggleButton, Token, Toolbar, ToolbarButton, ToolbarItem,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import {
  evalTableRows, missingInputs, paramPrices, propagate,
  type Entries, type ItemsTable, type TableRows, type Val,
} from "@confire/config-engine";
import { addBatch, mergeQueryPicks, setQueryPick, type QueryPicks } from "@confire/ui/configurator/formHelpers.ts";
import { client, orpc, useCurrency, useIsAdmin } from "../../orpc.ts";
import { money as formatMoney } from "@confire/ui/money.ts";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { ProjectTimeline } from "@confire/ui/timeline/ProjectTimeline.tsx";
import { toast } from "@confire/ui/toast.ts";
import { toPriced, unpricedItems, type Sel } from "./runView.ts";
import { ConfiguratorForm, ConsistencyStatus } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { PriceAnalysis } from "./PriceAnalysis.tsx";
import { CostBody, OptionPrices } from "./InsightsRail.tsx";
import { SimilarConfigs } from "./SimilarConfigs.tsx";
import { itemMoney, moneyTotals } from "./itemMoney.ts";
import { configMessages } from "./configMessages.ts";
import { PageMessages } from "../PageMessages.tsx";
import { useSectionParam } from "../../lib/sectionParam.ts";

/** The calculation's inputs, edited as one unit — see `draft` below. */
type Draft = { entries: Entries; batches: number[]; tables: TableRows };
/** What configs.get returns. Mutations return a subset of it — `calculate` omits the model, which
 *  cannot change while a configuration has inputs — so the cache is patched, never replaced. */
type Payload = Awaited<ReturnType<typeof client.configs.get>>;
/** The configuration's own fields — the General form. */
type Head = Pick<Payload["project"], "name" | "modelId" | "customer">;

// One shared empty array, so `?? []` does not mint a new reference every render and bust the
// memos below.
const NONE: never[] = [];

/** The customer value help: customers only, with a link to the BP for whoever may open /b1. */
const CUSTOMER = { dialogConfig: cfl.customers() };

/** The batch field's message anchor. `__`: data-param shares its namespace with parameter keys. */
const BATCHES = "__batches";

/** One insights panel's content column. */
const PANEL_BODY = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0 0.25rem 0.5rem" } as const;

// Two tabs, Configure and Candidates, and one finalizing action in the footer once everything the
// quote needs is filled. Local overlays (override ?? server) until persist.
// `new` (/configs/new) is the General form alone: there is no id yet, and nothing that reads one
// runs before the configuration exists.
export function ConfigProcessPage({ id = "", new: isNew = false }: { id?: string; new?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const currency = useCurrency();
  const sectionParam = useSectionParam();
  const isAdmin = useIsAdmin(); // /b1 is admin/owner only
  const getKey = orpc.configs.get.queryKey({ input: { id } });
  const q = useQuery({ ...orpc.configs.get.queryOptions({ input: { id } }), enabled: !isNew });
  const modelId = q.data?.project.modelId;
  const lookupsKey = orpc.configs.lookups.queryKey({ input: { modelId: modelId! } });
  const lookups = useQuery({
    ...orpc.configs.lookups.queryOptions({ input: { modelId: modelId!, entries: q.data?.project.entries ?? {} } }),
    // Entries only enrich the first fetch (the stored values past the canonical page); in the key,
    // every autosave would remount every control and retrigger UI5 onChange → another calculate.
    // The id is in it: that enrichment is this configuration's, so another configuration of the
    // same model must not be served it. Sync invalidates the model's prefix.
    queryKey: [...lookupsKey, id],
    enabled: !!modelId,
    staleTime: 5 * 60_000, // rows move only when a sync refills them; Sync data invalidates this
    retry: false, // a failure is a page message plus its own Retry button, not a spinner
  });

  const [picks, setPicks] = useState<QueryPicks>({});
  // The unsaved edit, or null when the page is showing exactly what the server holds. One object,
  // not three overlays: `draft !== null` IS the dirty flag, so nothing has to diff against the
  // server row, and configs.calculate clears it by returning the saved project.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selOverride, setSel] = useState<Sel[] | null>(null);
  // The batch quantity the items grid is priced at. Read through `batches` below, so a deleted
  // quantity falls back to the first rather than pricing at a batch that no longer exists.
  const [viewQty, setViewQty] = useState<number | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  // Whether the footer is mounted. It outlives `showFooter` by its out animation, which is what
  // clears this; `showFooter` turning true sets it straight away (below).
  const [footerUp, setFooterUp] = useState(false);
  // Every mutation returns the part of configs.get's payload it could have changed, so the
  // response IS the refetch — no invalidate, no second round trip per edit.
  const setProject = (patch: Partial<Payload>) =>
    qc.setQueryData(getKey, (prev) => (prev ? { ...prev, ...patch } : prev));
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: setProject }));
  const calc = useMutation(orpc.configs.calculate.mutationOptions({
    onSuccess: (data, vars) => {
      // The server now holds what the sent draft held. An edit made while this call was in flight
      // is newer than the answer, so it stays and the effect sends it next. `{ id, ...draft }`
      // keeps each field's reference, so identity says whether the draft moved on — as in select.
      setDraft((cur) => (cur && cur.entries === vars.entries && cur.batches === vars.batches
        && cur.tables === vars.tables ? null : cur));
      setSel(null); // and dropped the selection along with the candidates it indexed
      setProject(data);
    },
    // A recompute that throws still keeps the edits and has emptied the candidates server-side
    // (configs.calculate), so the cached candidates are no longer what the server holds.
    onError: () => void qc.invalidateQueries({ queryKey: getKey }),
  }));
  // Saved by the effect below. The overlay clears only if no click landed while this save was in
  // flight — otherwise it holds the newer picks, and the effect sends those next.
  const select = useMutation(orpc.configs.select.mutationOptions({
    onSuccess: (data, vars) => {
      setSel((cur) => (cur === vars.selection ? null : cur));
      setProject(data);
    },
  }));
  // The actions that leave this page. None can use setProject: create and duplicate answer with a
  // different id and delete leaves nothing to patch, so all invalidate the list keys instead.
  const invalidateLists = () => {
    void qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
  };
  const create = useMutation(orpc.configs.create.mutationOptions({
    onSuccess: (r) => { invalidateLists(); void navigate({ to: "/configs/$id", params: { id: r.id }, replace: true }); },
  }));
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
      void qc.invalidateQueries({ queryKey: lookupsKey });
      toast(r.tables ? `Synced ${r.count} rows from ${r.tables} ${r.tables === 1 ? "query" : "queries"}` : "Nothing to sync");
    },
  }));

  // A client's request (spec §10): the company, the assignee, and the three decisions. Each one moves
  // the status, so the page, the inbox and the timeline all refetch rather than patch.
  const request = q.data?.request ?? null;
  const decided = (msg: string) => () => {
    void qc.invalidateQueries({ queryKey: getKey });
    void qc.invalidateQueries({ queryKey: orpc.requests.rows.key() });
    void qc.invalidateQueries({ queryKey: orpc.timeline.list.queryKey({ input: { projectId: id } }) });
    toast(msg);
  };
  const accept = useMutation(orpc.requests.accept.mutationOptions({ onSuccess: decided("Request accepted — it is yours to review") }));
  const sendBack = useMutation(orpc.requests.sendBack.mutationOptions({ onSuccess: decided("Sent back to the client for changes") }));
  const decline = useMutation(orpc.requests.decline.mutationOptions({ onSuccess: decided("Request declined") }));
  const deciding = accept.isPending || sendBack.isPending || decline.isPending;

  const project = q.data?.project;
  const model = q.data?.model;
  // What the General form shows and writes. A new configuration holds its fields here until name
  // and model are both set (create needs both, and the form below only means something against a
  // model); that creates it, and it opens at its own URL.
  const [fresh, setFresh] = useState<Head>({ name: "", modelId: "", customer: null });
  const head: Head = project ?? fresh;
  const saving = update.isPending || create.isPending;
  const save = (patch: Partial<Head>) => {
    if (!isNew) return update.mutate({ id, ...patch });
    const next = { ...fresh, ...patch };
    setFresh(next);
    if (next.name && next.modelId) create.mutate(next);
  };
  const { entries, batches, tables } = draft ?? {
    entries: project?.entries ?? {}, batches: project?.batches ?? [], tables: project?.tables ?? {},
  };
  // The server's lock (assertWritable fences update/calculate/select; remove refuses with the same
  // CONFLICT): a configuration is editable until quoted, a client's request only while it is in
  // review (spec §7). The page goes read-only rather than letting every edit walk into that error.
  const locked = request ? project?.status !== "in_review" : project?.status === "quoted";
  // Only the Model select reads the list; read-only, the payload's own model names itself.
  const models = useQuery({ ...orpc.configs.models.queryOptions(), enabled: isNew || (!!project && !locked && !request) });
  const candidates = project?.candidates ?? NONE;
  const selection = selOverride ?? project?.selection ?? NONE;
  // Candidates are emptied by the same write that changes their inputs, so holding any is proof
  // they match — there is no `calculated` status to consult.
  const runReady = candidates.length > 0;
  // Anything a model switch would throw away. Checked against the live values, not the persisted
  // ones, so the field locks on the first keystroke rather than a second later.
  const modelLocked =
    Object.keys(entries).length > 0 || Object.values(tables).some((rows) => rows.length > 0);
  // Memoized so a render that changes none of their inputs (a mutation's status, the footer's
  // animation) skips the engine — and so `money` below and the form's price badges stay cached.
  const lk = useMemo(() => (lookups.data ? mergeQueryPicks(lookups.data, picks) : undefined), [lookups.data, picks]);
  const prop = useMemo(
    () => (model && lk ? propagate(model.definition, lk, entries, tables) : null),
    [model, lk, entries, tables],
  );
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
  // candidate edit below. Without it one failing calculation retries every second forever. Only
  // on an error: a reset detaches a pending call (isPending goes false while it still runs), and
  // the effect would then send a second calculate to race it.
  const edit = (patch: Partial<Draft>) => {
    if (calc.isError) calc.reset();
    setDraft({ entries, batches, tables, ...patch });
  };
  // The configuration starts once General is complete. Nothing calculates before that, and an
  // input is only saved by a calculation — so the configurator waits rather than taking edits it
  // would lose. cardCode, not just a truthy customer: a half-filled one would otherwise reach the
  // B1 quotation seed. The quote needs more (`gaps` below); the calculation runs without it.
  const headReady = !!project?.name.trim() && !!project?.customer?.cardCode && batches.length > 0;
  // Calculate whenever the server lacks what the page shows: an unsaved edit, or no candidates yet
  // (a fresh configuration, or one whose model was just switched).
  const shouldCalc = headReady && !locked && !conflicted && !!lk && (draft !== null || !runReady);
  // One call in flight at a time, picks included: a calculate overtaking a pick would let the pick
  // land on the new candidate list, where its index names a different candidate.
  const calcBusy = update.isPending || calc.isPending || select.isPending;
  // Something the server does not hold yet — what a quote or a request decision has to wait for.
  const unsaved = draft !== null || selOverride !== null || calcBusy;

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

  // A read-only configuration has nothing to configure, so the rail starts collapsed and stays that way.
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

  // The configuration's own attributes. No draft state: each control commits on change (UI5 fires
  // that on blur/Enter) against the saved value, and `required` + a negative valueState on the empty
  // case is the Fiori way to say the same thing the footer does — once there is a model, so an
  // untouched new form is not an error yet. Display mode is Text, matching ConfiguratorForm —
  // accessibleMode only announces it.
  // A Panel like each ConfiguratorForm section, the Form inside it only laying out the fields.
  const general = (
    <Panel accessibleRole="Form" headerText="General" headerLevel="H5">
    <Form accessibleName="General" labelSpan="S12 M12 L12 XL12" layout="S1 M2 L4 XL4"
      accessibleMode={locked ? "Display" : "Edit"} itemSpacing={locked ? "Large" : "Normal"}>
      <FormGroup>
        <FormItem labelContent={<Label for={locked ? undefined : "cfg-name"} required>Name</Label>}>
          {locked ? <Text>{head.name}</Text> : (
          <Input id="cfg-name" value={head.name} style={{ width: "100%" }}
            disabled={saving}
            valueState={head.name.trim() || !head.modelId ? "None" : "Negative"}
            valueStateMessage={<div>Give the configuration a name — it is how it shows up in the list.</div>}
            onChange={(e) => {
              const v = (e.target.value ?? "").trim();
              if (v && v !== head.name) save({ name: v });
            }} />
          )}
        </FormItem>
        <FormItem labelContent={<Label required>Model</Label>}>
          {/* A request's model was the client's pick, and its customer is the company. */}
          {locked || request ? (
            <Text>{model?.name}</Text>
          ) : (
          /* Switching the model wipes every entry, batch and table row, because a param key
              only means something inside its own model. Rather than warn about that, the
              field simply stops being editable once there is anything to lose — which is
              also why configs.calculate does not bother returning the model definition. */
          <Select value={head.modelId} style={{ width: "100%" }}
            disabled={saving || modelLocked}
            onChange={(e) => {
              const v = e.detail.selectedOption.value ?? "";
              if (!v || v === head.modelId) return;
              // A model switch wipes entries/batches/tables server-side; drop the local
              // overlays too, or the old model's values are re-applied on top of the new form.
              setDraft(null); setSel(null); setPicks({});
              save({ modelId: v });
            }}>
            {/* A new configuration starts with none: picking one is the decision, not a default. */}
            {head.modelId ? null : <Option value="" />}
            {(models.data ?? []).map((m) => (
              <Option key={m.id} value={m.id}>{m.name}</Option>
            ))}
          </Select>
          )}
        </FormItem>
        <FormItem labelContent={<Label required>Customer</Label>}>
          {locked || request ? <Text>{head.customer?.cardName ?? ""}</Text> : (
          /* Wrapper, not a prop: the id is only a jump target for the message popover. */
          <div id="cfg-customer" style={{ width: "100%" }}>
          {/* Only a customer SAP knows is saved: the row select — a pick, or a typed code the
              existence check found — writes the pair. A keystroke writes nothing; clearing
              the field clears the customer. */}
          <CflField config={CUSTOMER} value={head.customer?.cardCode ?? null} link
            disabled={saving}
            error={head.customer?.cardCode || !head.modelId ? null : "Pick the customer the quote is written for — SAP needs a business partner on the document."}
            onValueChange={(v) => {
              if ((v === null || v === "") && head.customer) save({ customer: null });
            }}
            onRowSelect={(row) => save({
              customer: { cardCode: String(row.CardCode ?? ""), cardName: String(row.CardName ?? "") },
            })} />
          </div>
          )}
        </FormItem>
        {/* A new configuration takes its model's batch defaults on create. */}
        {isNew ? null : (
          <FormItem labelContent={<Label required>Batch quantities</Label>}>
            {locked ? <Text>{batches.join(", ")}</Text> : (
            /* Type a quantity, Enter (or leaving the field) makes it a token. Uncontrolled: the
               typed text is cleared by hand once it has become one. */
            <MultiInput type="Number" data-param={BATCHES} style={{ width: "100%" }}
              placeholder="Type a quantity, press Enter" accessibleName="Batch quantities"
              valueState={batches.length ? "None" : "Negative"}
              valueStateMessage={<div>Add at least one batch quantity.</div>}
              tokens={batches.map((b) => <Token key={b} text={String(b)} />)}
              onChange={(e) => {
                edit({ batches: addBatch(batches, e.target.value ?? "") });
                e.target.value = "";
              }}
              onTokenDelete={(e) => {
                const gone = new Set(e.detail.tokens.map((t) => Number((t as HTMLElement).getAttribute("text"))));
                const left = batches.filter((b) => !gone.has(b));
                // Deleting the last quantity falls back to 1 rather than leaving nothing to price.
                edit({ batches: left.length ? left : [1] });
              }} />
            )}
          </FormItem>
        )}
      </FormGroup>
    </Form>
    </Panel>
  );

  if (isNew) {
    return (
      <ObjectPage hidePinButton titleArea={<ObjectPageTitle header={<Title>New configuration</Title>} />}>
        <ObjectPageSection id="configure" titleText="Configure">
          {create.error ? <MessageStrip design="Negative" hideCloseButton>{create.error.message}</MessageStrip> : null}
          {general}
        </ObjectPageSection>
      </ObjectPage>
    );
  }
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  if (!project || !model) return null;
  const st = PROJECT_STATUS[project.status] ?? PROJECT_STATUS.draft;
  // A request's decisions by status (§7). They finalize, so they live in the footer (Fiori), next
  // to Create quote — never in the header toolbar.
  const canDecide = !!request && (project.status === "submitted" || project.status === "in_review");
  const decide = async (kind: "sendBack" | "decline") => {
    const note = await promptNote(kind === "sendBack"
      ? { title: "Send back for changes", actionText: "Send back", message: `${request!.cardName} can edit the request again and resubmit it. Say what should change — the client sees this note.` }
      : { title: "Decline request", actionText: "Decline", message: `This closes the request for good. ${request!.cardName} sees the decision and this note.` });
    if (note === null) return;
    (kind === "sendBack" ? sendBack : decline).mutate({ id, ...(note ? { note } : {}) });
  };
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

  // What the quote waits on beyond name and customer, in form order. buildQuoteSeed refuses on the
  // same missingInputs(), so a hidden button and a refused quote cannot disagree.
  const gaps = [
    ...(batches.length ? [] : [{ key: BATCHES, message: "Add at least one batch quantity" }]),
    ...(lk && prop ? missingInputs(model.definition, lk, prop, tables) : []),
  ];
  // The footer holds the finalizing action, so it exists only once there is something to finalize.
  // It stays while an edit recalculates: dropping it per keystroke would make it flicker.
  const ready = !locked && !!prop && headReady && gaps.length === 0;
  // Under Candidates the bar waits for a ticked line: there, picking is the step in progress, and
  // the bar is what finishes it.
  const showFooter = canDecide || (ready && (sectionParam.props.selectedSectionId !== "candidates" || selection.length > 0));
  if (showFooter && !footerUp) setFooterUp(true);
  // Several candidates: which to quote is the user's pick, made under Candidates. One leaves nothing
  // to pick, so Create quote picks every batch quantity of it on the way out. configs.quoteDraft
  // builds from the *saved* selection, hence `busy` while a pick or an edit is still saving.
  const mustPick = candidates.length > 1 && !project.selection?.length;
  const busy = !runReady || unsaved;
  const toQuote = () => void navigate({ to: "/configs/$id/quote", params: { id } });
  const finalize = () =>
    mustPick ? sectionParam.go("candidates")
    : project.selection?.length ? toQuote()
    : select.mutate(
        { projectId: id, selection: candidates[0]!.perBatch.map((b) => ({ candidateIdx: 0, batchQty: b.batchQty })) },
        { onSuccess: toQuote },
      );

  const footer = (
    // confire-footer-in/-out (global.css): the bar rises in when it mounts, i.e. when `showFooter`
    // turns true, and drops out when it turns false — unmounting only once that animation is done.
    <Bar design="FloatingFooter" className={showFooter ? "confire-footer-in" : "confire-footer-out"}
      onAnimationEnd={(e) => { if (e.animationName === "confire-footer-out") setFooterUp(false); }}
      startContent={
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {prop ? <ConsistencyStatus prop={prop} /> : null}
          {shouldCalc || calcBusy ? <BusyIndicator active delay={0} size="S" /> : null}
          {selection.length ? <Text>Selected: {formatMoney(selectedTotal, currency)}</Text> : null}
        </div>
      }
      endContent={
        <>
          {/* The finalizing action, and the only Emphasized one on the page — the Fiori rule. A
              request takes it once accepted (`ready` implies unlocked, i.e. in review); until then
              Accept is the positive semantic action. */}
          {ready ? (
            <Button design="Emphasized" disabled={conflicted || busy || deciding}
              tooltip={conflicted || calc.isError || select.isError ? "Resolve the issues in the messages first"
                : busy ? "Calculating…" : undefined}
              onClick={finalize}>
              {mustPick ? "Select candidate" : project.b1DocEntry !== null ? "Update quote" : "Create quote"}
            </Button>
          ) : null}
          {canDecide && project.status === "submitted" ? (
            <Button design="Positive" disabled={deciding} onClick={() => accept.mutate({ id })}>Accept</Button>
          ) : null}
          {/* Not while an edit is still saving: the decision locks the request, and the edit with it. */}
          {canDecide ? (
            <>
              <Button design="Default" disabled={deciding || unsaved} onClick={() => void decide("sendBack")}>Send back</Button>
              <Button design="Negative" disabled={deciding || unsaved} onClick={() => void decide("decline")}>Decline</Button>
            </>
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
    missing: gaps,
    candidates: candidates.length,
    unpriced: unpricedItems(candidates),
    capped: q.data.capped,
    widest: q.data.widest,
    lookupsError: lookups.error as Error | null,
    sync: lookups.data?.sync,
    syncError: sync.error as Error | null,
    configErrors: [update.error, calc.error, duplicate.error, remove.error, accept.error, sendBack.error, decline.error] as (Error | null)[],
    selectError: select.error as Error | null,
    locked: locked && { request: !!request, status: project.status, quoteResponse: project.quoteResponse },
  });

  return (
    <ObjectPage
      mode="IconTabBar"
      hidePinButton
      {...sectionParam.props}
      titleArea={
        <ObjectPageTitle
          header={<Title>{project.name.trim() || "New configuration"}</Title>}
          subHeader={request ? (
            <Text>{`${request.cardName} · ${request.assigneeName ? `Assigned to ${request.assigneeName}` : "Not accepted yet"}`}</Text>
          ) : project.customer?.cardName ? <Text>{project.customer.cardName}</Text> : undefined}
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
                  tooltip={locked ? "Read-only — there is nothing left to configure"
                    : railShown ? "Hide insights" : "Show insights"}
                  onClick={() => setRailOpen((o) => !o)} />
              </ToolbarItem>
              <ToolbarButton icon="synchronize" design="Transparent" disabled={sync.isPending}
                tooltip="Refresh the SAP data this model reads"
                onClick={() => sync.mutate({ id })} />
              {project.b1DocEntry !== null && isAdmin ? (
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
              {/* A client's request is declined, never deleted (the server refuses it too). */}
              {request ? null : <ToolbarButton icon="delete" design="Transparent" disabled={locked || remove.isPending}
                tooltip={locked ? "A quoted configuration cannot be deleted" : "Delete configuration"}
                text="Delete"
                onClick={async () => {
                  if (await confirm({
                    title: "Delete configuration",
                    // Same fallback as the title: a configuration is created unnamed.
                    message: `Delete "${project.name.trim() || "New configuration"}"? This can't be undone.`,
                    actionText: "Delete", destructive: true,
                  })) remove.mutate({ ids: [id] });
                }} />}
            </Toolbar>
          }>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>
            {st.text}
          </Tag>
          {/* The client's answer to the quotation (D20). A decline reopens the request in review. */}
          {request && project.quoteResponse ? (
            <Tag design={project.quoteResponse === "accepted" ? "Positive" : "Critical"} style={{ alignSelf: "center" }}>
              {project.quoteResponse === "accepted" ? "Accepted by client" : "Declined by client"}
            </Tag>
          ) : null}
        </ObjectPageTitle>
      }
      footerArea={footerUp ? footer : undefined}
    >
      <ObjectPageSection id="configure" titleText="Configure" fitContent>
        <DynamicSideContent style={{ flex: 1, minHeight: 0 }} sideContentVisibility="AlwaysShow"
          hideSideContent={!railShown} accessibilityAttributes={{ sideContent: { ariaLabel: "Insights" } }}
          sideContent={
            // No padding on top: the rail's first panel lines up with the General panel.
            // The form column has none, and both are Panel headers.
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", paddingInline: "0.5rem", paddingBlockEnd: "0.5rem" }}>
              {/* The total rides in headerText rather than a `header` slot: a custom header is only
                  toggled by its arrow, this one by the whole bar — and the figure survives collapsing. */}
              <Panel accessibleRole="Form" headerLevel="H5"
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
              {/* No mappings means the History tab was never filled in — an empty "not set up"
                  panel is just noise in the rail. Copy is an edit, so it waits for General too. */}
              {headReady && model.definition.history?.mappings.length ? (
                <Panel accessibleRole="Form" headerLevel="H5" headerText="Similar configurations" collapsed>
                  <div style={PANEL_BODY}>
                    <SimilarConfigs projectId={id} model={model.definition} entries={entries} onCopy={copyValues} />
                  </div>
                </Panel>
              ) : null}
            </div>
          }>
          {/* The main pane scrolls itself. The section's inline padding sits outside that
              pane, so without this the form meets the scrollbar. */}
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", paddingBlockEnd: "1rem", paddingInlineEnd: "0.5rem" }}>
            {general}
            {/* Read-only has no edit to lose, so a locked page shows its configuration regardless. */}
            {!headReady && !locked ? (
              <IllustratedMessage name="NoData" design="Small" titleText="Complete General first"
                subtitleText="The configurator opens once the configuration has a name, a customer and a batch quantity." />
            ) : lookups.data && lk && prop ? (
              <ConfiguratorForm model={model.definition} lookups={lookups.data} lk={lk} prop={prop}
                entries={entries} readOnly={locked} querySource={{ modelId: project.modelId }}
                onChange={(next) => edit({ entries: next })}
                onQueryPick={(k, t, sel) => setPicks((p) => setQueryPick(p, k, t, sel))}
                tables={tables} onTablesChange={(next) => edit({ tables: next })} itemMoney={money}
                batches={batches} itemBatch={itemQty} onItemBatchChange={setViewQty} />
            ) : lookups.error ? (
              /* Why the options are missing is a page message; the retry it needs is not something
                 a message can carry, so the button stays here. */
              <Button icon="refresh" onClick={() => void lookups.refetch()}>Retry loading options</Button>
            ) : <BusyIndicator active delay={0} />}
          </div>
        </DynamicSideContent>
      </ObjectPageSection>
      {/* The count rides in the tab, like the model builder's issue counts — the Fiori anchor-bar
          counter. The real one, not prop.candidateEstimate: by the time it shows, it has calculated. */}
      <ObjectPageSection id="candidates" titleText={runReady ? `Candidates (${candidates.length})` : "Candidates"}>
        {/* capped/widest are not passed: this page reports them in its message popover. No lookups
            needed either — the prices are the calculation's own, so they render with the agent off.
            A pending edit is about to replace these candidates, so they stop taking picks. */}
        {candidates.length > 0 ? (
          <PriceAnalysis model={model.definition} entries={project.entries}
            candidates={candidates.map(toPriced)} selection={selection}
            onSelect={(s) => { if (select.isError) select.reset(); setSel(s); }}
            disabled={locked || draft !== null} />
        ) : (
          <IllustratedMessage name="NoData" design="Medium" titleText="No candidates yet"
            subtitleText="They appear here once the configuration is complete and has calculated." />
        )}
      </ObjectPageSection>
      {/* ObjectPage's children are sections or booleans — not null. */}
      {!!request && (
        <ObjectPageSection id="timeline" titleText="Timeline">
          <RequestTimeline id={id} />
        </ObjectPageSection>
      )}
    </ObjectPage>
  );
}

/** A client's request's history: events and comments from Postgres, and the SAP document chain.
 *  Its own component so its fetches re-render this tab, not the whole configurator. */
function RequestTimeline({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const currency = useCurrency();
  const isAdmin = useIsAdmin();
  const listKey = orpc.timeline.list.queryKey({ input: { projectId: id } });
  const timeline = useQuery(orpc.timeline.list.queryOptions({ input: { projectId: id } }));
  // Live SAP, so it may fail on its own without taking the events with it.
  const documents = useQuery({ ...orpc.timeline.documents.queryOptions({ input: { projectId: id } }), retry: false });
  const comment = useMutation(orpc.timeline.comment.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey }),
  }));
  return (
    <ProjectTimeline side="internal" currency={currency} canComment
      events={timeline.data?.events} labels={timeline.data?.labels ?? {}}
      loading={timeline.isPending} error={timeline.error as Error | null}
      documents={documents.data} documentsError={documents.error as Error | null}
      onComment={(note, internalOnly) => comment.mutateAsync({ projectId: id, note, internalOnly })}
      onOpenDocument={isAdmin
        ? (entity, key) => void navigate({ to: "/b1/$entity/$key", params: { entity, key: String(key) } })
        : undefined} />
  );
}

