import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ObjectStatus, Text } from "@ui5/webcomponents-react";
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

/** Not yet quoted or declined; "Created by me" is the same, the user's own. */
const OPEN = ["draft", "submitted", "in_review", "returned"];

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
  // `mine` is no column: the server computes it per caller, for "Created by me".
  filterFields: [
    { key: "name" }, { key: "status" }, { key: "modelName" },
    { key: "mine", label: t("PORTAL_VIEW_MINE"), type: "enum", visible: false, options: [{ value: "yes", label: t("PORTAL_VIEW_MINE") }] },
  ],
  // Code, not seeded rows: the portal shows personal views only (spec §9), never the tenant's shared ones.
  systemViews: [
    { key: "all", name: t("PORTAL_VIEW_ALL"), state: null, isDefault: true },
    { key: "open", name: t("PORTAL_VIEW_OPEN"), state: { filterValues: { status: OPEN } } },
    { key: "mine", name: t("PORTAL_VIEW_MINE"), state: { filterValues: { status: OPEN, mine: ["yes"] } } },
  ],
});

function Projects() {
  const i18n = useI18n();
  const t = i18n.getText.bind(i18n);
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
    // A viewer may not start a project.
    { route: "/projects", keyOf: (r) => r.id, ...(role === "viewer" ? {} : { create: "/projects/new" }) },
  );
  return (
    <ListReport feature={projectsFeature(t)} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} cellTemplates={{
      status: (row: Row) => {
        const key = row.status as keyof typeof PROJECT_STATUS;
        const s = PROJECT_STATUS[key];
        return s ? <ObjectStatus inverted state={s.state}>{t(PROJECT_STATUS_KEY[key])}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
      },
    }} />
  );
}
