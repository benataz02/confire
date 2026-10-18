import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Form, FormGroup, FormItem, Input, Label, MessageStrip, MultiInput, ObjectPage, ObjectPageSection,
  ObjectPageTitle, Panel, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Tag, Text, Title, Token, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import type { Entries, TableRows, Val } from "@confire/config-engine";
import { ConfiguratorForm, ConsistencyStatus } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { addBatch } from "@confire/ui/configurator/formHelpers.ts";
import { ProjectTimeline } from "@confire/ui/timeline/ProjectTimeline.tsx";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { money } from "@confire/ui/money.ts";
import { client, meQuery, orpc, type Me } from "../../../orpc.ts";

// One project (spec §9): the configuration, its prices, its timeline. The engine runs on the server
// (§7.1) — this page holds no model, no lookups and no formula, only the projection `get` and
// `calculate` return. One edit is one call, debounced like the internal page; the response IS the
// new state, so the cache is set from it rather than refetched.

export const Route = createFileRoute("/_authed/projects/$id")({ component: Page });

function Page() {
  const { id } = Route.useParams();
  return <ProjectPage key={id} id={id} />;
}

type Payload = Awaited<ReturnType<typeof client.projects.get>>;
type Draft = { entries: Entries; batches: number[]; tables: TableRows };

const BATCHES = "__batches";
const NONE: never[] = [];

function ProjectPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useQuery(meQuery).data as Me & { company: NonNullable<Me["company"]> };
  const buyer = me.company.role !== "viewer";
  const currency = me.currency ?? undefined;
  const supplier = me.tenant.name;

  const getKey = orpc.projects.get.queryOptions({ input: { id } }).queryKey;
  const q = useQuery(orpc.projects.get.queryOptions({ input: { id } }));
  const timelineKey = orpc.timeline.list.queryOptions({ input: { projectId: id } }).queryKey;
  const timeline = useQuery(orpc.timeline.list.queryOptions({ input: { projectId: id } }));
  // Live SAP, separate on purpose: a down agent costs these rows, never the page.
  const documents = useQuery({ ...orpc.timeline.documents.queryOptions({ input: { projectId: id } }), retry: false });
  const quotation = useQuery({
    ...orpc.projects.quotation.queryOptions({ input: { id } }),
    enabled: q.data?.prices.kind === "quotation", retry: false,
  });

  const [draft, setDraft] = useState<Draft | null>(null);
  const setPayload = (p: Payload) => qc.setQueryData(getKey, p);
  const calc = useMutation(orpc.projects.calculate.mutationOptions({
    // Only the draft that was sent: an edit typed while this call was in flight stays, and the
    // effect sends it next. `{ id, ...draft }` keeps each field's reference — see the internal page.
    onSuccess: (p, vars) => {
      setDraft((cur) => (cur && cur.entries === vars.entries && cur.batches === vars.batches
        && cur.tables === vars.tables ? null : cur));
      setPayload(p);
    },
  }));
  // A status move: the list, the timeline and the documents all moved with it.
  const moved = (msg: string) => (p: Payload) => {
    setPayload(p);
    void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
    void qc.invalidateQueries({ queryKey: timelineKey });
    toast(msg);
  };
  const submit = useMutation(orpc.projects.submit.mutationOptions({ onSuccess: moved(`Submitted — ${supplier} will review it`) }));
  const resubmit = useMutation(orpc.projects.resubmit.mutationOptions({ onSuccess: moved(`Resubmitted — ${supplier} will review it again`) }));
  const withdraw = useMutation(orpc.projects.withdraw.mutationOptions({ onSuccess: moved("Withdrawn — it is a draft again") }));
  const respond = useMutation(orpc.projects.respondQuote.mutationOptions({
    onSuccess: (p, v) => moved(v.accept ? `Quotation accepted — ${supplier} will place the order` : `Quotation declined — ${supplier} will review your request again`)(p),
  }));
  const rename = useMutation(orpc.projects.update.mutationOptions({ onSuccess: setPayload }));
  const remove = useMutation(orpc.projects.remove.mutationOptions({
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
      toast("Project deleted");
      void navigate({ to: "/projects" });
    },
  }));
  const comment = useMutation(orpc.timeline.comment.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: timelineKey }),
  }));
  const acting = submit.isPending || resubmit.isPending || withdraw.isPending || respond.isPending || remove.isPending;

  const p = q.data;
  const status = p?.project.status;
  const editable = buyer && (status === "draft" || status === "returned");
  const { entries, batches, tables } = draft ?? {
    entries: p?.project.entries ?? {}, batches: p?.project.batches ?? NONE, tables: p?.project.tables ?? {},
  };
  const edit = (patch: Partial<Draft>) => {
    // Reopens the debounce after a refused edit — see the effect below. Only then: a reset detaches
    // a pending call, and the effect would send a second calculate to race it.
    if (calc.isError) calc.reset();
    setDraft({ entries, batches, tables, ...patch });
  };

  // One call per pause in typing. `calc.isError` stops a refused edit retrying forever; the next
  // edit's reset() reopens it.
  useEffect(() => {
    if (!editable || !draft || calc.isPending || calc.isError) return;
    const t = setTimeout(() => calc.mutate({ id, ...draft }), 1000);
    return () => clearTimeout(t);
  }, [editable, draft, calc.isPending, calc.isError, id]);

  // A complete project with no calculation yet (a fresh draft, a model the supplier changed): ask
  // once. A failed calculation comes back as calcError, which stops this from asking again.
  const needsCalc = !!p && editable && !draft && p.project.calculatedAt === null
    && !p.missing.length && !p.prop.conflicts.length && !p.calcError;
  useEffect(() => {
    if (needsCalc && !calc.isPending && !calc.isError) calc.mutate({ id });
  }, [needsCalc, calc.isPending, calc.isError, id]);

  // What the form draws while an edit is in flight: the server's propagation with the typed values
  // over it, so a select shows the pick at once rather than a second later. Visibility, defaults
  // and options catch up when the answer lands.
  const prop = useMemo(() => {
    if (!p) return null;
    if (!draft) return p.prop;
    const values: Record<string, Val> = { ...p.prop.values };
    for (const k of Object.keys(p.project.entries)) if (!(k in draft.entries)) delete values[k];
    return { ...p.prop, values: { ...values, ...draft.entries } };
  }, [p, draft]);

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  if (!p || !prop || !status) return null;

  const st = PROJECT_STATUS[status];
  const calculating = calc.isPending || draft !== null || needsCalc;
  const gaps = [...(p.project.name.trim() ? [] : ["a name"]), ...p.missing.map((m) => m.message)];
  const ready = gaps.length === 0 && !p.prop.conflicts.length && !p.calcError && p.project.calculatedAt !== null;
  const error = calc.error ?? submit.error ?? resubmit.error ?? withdraw.error ?? respond.error ?? rename.error ?? remove.error;
  const answerable = buyer && status === "quoted" && p.project.quoteResponse === null;

  const STATUS_NOTE: Record<typeof status, string | null> = {
    draft: null,
    submitted: `Submitted — waiting for ${supplier} to take it into review. Withdraw it to change something.`,
    in_review: `${p.project.assigneeName ?? supplier} is reviewing this request.${p.project.quoteResponse === "declined" ? " You declined the quotation; a new one will follow." : ""}`,
    returned: `${supplier} asked for changes — the timeline has their note. Edit, then resubmit.`,
    declined: `${supplier} declined this request.`,
    quoted: p.project.quoteResponse === "accepted"
      ? `You accepted the quotation — ${supplier} will place the order.`
      : "Quoted — the quotation is under Prices.",
  };

  // Finalizing actions live in the footer (Fiori), one Emphasized at most.
  const footer = (() => {
    if (!buyer) return null;
    if (status === "draft" || status === "returned") {
      const resend = status === "returned";
      return (
        <Bar design="FloatingFooter"
          startContent={
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <ConsistencyStatus prop={prop} />
              {calculating ? <BusyIndicator active delay={0} size="S" /> : null}
            </div>
          }
          endContent={
            <Button design="Emphasized" disabled={!ready || calculating || acting}
              tooltip={ready ? undefined : `Complete first: ${[...gaps, ...(p.prop.conflicts.length ? ["resolve the conflicts"] : [])].join(", ") || "calculating…"}`}
              onClick={() => (resend ? resubmit : submit).mutate({ id })}>
              {resend ? "Resubmit" : "Submit"}
            </Button>
          } />
      );
    }
    if (status === "submitted")
      return <Bar design="FloatingFooter" endContent={<Button disabled={acting} onClick={() => withdraw.mutate({ id })}>Withdraw</Button>} />;
    if (answerable)
      return (
        <Bar design="FloatingFooter" endContent={
          <>
            <Button design="Positive" disabled={acting} onClick={async () => {
              const note = await promptNote({ title: "Accept quotation", actionText: "Accept", message: `${supplier} is told at once and places the order.` });
              if (note !== null) respond.mutate({ id, accept: true, ...(note ? { note } : {}) });
            }}>Accept quotation</Button>
            <Button design="Negative" disabled={acting} onClick={async () => {
              const note = await promptNote({ title: "Decline quotation", actionText: "Decline", message: `${supplier} reviews your request again. Tell them what should change.` });
              if (note !== null) respond.mutate({ id, accept: false, ...(note ? { note } : {}) });
            }}>Decline</Button>
          </>
        } />
      );
    return null;
  })();

  const pricesShown = p.prices.kind !== "request";

  return (
    <ObjectPage mode="IconTabBar" hidePinButton
      titleArea={
        <ObjectPageTitle header={<Title>{p.project.name}</Title>} subHeader={<Text>{p.model.name}</Text>}
          actionsBar={buyer && status === "draft" ? (
            <Toolbar design="Transparent">
              <ToolbarButton icon="delete" design="Transparent" text="Delete" disabled={acting}
                onClick={async () => {
                  if (await confirm({ title: "Delete project", message: `Delete "${p.project.name}"? This can't be undone.`, actionText: "Delete", destructive: true }))
                    remove.mutate({ id });
                }} />
            </Toolbar>
          ) : undefined}>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>{st.text}</Tag>
          {p.project.quoteResponse ? (
            <Tag design={p.project.quoteResponse === "accepted" ? "Positive" : "Critical"} style={{ alignSelf: "center" }}>
              {p.project.quoteResponse === "accepted" ? "Accepted by you" : "Declined by you"}
            </Tag>
          ) : null}
        </ObjectPageTitle>
      }
      footerArea={footer ?? undefined}>
      <ObjectPageSection id="configuration" titleText="Configuration">
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", paddingBlockEnd: "1rem" }}>
          {error ? <MessageStrip design="Negative" hideCloseButton>{error.message}</MessageStrip> : null}
          {p.calcError ? <MessageStrip design="Negative" hideCloseButton>{p.calcError}</MessageStrip> : null}
          {STATUS_NOTE[status] ? <MessageStrip design="Information" hideCloseButton>{STATUS_NOTE[status]}</MessageStrip> : null}
          <Panel accessibleRole="Region" headerText="General" headerLevel="H5">
          <Form accessibleName="General" labelSpan="S12 M12 L12 XL12" layout="S1 M2 L3 XL3"
            accessibleMode={editable ? "Edit" : "Display"} itemSpacing={editable ? "Normal" : "Large"}>
            <FormGroup>
              <FormItem labelContent={<Label for={editable ? "project-name" : undefined} required>Name</Label>}>
                {editable ? (
                  <Input id="project-name" value={p.project.name} style={{ width: "100%" }} maxlength={200} disabled={rename.isPending}
                    onChange={(e) => {
                      const v = (e.target.value ?? "").trim();
                      if (v && v !== p.project.name) rename.mutate({ id, name: v });
                    }} />
                ) : <Text>{p.project.name}</Text>}
              </FormItem>
              <FormItem labelContent={<Label>Product</Label>}>
                <Text>{p.model.name}</Text>
              </FormItem>
              <FormItem labelContent={<Label required>Batch quantities</Label>}>
                {editable ? (
                  // Same field as the internal page: Enter (or blur) turns the typed quantity into a token.
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
                ) : <Text>{batches.join(", ")}</Text>}
              </FormItem>
            </FormGroup>
          </Form>
          </Panel>
          <ConfiguratorForm model={p.model.definition} lookups={p.lookups} lk={p.lookups} prop={prop}
            entries={entries} readOnly={!editable} querySource={{ modelId: p.project.modelId }}
            onChange={(next) => edit({ entries: next })}
            // The server binds a picked row's columns itself on the next calculate.
            onQueryPick={() => {}}
            tables={tables} onTablesChange={editable ? (next) => edit({ tables: next }) : undefined}
            batches={batches} badges={p.badges} evaluated={p.prop.tables} />
        </div>
      </ObjectPageSection>
      {pricesShown && (
        <ObjectPageSection id="prices" titleText="Prices">
          <Prices prices={p.prices} quotation={quotation.data ?? null} quotationError={quotation.error as Error | null}
            quotationLoading={quotation.isPending && quotation.fetchStatus !== "idle"} currency={currency} supplier={supplier} />
        </ObjectPageSection>
      )}
      <ObjectPageSection id="timeline" titleText="Timeline">
        <ProjectTimeline side="external" currency={currency} canComment
          events={timeline.data?.events} labels={timeline.data?.labels ?? {}}
          loading={timeline.isPending} error={timeline.error as Error | null}
          documents={documents.data} documentsError={documents.error as Error | null}
          onComment={(note) => comment.mutateAsync({ projectId: id, note })} />
      </ObjectPageSection>
    </ObjectPage>
  );
}

