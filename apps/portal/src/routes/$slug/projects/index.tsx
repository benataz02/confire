import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { projectStatusOptions } from "@confire/ui/timeline/projectStatus.ts";
import { ProjectStatusCell } from "@confire/ui/timeline/ProjectStatus.tsx";
import { useUiI18n } from "@confire/ui/i18n.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";
import type { TextFn } from "../../../features/labels.ts";
import { useI18n } from "../../../i18n.ts";
import { viewsQuery } from "@confire/ui/views.ts";
import { meQuery, orpc } from "../../../orpc.ts";

// Projects (spec §9): the company's projects, one configuration each, with personal views on top of
// the declared ones. Buyers and owners start new ones from the catalog.

export const Route = createFileRoute("/$slug/projects/")({
  // A hovered link warms the views the list waits on; not awaited, so a click never waits for it.
  loader: ({ context }) => void context.queryClient.prefetchQuery(viewsQuery(orpc, "portal:projects")),
  component: Projects,
});

/** The journey's next steps (server portal/journey.ts), in its order: the home tiles open this list on them. */
const NEXT = ["finish", "review", "changes", "answer", "awaitOrder", "delivery", "invoice", "done", "declined"];

/** Not yet quoted or declined; "Created by me" is the same, the user's own. */
const OPEN = ["draft", "submitted", "in_review", "returned"];

/** `ui` reads the `@confire/ui` bundle, which holds the status words. */
const projectsFeature = (t: TextFn, ui: TextFn, supplier: string): ListFeature => ({
  tableId: "portal:projects",
  title: t("PORTAL_PROJECTS"),
  columns: [
    { key: "name", label: t("PORTAL_PROJECT") },
    { key: "modelName", label: t("PORTAL_PRODUCT"), groupable: true },
    {
      key: "status", label: t("PORTAL_STATUS"), type: "enum", width: 180, groupable: true,
      options: projectStatusOptions(ui),
    },
    { key: "createdBy", label: t("PORTAL_CREATED_BY"), groupable: true },
    { key: "updatedAt", label: t("PORTAL_LAST_CHANGED"), type: "date", width: 150 },
  ],
  // `mine` is no column: the server computes it per caller, for "Created by me".
  filterFields: [
    { key: "name" }, { key: "status" }, { key: "modelName" },
    { key: "mine", label: t("PORTAL_VIEW_MINE"), type: "enum", visible: false, options: [{ value: "yes", label: t("PORTAL_VIEW_MINE") }] },
    {
      key: "next", label: t("PORTAL_HOME_COL_NEXT"), type: "enum", visible: false,
      options: NEXT.map((n) => ({ value: n, label: t(`PORTAL_HOME_NEXT_${n.toUpperCase()}`, supplier) })),
    },
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
  const ui = useUiI18n();
  const me = useQuery(meQuery).data;
  const role = me?.company?.role;
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
    <ListReport feature={projectsFeature(t, ui.getText.bind(ui), me?.tenant.name ?? "")} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} cellTemplates={{ status: (row: Row) => <ProjectStatusCell status={row.status} /> }} />
  );
}
