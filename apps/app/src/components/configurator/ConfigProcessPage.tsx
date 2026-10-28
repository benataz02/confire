import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BusyIndicator, Button, IllustratedMessage, ListItemStandard, MessageStrip,
  Link, ObjectPage, ObjectPageSection, ObjectPageTitle, Panel, Popover, ResponsivePopover, SelectDialog, Tag, Text, Title,
  ToggleButton, Toolbar,
  ToolbarButton, ToolbarItem,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { historyKey, itemsTableOf, type Val } from "@confire/config-engine";
import { orpc, useCurrency } from "../../orpc.ts";
import { money as formatMoney } from "@confire/ui/money.ts";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { ProjectTimeline } from "@confire/ui/timeline/ProjectTimeline.tsx";
import { FILE_MAX_MB, uploadFile } from "@confire/ui/files.ts";
import { toast } from "@confire/ui/toast.ts";
import { configuratorSections } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { GENERAL_SECTION } from "@confire/ui/configurator/formHelpers.ts";
import { useI18n } from "../../i18n.ts";
import { projectStatusText } from "./runView.ts";
import { PriceAnalysis } from "./PriceAnalysis.tsx";
import { CostBody, OptionPrices } from "./InsightsRail.tsx";
import { SimilarConfigs } from "./SimilarConfigs.tsx";
import { configMessages } from "./configMessages.ts";
import { GeneralForm } from "./GeneralForm.tsx";
import { ProcessFooter } from "./ProcessFooter.tsx";
import { useConfigProcess } from "./useConfigProcess.ts";
import { PageMessages } from "../PageMessages.tsx";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { useAssistantShell } from "../../assistant/AssistantProvider.tsx";
import { fieldMarks, sourceTip, type Sources } from "../../assistant/marks.ts";
import type { Source } from "../../assistant/cards/registry.tsx";

type Head = { name: string; modelId: string; customer: { cardCode: string; cardName: string } | null };

// The General fields the configurator waits for: the form shows once none is missing.
const GENERAL = new Set(["name_required", "customer_required", "batches_required"]);