type Quotation = NonNullable<Awaited<ReturnType<typeof client.projects.quotation>>>;

/** §7.2: the quotation once there is one; before that the indicative figures — live while the
 *  client edits, frozen at submission. Only these numbers ever reach the page. */
function Prices({ prices, quotation, quotationError, quotationLoading, currency, supplier }: {
  prices: Payload["prices"];
  quotation: Quotation | null;
  quotationError: Error | null;
  quotationLoading: boolean;
  currency?: string;
  supplier: string;
}) {
  if (prices.kind === "quotation") {
    if (quotationLoading) return <BusyIndicator active delay={0} />;
    if (quotationError) return <MessageStrip design="Critical" hideCloseButton>{`The quotation can't be shown right now: ${quotationError.message}`}</MessageStrip>;
    if (!quotation) return null;
    const cur = quotation.currency || currency;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "60rem" }}>
        {prices.declined ? (
          <MessageStrip design="Critical" hideCloseButton>{`You declined this quotation. ${supplier} is reviewing your request again.`}</MessageStrip>
        ) : null}
        <Text>
          {`Quotation ${quotation.docNum} of ${new Date(quotation.docDate).toLocaleDateString()}`}
          {quotation.validUntil ? ` · valid until ${new Date(quotation.validUntil).toLocaleDateString()}` : ""}
        </Text>
        <Table headerRow={
          <TableHeaderRow>
            <TableHeaderCell>Item</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">Quantity</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">Unit price</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">Total</TableHeaderCell>
          </TableHeaderRow>
        }>
          {quotation.lines.map((l, i) => (
            <TableRow key={i}>
              <TableCell><Text>{l.description}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{l.quantity.toLocaleString()}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{money(l.unitPrice, cur)}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{money(l.lineTotal, cur)}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
        <Text style={{ alignSelf: "flex-end", fontWeight: "bold" }}>
          {`Total ${money(quotation.docTotal, cur)}${quotation.vatSum ? ` (incl. ${money(quotation.vatSum, cur)} tax)` : ""}`}
        </Text>
      </div>
    );
  }
  if (prices.kind === "request") return null;
  const label = prices.kind === "live"
    ? "Indicative prices for what is configured now. The quotation has the final ones."
    : `Indicative at submission (${new Date(prices.at).toLocaleDateString()}). The quotation has the final prices.`;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "40rem" }}>
      <MessageStrip design="Information" hideCloseButton>{label}</MessageStrip>
      {prices.rows.length ? (
        <Table headerRow={
          <TableHeaderRow>
            <TableHeaderCell horizontalAlign="End">Quantity</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">Unit price</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">Total</TableHeaderCell>
          </TableHeaderRow>
        }>
          {prices.rows.map((r) => (
            <TableRow key={r.batchQty}>
              <TableCell horizontalAlign="End"><Text>{r.batchQty.toLocaleString()}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{`${r.from ? "from " : ""}${money(r.unitPrice, currency)}`}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{`${r.from ? "from " : ""}${money(r.total, currency)}`}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
      ) : (
        <Text style={{ color: "var(--sapContent_LabelColor)" }}>Prices show once the configuration is complete.</Text>
      )}
    </div>
  );
}
