import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListItemStandard, Modals, SelectDialog, ToolbarButton } from "@ui5/webcomponents-react";
import { ProjectOverview } from "@confire/ui/project/ProjectOverview.tsx";
import { uploadFile } from "@confire/ui/files.ts";
import { toast } from "@confire/ui/toast.ts";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { ObjectPageSkeleton, PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { orpc, useCurrency } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";
import { latestDocument, OPEN_DOCUMENT } from "./runView.ts";

// A client's request's project page (client-project-page spec, "The project page"): where it stands,
// the conversation and Reassign. The configuration, its costs and the decisions on it (Accept, Send
// back, Decline, quote) are the configuration page's (/configs/<id>/configuration), the title's first
// action — Review inquiry while the request waits on staff.

const STEP_KEYS = ["SENT", "REVIEW", "QUOTED", "ORDERED", "DELIVERED", "INVOICED"].map((s) => `CONFIG_STEP_${s}`);

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
  // SAP, off the page's path: brings the stored SAP step up to date, then the project redraws with it.
  const progress = useQuery({ ...orpc.configs.progress.queryOptions({ input: { id } }), retry: false });
  useEffect(() => { if (progress.data?.changed) void qc.invalidateQueries({ queryKey: getKey }); }, [progress.data]);
  const comment = useMutation(orpc.timeline.comment.mutationOptions({
    onSuccess: () => void qc.invalidateQueries({ queryKey: listKey }),
  }));
  // Reassign (notifications spec §6): any colleague, from a picker of the workspace's staff. The answer
  // names the new assignee, so the header is patched rather than refetched. A failure is a MessageBox,
  // as PrintActions' is: the action sits in the title's toolbar, with no field to put it on.
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
    onError: (e) => void Modals.showMessageBox({ type: "Error", titleText: t("CONFIG_CHANGE_FAILED"), children: e.message }),
  }));

  const v = q.data;
  if (q.isPending) return <ObjectPageSkeleton />;
  if (q.error) return <PageError error={q.error} />;
  if (!v?.request) return null;

  const { project, request } = v;
  const { step, next } = request.journey;
  const name = project.name.trim() || t("CONFIG_NEW");
  const labels = STEP_KEYS.map((k) => t(k));
  // A DocEntry means something only in the SAP company it was posted in (as on the configuration page).
  const doc = project.b1DocEntry !== null && project.b1Company === v.sapCompany
    ? latestDocument({ status: project.status, b1DocEntry: project.b1DocEntry }, timeline.data?.events)
    : null;
  // The request is staff's work while it waits on review.
  const review = next === "review";

  return (
    <>
    <ProjectOverview side="internal" title={name}
      subtitle={t("CONFIG_REQUEST_SUB", request.cardName, request.assigneeName ? t("CONFIG_ASSIGNED", request.assigneeName) : t("CONFIG_NOT_ACCEPTED"))}
      breadcrumbs={<PageBreadcrumbs items={[{ text: t("NAV_REQUESTS"), to: "/requests" }]} current={name} />}
      status={project.status}
      actions={
        <>
          <ToolbarButton design="Emphasized" icon={review ? undefined : "edit"} text={t(review ? "CONFIG_REVIEW_INQUIRY" : "CONFIG_EDIT")}
            onClick={() => void navigate({ to: "/$slug/configs/$id/configuration", params: { id } })} />
          {doc ? (
            <ToolbarButton icon="document-text" design="Transparent" text={t(OPEN_DOCUMENT[doc.entity]!)}
              onClick={() => void navigate({ to: "/$slug/b1/$entity/$key", params: { entity: doc.entity, key: String(doc.docEntry) } })} />
          ) : null}
          <ToolbarButton icon="employee" design="Transparent" disabled={reassign.isPending}
            text={t("CONFIG_REASSIGN")} accessibilityAttributes={{ hasPopup: "dialog" }}
            onClick={() => setReassigning(true)} />
        </>
      }
      journey={{
        step, next, labels, nextText: t(`CONFIG_NEXT_${next.toUpperCase()}`, request.cardName),
        ariaLabel: t("CONFIG_JOURNEY_ARIA", Math.min(step, 5) + 1, labels[Math.min(step, 5)]!),
      }}
      timeline={{
        side: "internal", currency,
        events: timeline.data?.events,
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
    </>
  );
}
