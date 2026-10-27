import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar, BusyIndicator, Button, Form, FormGroup, FormItem, Input, Label, MessageStrip, ObjectPage, ObjectPageSection,
  ObjectPageTitle, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Tag, Text, Title, Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import { BatchField, configuratorSections, ConsistencyStatus } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { GENERAL_SECTION } from "@confire/ui/configurator/formHelpers.ts";
import { overlayForm, usePatchQueue, type InputPatch } from "@confire/ui/configurator/patch.ts";
import { ProjectTimeline } from "@confire/ui/timeline/ProjectTimeline.tsx";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { money } from "@confire/ui/money.ts";
import { uploadFile } from "@confire/ui/files.ts";
import { client, meQuery, orpc, type Me } from "../../../orpc.ts";
import { PROJECT_STATUS_KEY } from "../../../features/labels.ts";
import { useI18n } from "../../../i18n.ts";

// One project (spec §9): the configuration, its prices, its timeline. The engine runs on the server
// (§7.1) — this page holds no model, no lookups and no formula, only the projection `get` and
// `calculate` return. One commit is one call, sent at once and queued behind the one in flight like
// the internal page; the response IS the new state, so the cache is set from it rather than
// refetched. A complete project is calculated by the read itself — nothing here asks for it.

export const Route = createFileRoute("/$slug/projects/$id")({ component: Page });

function Page() {
  const { id } = Route.useParams();
  return <ProjectPage key={id} id={id} />;
}

type Payload = Awaited<ReturnType<typeof client.projects.get>>;

const NONE: never[] = [];

