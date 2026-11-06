import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, Button, MessageStrip, Tag, Text, ToolbarButton } from "@ui5/webcomponents-react";
import { ProjectOverview } from "@confire/ui/project/ProjectOverview.tsx";
import { configSummary } from "@confire/ui/configurator/summary.ts";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import type { TimelineEvent } from "@confire/ui/timeline/ProjectTimeline.tsx";
import { PrintActions } from "@confire/ui/PrintActions.tsx";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { formatLocale, parseIsoDate } from "@confire/ui/format.ts";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { useRefusals, type PageMessage } from "@confire/ui/PageMessages.tsx";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { money } from "@confire/ui/money.ts";
import { uploadFile } from "@confire/ui/files.ts";
import { client, meQuery, orpc, type Me } from "../../../orpc.ts";
import { PROJECT_STATUS_KEY } from "../../../features/labels.ts";
import { useI18n } from "../../../i18n.ts";

// A project's page (client-project-page spec, "The project page"): where it stands, the conversation,
// and the client's decisions on it — Accept/Decline on the latest quotation, Withdraw on the latest
// send. The configuration itself is its own page ($id_.configuration.tsx), one line here.

export const Route = createFileRoute("/$slug/projects/$id")({
  // Warms the query the page reads (same key), so a hover's preload has the project ready by the click.
  loader: ({ context, params }) => void context.queryClient.prefetchQuery(orpc.projects.get.queryOptions({ input: { id: params.id } })),
  component: Page,
});

function Page() {
  const { id } = Route.useParams();
  return <ProjectPage key={id} id={id} />;
}

type Payload = Awaited<ReturnType<typeof client.projects.get>>;

const STEP_KEYS = ["SENT", "REVIEW", "QUOTED", "ORDERED", "DELIVERED", "INVOICED"].map((s) => `PORTAL_HOME_STEP_${s}`);
const last = (events: TimelineEvent[] | undefined, kinds: string[]) => events?.findLast((e) => kinds.includes(e.kind));

