import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, ObjectStatus, Text } from "@ui5/webcomponents-react";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { PROJECT_STATUS, PROJECT_STATUS_OPTIONS } from "@confire/ui/timeline/projectStatus.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";
import { PROJECT_STATUS_KEY, type TextFn } from "../../../features/labels.ts";
import { useI18n } from "../../../i18n.ts";
import { meQuery, orpc } from "../../../orpc.ts";

// Projects (spec §9): the company's projects, one configuration each, with personal views on top of
// the declared ones. Buyers and owners start new ones from the catalog.

export const Route = createFileRoute("/$slug/projects/")({ component: Projects });

const projectsFeature = (t: TextFn): ListFeature => ({
  tableId: "portal:projects",
  title: t("PORTAL_PROJECTS"),
  columns: [
    { key: "name", label: t("PORTAL_PROJECT") },
    { key: "modelName", label: t("PORTAL_PRODUCT"), groupable: true },
    {
      key: "status", label: t("PORTAL_STATUS"), type: "enum", width: 180, groupable: true,
      options: PROJECT_STATUS_OPTIONS.map((o) => ({ ...o, label: t(PROJECT_STATUS_KEY[o.value as keyof typeof PROJECT_STATUS]) })),
    },
    { key: "createdBy", label: t("PORTAL_CREATED_BY"), groupable: true },
    { key: "updatedAt", label: t("PORTAL_LAST_CHANGED"), type: "date", width: 150 },
  ],
  filterFields: [{ key: "name" }, { key: "status" }, { key: "modelName" }],
  systemViews: [
    { key: "all", name: t("PORTAL_VIEW_ALL"), state: null, isDefault: true },
    { key: "drafts", name: t("PORTAL_VIEW_DRAFTS"), state: { filterValues: { status: ["draft"] } } },
    { key: "progress", name: t("PORTAL_VIEW_IN_PROGRESS"), state: { filterValues: { status: ["submitted", "in_review"] } } },
    { key: "returned", name: t("PORTAL_STATUS_RETURNED"), state: { filterValues: { status: ["returned"] } } },
    { key: "quoted", name: t("PORTAL_STATUS_QUOTED"), state: { filterValues: { status: ["quoted"] } } },
  ],
});

function Projects() {
  const i18n = useI18n();
  const t = i18n.getText.bind(i18n);
  const navigate = useNavigate({ from: "/$slug" });
  const role = useQuery(meQuery).data?.company?.role;
  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.projects.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/projects", keyOf: (r) => r.id },
  );
  return (
    <ListReport feature={projectsFeature(t)} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} cellTemplates={{
      status: (row: Row) => {
        const key = row.status as keyof typeof PROJECT_STATUS;
        const s = PROJECT_STATUS[key];
        return s ? <ObjectStatus inverted state={s.state}>{t(PROJECT_STATUS_KEY[key])}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
      },
    }}
      toolbarActions={role === "viewer" ? undefined : () => (
        <Button design="Transparent" icon="add" onClick={() => void navigate({ to: "/$slug/projects/new" })}>{t("PORTAL_NEW_PROJECT")}</Button>
      )} />
  );
}