function ProjectPage({ id }: { id: string }) {
  const i18n = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
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

  const setPayload = (p: Payload) => qc.setQueryData(getKey, p);
  const queue = usePatchQueue<Payload>(
    (op) => client.projects.calculate({ id, ...("patch" in op ? op.patch : {}) }),
    { answer: setPayload, refused: () => void qc.invalidateQueries({ queryKey: getKey }) },
  );
  // A status move: the list, the timeline and the documents all moved with it.
  const moved = (msg: string) => (p: Payload) => {
    setPayload(p);
    void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
    void qc.invalidateQueries({ queryKey: timelineKey });
    toast(msg);
  };
  const submit = useMutation(orpc.projects.submit.mutationOptions({ onSuccess: moved(i18n.getText("PORTAL_TOAST_SUBMITTED", supplier)) }));
  const resubmit = useMutation(orpc.projects.resubmit.mutationOptions({ onSuccess: moved(i18n.getText("PORTAL_TOAST_RESUBMITTED", supplier)) }));
  const withdraw = useMutation(orpc.projects.withdraw.mutationOptions({ onSuccess: moved(i18n.getText("PORTAL_TOAST_WITHDRAWN")) }));
  const respond = useMutation(orpc.projects.respondQuote.mutationOptions({
    onSuccess: (p, v) => moved(i18n.getText(v.accept ? "PORTAL_TOAST_QUOTE_ACCEPTED" : "PORTAL_TOAST_QUOTE_DECLINED", supplier))(p),
  }));
  const rename = useMutation(orpc.projects.update.mutationOptions({ onSuccess: setPayload }));
  const remove = useMutation(orpc.projects.remove.mutationOptions({
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
      toast(i18n.getText("PORTAL_TOAST_DELETED"));
      void navigate({ to: "/$slug/projects" });
    },
  }));
  const comment = useMutation(orpc.timeline.comment.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: timelineKey }),
  }));
  const acting = submit.isPending || resubmit.isPending || withdraw.isPending || respond.isPending || remove.isPending;

  const p = q.data;
  const status = p?.project.status;
  const editable = buyer && (status === "draft" || status === "returned");
  // What the user entered and the server has not answered yet, over the last answer: an echo of
  // input. Visibility, defaults, options and prices catch up when the answer lands.
  const pending = queue.pending;
  const batches = pending?.batches ?? p?.project.batches ?? NONE;
  const tables = pending?.tables ? { ...p?.project.tables, ...pending.tables } : p?.project.tables ?? {};
  const edit = (patch: InputPatch) => queue.commit(patch);

  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{q.error.message}</MessageStrip>;
  if (!p || !status) return null;

  const form = overlayForm(p.form, pending);
  const st = PROJECT_STATUS[status];
  const calculating = queue.sending;
  const gaps = p.missing.map((m) => m.message);
  const ready = gaps.length === 0 && !p.form.conflicts.length && !p.calcError && p.project.calculatedAt !== null;
  const error = queue.error?.error ?? submit.error ?? resubmit.error ?? withdraw.error ?? respond.error ?? rename.error ?? remove.error;
  const answerable = buyer && status === "quoted" && p.project.quoteResponse === null;

  const reviewer = p.project.assigneeName ?? supplier;
  const STATUS_NOTE: Record<typeof status, string | null> = {
    draft: null,
    submitted: i18n.getText("PORTAL_NOTE_SUBMITTED", supplier),
    in_review: i18n.getText(p.project.quoteResponse === "declined" ? "PORTAL_NOTE_IN_REVIEW_DECLINED" : "PORTAL_NOTE_IN_REVIEW", reviewer),
    returned: i18n.getText("PORTAL_NOTE_RETURNED", supplier),
    declined: i18n.getText("PORTAL_NOTE_DECLINED", supplier),
    quoted: p.project.quoteResponse === "accepted"
      ? i18n.getText("PORTAL_NOTE_QUOTED_ACCEPTED", supplier)
      : i18n.getText("PORTAL_NOTE_QUOTED"),
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
              <ConsistencyStatus form={form} />
              {calculating ? <BusyIndicator active delay={0} size="S" /> : null}
            </div>
          }
          endContent={
            <Button design="Emphasized" disabled={!ready || queue.busy || acting}
              tooltip={ready ? undefined : i18n.getText("PORTAL_COMPLETE_FIRST", [...gaps, ...(p.form.conflicts.length ? [i18n.getText("PORTAL_GAP_CONFLICTS")] : [])].join(", ") || i18n.getText("PORTAL_CALCULATING"))}
              onClick={() => (resend ? resubmit : submit).mutate({ id })}>
              {resend ? i18n.getText("PORTAL_RESUBMIT") : i18n.getText("PORTAL_SUBMIT")}
            </Button>
          } />
      );
    }
    if (status === "submitted")
      return <Bar design="FloatingFooter" endContent={<Button disabled={acting} onClick={() => withdraw.mutate({ id })}>{i18n.getText("PORTAL_WITHDRAW")}</Button>} />;
    if (answerable)
      return (
        <Bar design="FloatingFooter" endContent={
          <>
            <Button design="Positive" disabled={acting} onClick={async () => {
              const note = await promptNote({ title: i18n.getText("PORTAL_ACCEPT_QUOTE"), actionText: i18n.getText("PORTAL_ACCEPT"), message: i18n.getText("PORTAL_ACCEPT_QUOTE_MESSAGE", supplier), label: i18n.getText("PORTAL_NOTE_OPTIONAL") });
              if (note !== null) respond.mutate({ id, accept: true, ...(note ? { note } : {}) });
            }}>{i18n.getText("PORTAL_ACCEPT_QUOTE")}</Button>
            <Button design="Negative" disabled={acting} onClick={async () => {
              const note = await promptNote({ title: i18n.getText("PORTAL_DECLINE_QUOTE_TITLE"), actionText: i18n.getText("PORTAL_DECLINE"), message: i18n.getText("PORTAL_DECLINE_QUOTE_MESSAGE", supplier), label: i18n.getText("PORTAL_NOTE_OPTIONAL") });
              if (note !== null) respond.mutate({ id, accept: false, ...(note ? { note } : {}) });
            }}>{i18n.getText("PORTAL_DECLINE")}</Button>
          </>
        } />
      );
    return null;
  })();

  const pricesShown = p.prices.kind !== "request";

  return (
    // One scrolling page, like the staff side's: General, the model's sections, then prices and timeline.
    <ObjectPage hidePinButton
      titleArea={
        <ObjectPageTitle header={<Title>{p.project.name}</Title>} subHeader={<Text>{p.model.name}</Text>}
          breadcrumbs={<PageBreadcrumbs items={[{ text: i18n.getText("PORTAL_PROJECTS"), to: "/projects" }]} current={p.project.name} />}
          actionsBar={buyer && status === "draft" ? (
            <Toolbar design="Transparent">
              <ToolbarButton icon="delete" design="Transparent" text={i18n.getText("PORTAL_DELETE")} disabled={acting}
                onClick={async () => {
                  if (await confirm({ title: i18n.getText("PORTAL_DELETE_PROJECT"), message: i18n.getText("PORTAL_DELETE_PROJECT_MESSAGE", p.project.name), actionText: i18n.getText("PORTAL_DELETE"), destructive: true }))
                    remove.mutate({ id });
                }} />
            </Toolbar>
          ) : undefined}>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>{i18n.getText(PROJECT_STATUS_KEY[status])}</Tag>
          {p.project.quoteResponse ? (
            <Tag design={p.project.quoteResponse === "accepted" ? "Positive" : "Critical"} style={{ alignSelf: "center" }}>
              {i18n.getText(p.project.quoteResponse === "accepted" ? "PORTAL_ACCEPTED_BY_YOU" : "PORTAL_DECLINED_BY_YOU")}
            </Tag>
          ) : null}
        </ObjectPageTitle>
      }
      footerArea={footer ?? undefined}>
      {/* One flat array: ObjectPage reads sections (or booleans) off its children, one level deep. */}
      {[
        <ObjectPageSection key={GENERAL_SECTION} id={GENERAL_SECTION} titleText={i18n.getText("PORTAL_GENERAL")}>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {error ? (
              <MessageStrip design="Negative" hideCloseButton>
                {error.message}
                {/* An edit that never reached the server is kept; this sends it again. */}
                {queue.error && !queue.error.refused ? (
                  <Button design="Transparent" icon="refresh" onClick={queue.retry}>{i18n.getText("PORTAL_RETRY")}</Button>
                ) : null}
              </MessageStrip>
            ) : null}
            {p.calcError ? <MessageStrip design="Negative" hideCloseButton>{p.calcError}</MessageStrip> : null}
            {STATUS_NOTE[status] ? <MessageStrip design="Information" hideCloseButton>{STATUS_NOTE[status]}</MessageStrip> : null}
            <Form accessibleName={i18n.getText("PORTAL_GENERAL")} labelSpan="S12 M12 L12 XL12" layout="S1 M2 L3 XL3"
              accessibleMode={editable ? "Edit" : "Display"} itemSpacing={editable ? "Normal" : "Large"}>
              <FormGroup>
                <FormItem labelContent={<Label for={editable ? "project-name" : undefined} required>{i18n.getText("PORTAL_NAME")}</Label>}>
                  {editable ? (
                    <Input id="project-name" value={p.project.name} style={{ width: "100%" }} maxlength={200} disabled={rename.isPending}
                      onChange={(e) => {
                        const v = (e.target.value ?? "").trim();
                        if (v && v !== p.project.name) rename.mutate({ id, name: v });
                      }} />
                  ) : <Text>{p.project.name}</Text>}
                </FormItem>
                <FormItem labelContent={<Label>{i18n.getText("PORTAL_PRODUCT")}</Label>}>
                  <Text>{p.model.name}</Text>
                </FormItem>
                <BatchField batches={batches} onChange={editable ? (next) => edit({ batches: next }) : undefined} />
              </FormGroup>
            </Form>
          </div>
        </ObjectPageSection>,
        ...configuratorSections({
          model: p.model.definition, form, tables: p.lookups.tables,
          readOnly: !editable, querySource: { modelId: p.project.modelId },
          onChange: (key, v) => edit(v === undefined ? { unset: [key] } : { set: { [key]: v } }),
          rows: tables, onRowsChange: editable ? (key, rows) => edit({ tables: { [key]: rows } }) : undefined,
          batches,
        }),
        pricesShown && (
          <ObjectPageSection key="prices" id="prices" titleText={i18n.getText("PORTAL_PRICES")}>
            <Prices prices={p.prices} quotation={quotation.data ?? null} quotationError={quotation.error as Error | null}
              quotationLoading={quotation.isPending && quotation.fetchStatus !== "idle"} currency={currency} supplier={supplier} />
          </ObjectPageSection>
        ),
        <ObjectPageSection key="timeline" id="timeline" titleText={i18n.getText("PORTAL_TIMELINE")}>
          <ProjectTimeline side="external" currency={currency} canComment
            events={timeline.data?.events} labels={timeline.data?.labels ?? {}}
            loading={timeline.isPending} error={timeline.error as Error | null}
            documents={documents.data} documentsError={documents.error as Error | null}
            onComment={(note) => comment.mutateAsync({ projectId: id, note })}
            // Buyers and owners attach files; viewers read and comment (§4.2).
            onUpload={buyer ? (file) => uploadFile(id, file).then(() => qc.invalidateQueries({ queryKey: timelineKey })) : undefined}
            onOpenDocument={(entity, key) => void navigate({ to: "/$slug/docs/$entity/$key", params: { entity, key: String(key) } })}
            canPreview />
        </ObjectPageSection>,
      ]}
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
  const i18n = useI18n();
  const priced = (amount: string, from: boolean) => (from ? i18n.getText("PORTAL_PRICE_FROM", amount) : amount);
  if (prices.kind === "quotation") {
    if (quotationLoading) return <BusyIndicator active delay={0} />;
    if (quotationError) return <MessageStrip design="Critical" hideCloseButton>{i18n.getText("PORTAL_QUOTE_UNAVAILABLE", quotationError.message)}</MessageStrip>;
    if (!quotation) return null;
    const cur = quotation.currency || currency;
    const when = new Date(quotation.docDate).toLocaleDateString(formatLocale());
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "60rem" }}>
        {prices.declined ? (
          <MessageStrip design="Critical" hideCloseButton>{i18n.getText("PORTAL_QUOTE_DECLINED_AGAIN", supplier)}</MessageStrip>
        ) : null}
        <Text>
          {i18n.getText("PORTAL_QUOTE_OF", String(quotation.docNum), when)}
          {quotation.validUntil ? i18n.getText("PORTAL_QUOTE_VALID", new Date(quotation.validUntil).toLocaleDateString(formatLocale())) : ""}
        </Text>
        <Table headerRow={
          <TableHeaderRow>
            <TableHeaderCell>{i18n.getText("PORTAL_ITEM")}</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">{i18n.getText("PORTAL_QUANTITY")}</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">{i18n.getText("PORTAL_UNIT_PRICE")}</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">{i18n.getText("PORTAL_TOTAL")}</TableHeaderCell>
          </TableHeaderRow>
        }>
          {quotation.lines.map((l, i) => (
            <TableRow key={i}>
              <TableCell><Text>{l.description}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{l.quantity.toLocaleString(formatLocale())}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{money(l.unitPrice, cur)}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{money(l.lineTotal, cur)}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
        <Text style={{ alignSelf: "flex-end", fontWeight: "bold" }}>
          {quotation.vatSum
            ? i18n.getText("PORTAL_TOTAL_TAX", money(quotation.docTotal, cur), money(quotation.vatSum, cur))
            : i18n.getText("PORTAL_TOTAL_AMOUNT", money(quotation.docTotal, cur))}
        </Text>
      </div>
    );
  }
  if (prices.kind === "request") return null;
  const label = prices.kind === "live"
    ? i18n.getText("PORTAL_PRICE_LIVE")
    : i18n.getText("PORTAL_PRICE_FROZEN", new Date(prices.at).toLocaleDateString(formatLocale()));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "40rem" }}>
      <MessageStrip design="Information" hideCloseButton>{label}</MessageStrip>
      {prices.rows.length ? (
        <Table headerRow={
          <TableHeaderRow>
            <TableHeaderCell horizontalAlign="End">{i18n.getText("PORTAL_QUANTITY")}</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">{i18n.getText("PORTAL_UNIT_PRICE")}</TableHeaderCell>
            <TableHeaderCell horizontalAlign="End">{i18n.getText("PORTAL_TOTAL")}</TableHeaderCell>
          </TableHeaderRow>
        }>
          {prices.rows.map((r) => (
            <TableRow key={r.batchQty}>
              <TableCell horizontalAlign="End"><Text>{r.batchQty.toLocaleString(formatLocale())}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{priced(money(r.unitPrice, currency), r.from)}</Text></TableCell>
              <TableCell horizontalAlign="End"><Text>{priced(money(r.total, currency), r.from)}</Text></TableCell>
            </TableRow>
          ))}
        </Table>
      ) : (
        <Text style={{ color: "var(--sapContent_LabelColor)" }}>{i18n.getText("PORTAL_PRICE_PENDING")}</Text>
      )}
    </div>
  );
}