// One scrolling page — General, the model's sections, Similar configurations, Candidates and a
// request's Timeline — with the cost rail beside every section, and one finalizing action in the
// footer once everything the quote needs is filled. The server computes everything on the page
// (configs.get's view); this draws it, sends what the user changed, and waits for the answer.
// `new` (/configs/new) is the General form alone: there is no id yet, and nothing that reads one
// runs before the configuration exists.
export function ConfigProcessPage({ id = "", new: isNew = false }: { id?: string; new?: boolean }) {
  const i18n = useI18n();
  // getText reads `this`; a bare pass into the pure helpers would lose it.
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const currency = useCurrency();
  // The ObjectPage's root: the scroller the rail sticks in, and what a section jump scrolls.
  const [page, setPage] = useState<HTMLElement | null>(null);
  const proc = useConfigProcess(id, isNew, {
    left: (to, msg) => {
      if (msg) toast(t(msg));
      void (to === "list"
        ? navigate({ to: "/$slug/configs" })
        : navigate({ to: "/$slug/configs/$id", params: { id: to.id }, replace: isNew }));
    },
  });
  const { q, view, project, form, selection, queue } = proc;
  const getKey = orpc.configs.get.queryKey({ input: { id } });

  // The batch quantity the items grid and the rail are priced at. Read through `batches` below, so
  // a deleted quantity falls back to the first rather than pricing at one that no longer exists.
  const [viewQty, setViewQty] = useState<number | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  // Whether the footer is mounted. It outlives `showFooter` by its out animation, which is what
  // clears this; `showFooter` turning true sets it straight away (below).
  const [footerUp, setFooterUp] = useState(false);

  // A client's request (spec §10): the company, the assignee, and the three decisions. Each one moves
  // the status, so the page, the inbox and the timeline all refetch rather than patch.
  const request = view?.request ?? null;
  const decided = (msg: string) => () => {
    void qc.invalidateQueries({ queryKey: getKey });
    void qc.invalidateQueries({ queryKey: orpc.requests.rows.key() });
    void qc.invalidateQueries({ queryKey: orpc.timeline.list.queryKey({ input: { projectId: id } }) });
    toast(msg);
  };
  const accept = useMutation(orpc.requests.accept.mutationOptions({ onSuccess: decided(t("CONFIG_TOAST_ACCEPTED")) }));
  const sendBack = useMutation(orpc.requests.sendBack.mutationOptions({ onSuccess: decided(t("CONFIG_TOAST_SENT_BACK")) }));
  const decline = useMutation(orpc.requests.decline.mutationOptions({ onSuccess: decided(t("CONFIG_TOAST_DECLINED")) }));
  const deciding = accept.isPending || sendBack.isPending || decline.isPending;
  // Reassign (notifications spec §6): any colleague, from a picker of the workspace's staff. The answer
  // names the new assignee, so the header is patched rather than refetched.
  const [reassigning, setReassigning] = useState(false);
  const [staffSearch, setStaffSearch] = useState("");
  const assignable = useQuery({ ...orpc.requests.assignable.queryOptions(), enabled: reassigning });
  const reassign = useMutation(orpc.requests.assign.mutationOptions({
    onSuccess: (r) => {
      qc.setQueryData(getKey, (cur) => (cur?.request
        ? { ...cur, project: { ...cur.project, assigneeId: r.assigneeId }, request: { ...cur.request, assigneeName: r.assigneeName } }
        : cur));
      void qc.invalidateQueries({ queryKey: orpc.requests.rows.key() });
      void qc.invalidateQueries({ queryKey: orpc.timeline.list.queryKey({ input: { projectId: id } }) });
      toast(t("CONFIG_TOAST_REASSIGNED", r.assigneeName));
    },
  }));
  // The header's Attach: the timeline's upload, for the client to see — the internal-only toggle
  // stays on the timeline's own composer. The size check is here because the server's refusal of an
  // oversized body may reach the browser as a reset connection rather than its message.
  const fileInput = useRef<HTMLInputElement>(null);
  const attach = useMutation({
    mutationFn: (file: File) => file.size > FILE_MAX_MB * 1024 * 1024
      ? Promise.reject(new Error(t("CONFIG_FILE_MAX", String(FILE_MAX_MB))))
      : uploadFile(id, file),
    onSuccess: (_, file) => {
      void qc.invalidateQueries({ queryKey: orpc.timeline.list.queryKey({ input: { projectId: id } }) });
      toast(t("CONFIG_TOAST_ATTACHED", file.name));
    },
  });

  const model = view?.model;
  // A DocEntry means something only in the SAP company it was posted in: elsewhere there is no
  // quotation to open, and quoting creates one (the server decides the same way).
  const quotationHere = !!project && project.b1DocEntry !== null && project.b1Company === view?.sapCompany;
  // What the General form shows and writes. A new configuration holds its fields here until name
  // and model are both set (create needs both); that creates it, and it opens at its own URL.
  const [fresh, setFresh] = useState<Head>({ name: "", modelId: "", customer: null });
  const head: Head = project ?? fresh;
  const save = (patch: Partial<Pick<Head, "name" | "customer">>) => {
    if (!isNew) return proc.commit(patch);
    const next = { ...fresh, ...patch };
    setFresh(next);
    if (next.name && next.modelId) proc.create.mutate(next);
  };
  const switchModel = (modelId: string) => {
    if (!isNew) return proc.update.mutate({ id, modelId });
    const next = { ...fresh, modelId };
    setFresh(next);
    if (next.name) proc.create.mutate(next);
  };
  const batches = project?.batches ?? [];
  const tables = project?.tables ?? {};
  const entries = project?.entries ?? {};
  // The server's lock (assertWritable fences every write): a configuration is editable until quoted,
  // a client's request only while it is in review (spec §7). The page goes read-only rather than
  // letting every edit walk into that error.
  const locked = request ? project?.status !== "in_review" : project?.status === "quoted";
  // Anything a model switch would throw away, the pending edit included, so the field locks on the
  // first change rather than when its answer lands.
  const modelLocked = Object.keys(entries).length > 0 || Object.values(tables).some((rows) => rows.length > 0) || queue.busy;
  // Only the Model select reads the list; once it is read-only, the payload's own model names itself.
  const models = useQuery({
    ...orpc.configs.models.queryOptions(),
    enabled: !modelLocked && (isNew || (!!project && !locked && !request)),
  });
  // The assistant (spec §4.1): the page tells the panel when an edit is still on its way, and draws
  // which values the assistant wrote and which wait on a question in the panel.
  const assistant = useAssistantShell();
  const { setDirty } = assistant;
  useEffect(() => { setDirty(queue.busy); return () => setDirty(false); }, [queue.busy, setDirty]);
  const [markOpen, setMarkOpen] = useState<{ key: string; opener: HTMLElement } | null>(null);
  const [noticeOpener, setNoticeOpener] = useState<HTMLElement | null>(null);

  const general = (
    <GeneralForm locked={locked} request={!!request} head={head}
      batches={isNew ? undefined : batches}
      modelName={model?.name} models={models.data ?? []}
      saving={proc.update.isPending || proc.create.isPending} modelLocked={modelLocked}
      onSave={save} onModel={switchModel} onBatches={(next) => proc.commit({ batches: next })} />
  );

  if (isNew) {
    return (
      <ObjectPage titleArea={
        <ObjectPageTitle header={<Title>{t("CONFIG_NEW")}</Title>}
          breadcrumbs={<PageBreadcrumbs items={[{ text: t("NAV_CONFIGS"), to: "/configs" }]} current={t("CONFIG_NEW")} />} />
      }>
        <ObjectPageSection id={GENERAL_SECTION} titleText={t("CONFIG_GENERAL")}>
          {proc.create.error ? <MessageStrip design="Negative" hideCloseButton>{proc.create.error.message}</MessageStrip> : null}
          {general}
        </ObjectPageSection>
      </ObjectPage>
    );
  }
  if (q.isPending) return <ObjectPageSkeleton />;
  if (q.error) return <PageError error={q.error} />;
  if (!view || !project || !model || !form) return null;

  const sources = (view.project.sources ?? {}) as Sources;
  const marks = fieldMarks(entries as Record<string, unknown>, sources, assistant.questionKeys[id] ?? [], (s) => sourceTip(s, (k, ...a) => t(k, ...a.map(String))));
  const anyRead = Object.values(marks).some((m) => m.kind === "assistant");
  const pressMark = (key: string, opener: HTMLElement) => {
    if (marks[key]?.kind === "question") { if (!assistant.open) assistant.toggle(); return; }
    setMarkOpen({ key, opener });
  };
  const marked = markOpen ? sources[markOpen.key] : undefined;
  const markSource = marked?.source as Source | undefined;

  const st = PROJECT_STATUS[project.status] ?? PROJECT_STATUS.draft;
  const candidates = view.candidates;
  // The configurator waits for General: the server lists what it still needs.
  const headReady = !view.missing.some((m) => GENERAL.has(m.code));
  // Nothing missing, and not locked. The quote itself waits for a current calculation (below).
  const ready = !locked && view.missing.length === 0;
  // A request's decisions by status (§7). They finalize, so they live in the footer (Fiori), next
  // to Create quote — never in the header toolbar.
  const canDecide = !!request && (project.status === "submitted" || project.status === "in_review");
  const decide = async (kind: "sendBack" | "decline") => {
    const note = await promptNote(kind === "sendBack"
      ? { title: t("CONFIG_SEND_BACK_TITLE"), actionText: t("CONFIG_SEND_BACK"), message: t("CONFIG_SEND_BACK_MESSAGE", request!.cardName) }
      : { title: t("CONFIG_DECLINE_TITLE"), actionText: t("CONFIG_DECLINE"), message: t("CONFIG_DECLINE_MESSAGE", request!.cardName) });
    if (note === null) return;
    (kind === "sendBack" ? sendBack : decline).mutate({ id, ...(note ? { note } : {}) });
  };
  // The items grid and the rail price one batch quantity at a time — every quantity is in the view.
  const itemsDef = itemsTableOf(model.definition);
  const itemQty = batches.find((b) => b === viewQty) ?? batches[0];
  const cost = view.costs.find((c) => c.batchQty === itemQty) ?? view.costs[0];
  const itemRows: Record<string, Val>[] = itemsDef ? form.tables[itemsDef.key] ?? [] : [];

  // Which row to quote is chosen in the Candidates section. A single candidate leaves nothing to
  // pick, so Create quote selects every batch quantity of it on the way out. The bar stays down
  // until that quote can actually be created — messages already say why it can't — then slides in.
  // An edit in flight does not drop it: the button waits, the bar does not bounce.
  const needsPick = candidates.rows.length > 1 && !view.selection.picks.length;
  const quoting = ready && view.calculation.state === "current" && candidates.rows.length > 0 && !needsPick && !queue.error;
  const showFooter = canDecide || quoting;
  if (showFooter && !footerUp) setFooterUp(true);
  // Focus first: focus entering the content is what sets the ObjectPage's scroll padding (the sticky
  // title and anchor bar), so the section lands below them rather than under.
  const goSection = (section: string) => {
    const el = page?.querySelector<HTMLElement>(`[id="ObjectPageSection-${section}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "start" });
  };
  const toQuote = () => void navigate({ to: "/$slug/configs/$id/quote", params: { id } });
  const finalize = () =>
    view.selection.picks.length ? toQuote()
    : proc.pickNow.mutate(
        { projectId: id, selection: candidates.rows[0]!.perBatch.map((b) => ({ candidateIdx: 0, batchQty: b.batchQty })) },
        { onSuccess: toQuote },
      );

  // Fills only empty params, never a read-only one, and an items-grid column (`<table>.<column>`)
  // in the grid row the past row matched (the first, or a new one, when none did); the server takes
  // it from there. Nothing to fill is not an edit.
  const copyValues = (values: Record<string, Val>, item: number | null) => {
    const empty = (v: unknown) => v === undefined || v === null || v === "";
    const set: Record<string, Val> = {};
    const rows = itemsDef ? tables[itemsDef.key] ?? [] : [];
    // A row deleted since the answer came back: the first, as before there was an index.
    const at = item !== null && item < rows.length ? item : 0;
    const row = { ...rows[at] };
    let cells = 0;
    for (const m of model.definition.history?.mappings ?? []) {
      const v = values[historyKey(m)];
      if (v === null || v === undefined) continue;
      if (m.table) {
        if (m.table === itemsDef?.key && empty(row[m.param])) { row[m.param] = v; cells++; }
      } else if (empty(entries[m.param]) && model.definition.parameters.some((p) => p.key === m.param && !p.readonly)) set[m.param] = v;
    }
    const n = Object.keys(set).length + cells;
    if (n) proc.commit({ set, ...(cells ? { tables: { [itemsDef!.key]: rows.length ? rows.with(at, row) : [row] } } : {}) });
    toast(n === 0 ? t("CONFIG_TOAST_FILLED_NONE") : n === 1 ? t("CONFIG_TOAST_FILLED_ONE") : t("CONFIG_TOAST_FILLED_MANY", String(n)));
  };

  // A read-only configuration has nothing to configure, so the rail starts collapsed and stays that way.
  const railShown = railOpen && !locked;

  // No ObjectPageHeader and no message strips: everything the page has to say is one list behind
  // the title's MessageViewButton, grouped by the section it belongs to.
  const messages = configMessages({
    t, model: model.definition,
    missing: view.missing, issues: view.issues, form, calculation: view.calculation,
    lookupsError: proc.lookups.error as Error | null,
    syncError: proc.sync.error as Error | null,
    writeError: queue.error,
    configErrors: [proc.update.error, proc.pickNow.error, proc.duplicate.error, proc.remove.error, accept.error, sendBack.error, decline.error, reassign.error, attach.error] as (Error | null)[],
    locked: locked && { request: !!request, status: project.status, quoteResponse: project.quoteResponse },
  });

  // Beside every section, sticky under the title and anchor bar. ObjectPage has no slot for side
  // content (each child becomes an anchor), so the rail is portaled into its content area and
  // global.css reserves a quarter of that area for it. The content's offset is where the sticky bars
  // end. While an edit is out the figures are the last answer's: dimmed, not hidden.
  // ponytail: no fall-down below the sections on a narrow screen; the toggle hides the rail.
  const content = page?.querySelector<HTMLElement>('[data-component-name="ObjectPageContent"]');
  const rail = railShown && page && content ? createPortal(
    <aside className="confire-rail" aria-label={t("CONFIG_INSIGHTS")}>
    <div style={{ top: content.offsetTop, maxHeight: `calc(${page.clientHeight - content.offsetTop}px - ${footerUp ? "4.5rem" : "1rem"})` }}>
      {/* The total rides in headerText rather than a `header` slot: a custom header is only
          toggled by its arrow, this one by the whole bar — and the figure survives collapsing.
          Region, not the default Form: read-only figures, nothing to fill in. */}
      <Panel accessibleRole="Region" headerLevel="H5" style={queue.busy ? { opacity: 0.6 } : undefined}
        headerText={cost ? t("CONFIG_COST_ELEMENTS_TOTAL", formatMoney(cost.cost, currency)) : t("CONFIG_COST_ELEMENTS")}>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0 0.25rem 0.5rem" }}>
          {cost ? (
            <CostBody rows={itemRows} cost={cost} cur={currency} />
          ) : (
            <IllustratedMessage name="NoData" design="ExtraSmall" titleText={t("CONFIG_NO_COSTS")}
              subtitleText={t("CONFIG_NO_COSTS_SUB")} />
          )}
          {view.optionPrices.rows.length ? <OptionPrices rows={view.optionPrices.rows} total={view.optionPrices.total} cur={currency} /> : null}
        </div>
      </Panel>
    </div>
    </aside>,
    content,
  ) : null;

  // Read-only has no edit to lose, so a locked page shows its configuration regardless.
  const configurable = (headReady || locked) && !!proc.lookups.data;
  const generalSection = (
    <ObjectPageSection key={GENERAL_SECTION} id={GENERAL_SECTION} titleText={t("CONFIG_GENERAL")}>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {/* The local AI notice, interactive (Fiori: a quotation is high-stakes): once, while
            any value the assistant read is still on the page. */}
        {anyRead ? (
          <Link design="Subtle" accessibilityAttributes={{ hasPopup: "dialog" }}
            onClick={(e) => setNoticeOpener(e.currentTarget as HTMLElement)}>{t("ASSISTANT_NOTICE")}</Link>
        ) : null}
        {general}
        {configurable ? null : !headReady && !locked ? (
          <IllustratedMessage name="NoData" design="Small" titleText={t("CONFIG_COMPLETE_GENERAL")}
            subtitleText={t("CONFIG_COMPLETE_GENERAL_SUB")} />
        ) : proc.lookups.error ? (
          /* Why the options are missing is a page message; the retry it needs is not something
             a message can carry, so the button stays here. */
          <Button icon="refresh" style={{ alignSelf: "start" }} onClick={() => void proc.lookups.refetch()}>{t("CONFIG_RETRY_OPTIONS")}</Button>
        ) : <BusyIndicator active delay={0} />}
      </div>
    </ObjectPageSection>
  );

  const footer = (
    <ProcessFooter shown={showFooter} onGone={() => setFooterUp(false)}
      quote={quoting ? {
        text: quotationHere ? t("CONFIG_UPDATE_QUOTE") : t("CONFIG_CREATE_QUOTE"),
        pending: queue.busy || proc.pickNow.isPending || deciding,
        onClick: finalize,
      } : null}
      decide={canDecide ? {
        canAccept: project.status === "submitted", disabled: deciding, unsaved: queue.busy,
        onAccept: () => accept.mutate({ id }), onSendBack: () => void decide("sendBack"), onDecline: () => void decide("decline"),
      } : null} />
  );

  return (
    <>
    <ObjectPage
      ref={setPage}
      titleArea={
        <ObjectPageTitle
          breadcrumbs={<PageBreadcrumbs items={[request
            ? { text: t("NAV_REQUESTS"), to: "/requests" }
            : { text: t("NAV_CONFIGS"), to: "/configs" }]} current={project.name.trim() || t("CONFIG_NEW")} />}
          header={<Title>{project.name.trim() || t("CONFIG_NEW")}</Title>}
          subHeader={request ? (
            <Text>{t("CONFIG_REQUEST_SUB", request.cardName, request.assigneeName ? t("CONFIG_ASSIGNED", request.assigneeName) : t("CONFIG_NOT_ACCEPTED"))}</Text>
          ) : project.customer?.cardName ? <Text>{project.customer.cardName}</Text> : undefined}
          navigationBar={
            <Toolbar design="Transparent">
              {/* A Toolbar only measures — and overflows — its own item types: the two plain
                  controls are wrapped, everything else is a ToolbarButton. */}
              <ToolbarItem overflowPriority="NeverOverflow">
                <PageMessages messages={messages} okText={t("CONFIG_OK")}
                  onSection={goSection} />
              </ToolbarItem>
              {/* An edit that never reached the server is kept; this sends it again. */}
              {queue.error && !queue.error.refused ? (
                <ToolbarButton icon="refresh" design="Transparent" text={t("CONFIG_RETRY")} onClick={queue.retry} />
              ) : null}
              {/* A toggle, so the pressed state is announced — Fiori's trigger for side content. */}
              <ToolbarItem overflowPriority="NeverOverflow">
                <ToggleButton design="Transparent" disabled={locked} pressed={railShown}
                  icon={railShown ? "close-command-field" : "open-command-field"}
                  tooltip={locked ? t("CONFIG_READONLY_RAIL")
                    : railShown ? t("CONFIG_HIDE_INSIGHTS") : t("CONFIG_SHOW_INSIGHTS")}
                  onClick={() => setRailOpen((o) => !o)} />
              </ToolbarItem>
              <ToolbarButton icon="synchronize" design="Transparent" disabled={proc.sync.isPending}
                tooltip={t("CONFIG_REFRESH_SAP")}
                onClick={() => proc.sync.mutate({ id }, {
                  onSuccess: (r) => toast(!r.tables ? t("CONFIG_TOAST_SYNC_NONE")
                    : r.tables === 1 ? t("CONFIG_TOAST_SYNCED_ONE", String(r.count))
                    : t("CONFIG_TOAST_SYNCED_MANY", String(r.count), String(r.tables))),
                })} />
              {quotationHere ? (
                <ToolbarButton icon="document-text" design="Transparent" text={t("CONFIG_OPEN_QUOTE")}
                  onClick={() => navigate({
                    to: "/$slug/b1/$entity/$key",
                    params: { entity: "Quotations", key: String(project.b1DocEntry) },
                  })} />
              ) : null}
            </Toolbar>
          }
          actionsBar={
            <Toolbar design="Transparent">
              {request ? (
                <ToolbarButton icon="employee" design="Transparent" disabled={reassign.isPending}
                  text={t("CONFIG_REASSIGN")} accessibilityAttributes={{ hasPopup: "dialog" }}
                  onClick={() => setReassigning(true)} />
              ) : null}
              {request ? (
                <ToolbarButton icon="attachment" design="Transparent" disabled={attach.isPending}
                  text={t("CONFIG_ATTACH")} onClick={() => fileInput.current?.click()} />
              ) : null}
              <ToolbarButton icon="copy" design="Transparent" disabled={queue.busy || proc.duplicate.isPending}
                tooltip={queue.busy ? t("CONFIG_CALCULATING") : t("CONFIG_DUPLICATE_TIP")}
                text={proc.duplicate.isPending ? t("CONFIG_DUPLICATING") : t("CONFIG_DUPLICATE")}
                onClick={() => proc.duplicate.mutate({ id })} />
              {/* A client's request is declined, never deleted (the server refuses it too). */}
              {request ? null : <ToolbarButton icon="delete" design="Transparent" disabled={locked || proc.remove.isPending}
                tooltip={locked ? t("CONFIG_DELETE_LOCKED") : t("CONFIG_DELETE_TIP")}
                text={t("CONFIG_DELETE")}
                onClick={async () => {
                  if (await confirm({
                    title: t("CONFIG_DELETE_TITLE"),
                    // Same fallback as the title: a configuration may predate required names.
                    message: t("CONFIG_DELETE_ONE", project.name.trim() || t("CONFIG_NEW")),
                    actionText: t("CONFIG_DELETE"), destructive: true,
                  })) proc.remove.mutate({ ids: [id] });
                }} />}
            </Toolbar>
          }>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>
            {projectStatusText(t, project.status)}
          </Tag>
          {/* The client's answer to the quotation (D20). A decline reopens the request in review. */}
          {request && project.quoteResponse ? (
            <Tag design={project.quoteResponse === "accepted" ? "Positive" : "Critical"} style={{ alignSelf: "center" }}>
              {project.quoteResponse === "accepted" ? t("CONFIG_ACCEPTED_CLIENT") : t("CONFIG_DECLINED_CLIENT")}
            </Tag>
          ) : null}
        </ObjectPageTitle>
      }
      footerArea={footerUp ? footer : undefined}
    >
      {/* One flat array: ObjectPage reads sections (or booleans) off its children, one level deep. */}
      {[
        generalSection,
        ...(configurable ? configuratorSections({
          model: model.definition, form, tables: proc.lookups.data!.tables,
          marks, onMarkPress: pressMark,
          rows: tables, readOnly: locked, querySource: { modelId: project.modelId }, formulaOverride: true,
          onChange: (key, v) => proc.commit(v === undefined ? { unset: [key] } : { set: { [key]: v } }),
          onRowsChange: (key, rows) => proc.commit({ tables: { [key]: rows } }),
          itemMoney: cost && itemQty !== undefined ? { batchQty: cost.batchQty, rows: cost.items } : null,
          batches, itemBatch: itemQty, onItemBatchChange: setViewQty,
        }) : []),
        // No mappings means the History tab was never filled in — an empty "not set up" section is
        // just noise. Copy is an edit, so it waits for General and is gone once the page is locked.
        headReady && !locked && !!model.definition.history?.mappings.length && (
          <ObjectPageSection key="similar" id="similar" titleText={t("CONFIG_SIMILAR")}>
            <SimilarConfigs projectId={id} model={model.definition} entries={entries} tables={tables} onCopy={copyValues} />
          </ObjectPageSection>
        ),
        // The count rides in the anchor, like the model builder's issue counts — the Fiori
        // anchor-bar counter.
        <ObjectPageSection key="candidates" id="candidates" titleText={candidates.rows.length ? t("CONFIG_CANDIDATES_COUNT", String(candidates.rows.length)) : t("CONFIG_SECTION_CANDIDATES")}>
          {/* The prices are the calculation's own, so they render with the agent off. A pending edit
              is about to replace these candidates, so they stop taking picks. */}
          {candidates.rows.length > 0 ? (
            <PriceAnalysis model={model.definition} candidates={candidates} selection={selection}
              onSelect={proc.pick} disabled={locked || queue.editing} />
          ) : (
            <IllustratedMessage name="NoData" design="Medium" titleText={t("CONFIG_NO_CANDIDATES")}
              subtitleText={t("CONFIG_NO_CANDIDATES_SUB")} />
          )}
        </ObjectPageSection>,
        !!request && (
          <ObjectPageSection key="timeline" id="timeline" titleText={t("CONFIG_SECTION_TIMELINE")}>
            <RequestTimeline id={id} />
          </ObjectPageSection>
        ),
      ]}
    </ObjectPage>
    {rail}
    <ResponsivePopover open={!!markOpen && !!markSource} opener={markOpen?.opener} headerText={t("ASSISTANT_MARK_TITLE")}
      onClose={() => setMarkOpen(null)}>
      {markSource ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: "22rem" }}>
          <Text style={{ color: "var(--sapContent_LabelColor)" }}>
            {"chat" in markSource ? t("ASSISTANT_MARK_CHAT")
              : markSource.page === null ? markSource.file : t("ASSISTANT_MARK_PAGE", markSource.file, String(markSource.page))}
          </Text>
          <Text style={{ fontStyle: "italic" }}>“{"chat" in markSource ? markSource.chat : markSource.quote}”</Text>
          {"quote" in markSource && String(marked!.value) !== markSource.quote.trim()
            ? <Text>{t("ASSISTANT_MARK_READ", Array.isArray(marked!.value) ? marked!.value.join(", ") : String(marked!.value))}</Text> : null}
        </div>
      ) : null}
    </ResponsivePopover>
    <Popover open={!!noticeOpener} opener={noticeOpener ?? undefined} onClose={() => setNoticeOpener(null)}>
      <Text style={{ maxWidth: "22rem", display: "block" }}>{t("ASSISTANT_NOTICE_LONG")}</Text>
    </Popover>
    {request ? (
      <SelectDialog open={reassigning} headerText={t("CONFIG_REASSIGN_TITLE")} searchPlaceholder={t("CONFIG_REASSIGN_SEARCH")}
        // The dialog closes itself on confirm and cancel, fires onClose after either, and resets its
        // search on close (onSearchReset).
        onSearchInput={(e) => setStaffSearch(e.detail.value)} onSearchReset={() => setStaffSearch("")}
        onClose={() => setReassigning(false)}
        onConfirm={(e) => {
          const userId = (e.detail.selectedItems[0] as HTMLElement | undefined)?.dataset.id;
          if (userId && userId !== project.assigneeId) reassign.mutate({ projectId: id, userId });
        }}>
        {(assignable.data ?? [])
          .filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(staffSearch.trim().toLowerCase()))
          .map((m) => (
            <ListItemStandard key={m.userId} data-id={m.userId} text={m.name} description={m.email}
              selected={m.userId === project.assigneeId} />
          ))}
      </SelectDialog>
    ) : null}
    {/* The Attach button's picker. Cleared after each pick, so the same file again still fires. */}
    <input ref={fileInput} type="file" hidden onChange={(e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) attach.mutate(file);
    }} />
    </>
  );
}

/** A client's request's history: events and comments from Postgres, and the SAP document chain.
 *  Its own component so its fetches re-render this tab, not the whole configurator. */
function RequestTimeline({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const currency = useCurrency();
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
      onUpload={(file, internalOnly) => uploadFile(id, file, internalOnly).then(() => qc.invalidateQueries({ queryKey: listKey }))}
      onOpenDocument={(entity, key) => void navigate({ to: "/$slug/b1/$entity/$key", params: { entity, key: String(key) } })}
      canPreview />
  );
}
