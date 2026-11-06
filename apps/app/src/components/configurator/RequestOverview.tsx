import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListItemStandard, SelectDialog, Tag, Text, ToolbarButton } from "@ui5/webcomponents-react";
import { ProjectOverview } from "@confire/ui/project/ProjectOverview.tsx";
import { configSummary } from "@confire/ui/configurator/summary.ts";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import { FILE_MAX_MB, uploadFile } from "@confire/ui/files.ts";
import { toast } from "@confire/ui/toast.ts";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { useRefusals, type PageMessage } from "@confire/ui/PageMessages.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { orpc, useCurrency } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { projectStatusText } from "./runView.ts";

// A client's request's project page (client-project-page spec, "The project page"): where it stands,
// the conversation, Reassign and Attach. The configuration, its costs and the decisions on it (Accept,
// Send back, Decline, quote) are the configuration page's (/configs/<id>/configuration).

const STEP_KEYS = ["SENT", "REVIEW", "QUOTED", "ORDERED", "DELIVERED", "INVOICED"].map((s) => `CONFIG_STEP_${s}`);
// The `next` values with a what-comes-next sentence; done and declined have nothing to come.
const SENTENCE = new Set(["review", "changes", "answer", "awaitOrder", "delivery", "invoice"]);

export function RequestOverview({ id }: { id: string }) {
  const i18n = useI18n();
  const t = (key: string, ...args: (string | number)[]) => i18n.getText(key, ...args);
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const currency = useCurrency();
  const getKey = orpc.configs.get.queryKey({ input: { id } });
  const q = useQuery(orpc.configs.get.queryOptions({ input: { id } }));
  const listKey = orpc.timeline.list.queryKey({ input: { projectId: id } });
  const timeline = useQuery(orpc.timeline.list.queryOptions({ input: { projectId: id } }));
  // Live SAP, so it may fail on its own without taking the events with it.
  const documents = useQuery({ ...orpc.timeline.documents.queryOptions({ input: { projectId: id } }), retry: false });
  const comment = useMutation(orpc.timeline.comment.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey }),
  }));
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
      void qc.invalidateQueries({ queryKey: listKey });
      toast(t("CONFIG_TOAST_REASSIGNED", r.assigneeName));
    },
  }));
  // The header's Attach: the timeline's upload, for the client to see — the internal-only toggle
  // stays on the timeline's own composer. The size check is here because the server's refusal of an
  // oversized body may reach the browser as a reset connection rather than its message.
  const fileInput = useRef<HTMLInputElement>(null);
  const attach = useMutation({
    mutationFn: (file: File) => file.size > FILE_MAX_MB * 1024 * 1024
      ? Promise.reject(new Error(t("CONFIG_FILE_MAX", FILE_MAX_MB)))
      : uploadFile(id, file),
    onSuccess: (_, file) => {
      void qc.invalidateQueries({ queryKey: listKey });
      toast(t("CONFIG_TOAST_ATTACHED", file.name));
    },
  });
  const error = reassign.error ?? attach.error ?? comment.error;
  const refused = useRefusals(reassign.error, attach.error, comment.error);

  const v = q.data;
  if (q.isPending) return <ObjectPageSkeleton />;
  if (q.error) return <PageError error={q.error} />;
  if (!v?.request) return null;

  const { project, request } = v;
  const { step, next } = request.journey;
  const name = project.name.trim() || t("CONFIG_NEW");
  const st = PROJECT_STATUS[project.status] ?? PROJECT_STATUS.draft;
  const labels = STEP_KEYS.map((k) => t(k));
  // A DocEntry means something only in the SAP company it was posted in (as on the configuration page).
  const quotationHere = project.b1DocEntry !== null && project.b1Company === v.sapCompany;
  const messages: PageMessage[] = error
    ? [{ id: "error", type: "Negative", text: t("CONFIG_CHANGE_FAILED"), detail: error.message, group: t("CONFIG_SECTION_TIMELINE") }]
    : [];

  return (
    <>
    <ProjectOverview side="internal" title={name} subtitle={v.model.name}
      breadcrumbs={<PageBreadcrumbs items={[{ text: t("NAV_REQUESTS"), to: "/requests" }]} current={name} />}
      tags={
        <>
          <Tag design={st.state === "None" ? "Neutral" : st.state} style={{ alignSelf: "center" }}>{projectStatusText(t, project.status)}</Tag>
          {/* The client's answer to the quotation (D20). A decline reopens the request in review. */}
          {project.quoteResponse ? (
            <Tag design={project.quoteResponse === "accepted" ? "Positive" : "Critical"} style={{ alignSelf: "center" }}>
              {t(project.quoteResponse === "accepted" ? "CONFIG_ACCEPTED_CLIENT" : "CONFIG_DECLINED_CLIENT")}
            </Tag>
          ) : null}
        </>
      }
      subHeader={<Text>{t("CONFIG_REQUEST_SUB", request.cardName, request.assigneeName ? t("CONFIG_ASSIGNED", request.assigneeName) : t("CONFIG_NOT_ACCEPTED"))}</Text>}
      actions={
        <>
          {quotationHere ? (
            <ToolbarButton icon="document-text" design="Transparent" text={t("CONFIG_OPEN_QUOTE")}
              onClick={() => void navigate({ to: "/$slug/b1/$entity/$key", params: { entity: "Quotations", key: String(project.b1DocEntry) } })} />
          ) : null}
          <ToolbarButton icon="employee" design="Transparent" disabled={reassign.isPending}
            text={t("CONFIG_REASSIGN")} accessibilityAttributes={{ hasPopup: "dialog" }}
            onClick={() => setReassigning(true)} />
          <ToolbarButton icon="attachment" design="Transparent" disabled={attach.isPending}
            text={t("CONFIG_ATTACH")} onClick={() => fileInput.current?.click()} />
        </>
      }
      messages={messages} openMessagesOn={refused}
      journey={{
        step, next, labels, nextText: t(`CONFIG_NEXT_${next.toUpperCase()}`, request.cardName),
        ariaLabel: t("CONFIG_JOURNEY_ARIA", Math.min(step, 5) + 1, labels[Math.min(step, 5)]!),
      }}
      config={{
        label: t("CONFIG_CONFIGURATION"),
        summary: configSummary(v.model.definition, v.form, project.batches),
        // The request is staff's work while it waits on review.
        text: t(next === "review" ? "CONFIG_REVIEW_REQUEST" : "CONFIG_OPEN"),
        emphasized: next === "review",
        onOpen: () => void navigate({ to: "/$slug/configs/$id/configuration", params: { id } }),
      }}
      upcoming={{ sentence: SENTENCE.has(next) ? t(`CONFIG_NEXT_SENTENCE_${next.toUpperCase()}`, request.cardName) : null }}
      timeline={{
        side: "internal", currency, canComment: true,
        events: timeline.data?.events, labels: timeline.data?.labels ?? {},
        loading: timeline.isPending, error: timeline.error as Error | null,
        documents: documents.data, documentsError: documents.error as Error | null,
        onComment: (note, internalOnly) => comment.mutateAsync({ projectId: id, note, internalOnly }),
        onUpload: (file, internalOnly) => uploadFile(id, file, internalOnly).then(() => qc.invalidateQueries({ queryKey: listKey })),
        onOpenDocument: (entity, key) => void navigate({ to: "/$slug/b1/$entity/$key", params: { entity, key: String(key) } }),
        canPreview: true,
      }} />
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
    {/* The Attach button's picker. Cleared after each pick, so the same file again still fires. */}
    <input ref={fileInput} type="file" hidden onChange={(e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (file) attach.mutate(file);
    }} />
    </>
  );
}