function ProjectPage({ id }: { id: string }) {
  const i18n = useI18n();
  const t = (key: string, ...args: (string | number)[]) => i18n.getText(key, ...args);
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
  // Live SAP, separate on purpose: a down agent costs these rows (and the quote's figures), never the page.
  const documents = useQuery({ ...orpc.timeline.documents.queryOptions({ input: { projectId: id } }), retry: false });
  // Only while its figures show: beside an answerable quotation.
  const quotation = useQuery({
    ...orpc.projects.quotation.queryOptions({ input: { id } }),
    enabled: buyer && q.data?.project.status === "quoted" && q.data.project.quoteResponse === null, retry: false,
  });
  // SAP, off the page's path: brings the stored SAP step up to date, then the project redraws with it.
  const progress = useQuery({ ...orpc.projects.progress.queryOptions({ input: { id } }), retry: false });
  useEffect(() => { if (progress.data?.changed) void qc.invalidateQueries({ queryKey: getKey }); }, [progress.data]);

  // A status move: the list, the timeline and the documents all moved with it.
  const moved = (msg: string) => (p: Payload) => {
    qc.setQueryData(getKey, p);
    void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
    void qc.invalidateQueries({ queryKey: timelineKey });
    toast(msg);
  };
  const withdraw = useMutation(orpc.projects.withdraw.mutationOptions({ onSuccess: moved(t("PORTAL_TOAST_WITHDRAWN")) }));
  const respond = useMutation(orpc.projects.respondQuote.mutationOptions({
    onSuccess: (p, v) => moved(t(v.accept ? "PORTAL_TOAST_QUOTE_ACCEPTED" : "PORTAL_TOAST_QUOTE_DECLINED", supplier))(p),
  }));
  const remove = useMutation(orpc.projects.remove.mutationOptions({
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orpc.projects.rows.key() });
      toast(t("PORTAL_TOAST_DELETED"));
      void navigate({ to: "/$slug/projects" });
    },
  }));
  const comment = useMutation(orpc.timeline.comment.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: timelineKey }),
  }));
  const acting = withdraw.isPending || respond.isPending || remove.isPending;
  // A comment's failure is the composer's own (ProjectTimeline's postError), not a page message.
  const error = withdraw.error ?? respond.error ?? remove.error;
  const refused = useRefusals(withdraw.error, respond.error, remove.error);

  const p = q.data;
  if (q.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (q.error) return <PageError error={q.error} />;
  if (!p) return null;

  const status = p.project.status;
  const st = PROJECT_STATUS[status];
  const { step, next } = p.journey;
  const labels = STEP_KEYS.map((k) => t(k));
  const answerable = buyer && status === "quoted" && p.project.quoteResponse === null;
  const messages: PageMessage[] = error
    ? [{ id: "error", type: "Negative", text: t("PORTAL_CHANGE_FAILED"), detail: error.message, group: t("PORTAL_TIMELINE") }]
    : [];

  const answer = async (accept: boolean) => {
    const note = accept
      ? await promptNote({ title: t("PORTAL_ACCEPT_QUOTE"), actionText: t("PORTAL_ACCEPT"), message: t("PORTAL_ACCEPT_QUOTE_MESSAGE", supplier), label: t("PORTAL_NOTE_OPTIONAL") })
      : await promptNote({ title: t("PORTAL_DECLINE_QUOTE_TITLE"), actionText: t("PORTAL_DECLINE"), message: t("PORTAL_DECLINE_QUOTE_MESSAGE", supplier), label: t("PORTAL_NOTE_OPTIONAL") });
    if (note !== null) respond.mutate({ id, accept, ...(note ? { note } : {}) });
  };

  // The decisions sit on the entries they answer: the latest quotation, the latest send.
  const quoted = last(timeline.data?.events, ["quoted"]);
  const sent = last(timeline.data?.events, ["submitted", "resubmitted"]);
  const entryActions = (e: TimelineEvent) => {
    if (answerable && e.id === quoted?.id) {
      const docEntry = (e.payload as { docEntry?: number } | null)?.docEntry;
      const qd = quotation.data;
      const cur = qd?.currency || currency;
      return (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", alignSelf: "stretch" }}>
          {quotation.error ? (
            <MessageStrip design="Critical" hideCloseButton>{t("PORTAL_QUOTE_UNAVAILABLE", quotation.error.message)}</MessageStrip>
          ) : qd ? (
            <>
              <Text style={{ fontFamily: "var(--sapFontBoldFamily)" }}>
                {/* Joined here: a .properties value loses its leading space (PORTAL_QUOTE_VALID's " · "). */}
                {[t("PORTAL_TOTAL_AMOUNT", money(qd.docTotal, cur)),
                  qd.validUntil && t("PORTAL_QUOTE_VALID", parseIsoDate(qd.validUntil)?.toLocaleDateString(formatLocale()) ?? "")].filter(Boolean).join(" ")}
              </Text>
              {docEntry ? <PrintActions entity="Quotations" docEntry={docEntry} /> : null}
            </>
          ) : quotation.fetchStatus === "fetching" ? <BusyIndicator active delay={0} size="S" /> : null}
          <span style={{ flex: 1 }} />
          <Button design="Negative" disabled={acting} onClick={() => void answer(false)}>{t("PORTAL_DECLINE")}</Button>
          <Button design="Positive" disabled={acting} onClick={() => void answer(true)}>{t("PORTAL_ACCEPT_QUOTE")}</Button>
        </div>
      );
    }
    if (buyer && status === "submitted" && e.id === sent?.id)
      return <Button disabled={acting} onClick={() => withdraw.mutate({ id })}>{t("PORTAL_WITHDRAW")}</Button>;
    return null;
  };

  const openConfig = () => void navigate({ to: "/$slug/projects/$id/configuration", params: { id } });
  // Emphasized when the configuration is the client's work now: a draft to finish, changes asked for.
  const work = buyer && (next === "finish" || next === "changes") ? next : null;

  return (
    <ProjectOverview side="external" title={p.project.name} subtitle={p.model.name}
      breadcrumbs={<PageBreadcrumbs items={[{ text: t("PORTAL_PROJECTS"), to: "/projects" }]} current={p.project.name} />}
      tags={
        <>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>{t(PROJECT_STATUS_KEY[status])}</Tag>
          {p.project.quoteResponse ? (
            <Tag design={p.project.quoteResponse === "accepted" ? "Positive" : "Critical"} style={{ alignSelf: "center" }}>
              {t(p.project.quoteResponse === "accepted" ? "PORTAL_ACCEPTED_BY_YOU" : "PORTAL_DECLINED_BY_YOU")}
            </Tag>
          ) : null}
        </>
      }
      actions={buyer && status === "draft" ? (
        <ToolbarButton icon="delete" design="Transparent" text={t("PORTAL_DELETE")} disabled={acting}
          onClick={async () => {
            if (await confirm({ title: t("PORTAL_DELETE_PROJECT"), message: t("PORTAL_DELETE_PROJECT_MESSAGE", p.project.name), actionText: t("PORTAL_DELETE"), destructive: true }))
              remove.mutate({ id });
          }} />
      ) : null}
      messages={messages} openMessagesOn={refused}
      journey={{
        step, next, labels, nextText: t(`PORTAL_HOME_NEXT_${next.toUpperCase()}`, supplier),
        ariaLabel: t("PORTAL_HOME_JOURNEY_ARIA", Math.min(step, 5) + 1, labels[Math.min(step, 5)]!),
      }}
      config={{
        label: t("PORTAL_CONFIGURATION"),
        summary: configSummary(p.model.definition, p.form, p.project.batches),
        text: t(work === "finish" ? "PORTAL_CONTINUE_CONFIGURING" : work === "changes" ? "PORTAL_MAKE_CHANGES" : "PORTAL_OPEN"),
        emphasized: work !== null, onOpen: openConfig,
      }}
      upcoming={{ sentence: next === "done" || next === "declined" ? null : t(`PORTAL_NEXT_SENTENCE_${next.toUpperCase()}`, supplier) }}
      timeline={{
        side: "external", currency, canComment: true,
        events: timeline.data?.events, labels: timeline.data?.labels ?? {},
        loading: timeline.isPending, error: timeline.error as Error | null,
        documents: documents.data, documentsError: documents.error as Error | null,
        onComment: (note) => comment.mutateAsync({ projectId: id, note }),
        // Buyers and owners attach files; viewers read and comment (§4.2).
        onUpload: buyer ? (file) => uploadFile(id, file).then(() => qc.invalidateQueries({ queryKey: timelineKey })) : undefined,
        onOpenDocument: (entity, key) => void navigate({ to: "/$slug/docs/$entity/$key", params: { entity, key: String(key) } }),
        canPreview: true, entryActions,
      }} />
  );
}
