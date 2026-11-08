import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { ObjectStatus, Text } from "@ui5/webcomponents-react";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";
import { viewsQuery } from "@confire/ui/views.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { projectStatusOptions } from "@confire/ui/timeline/projectStatus.ts";
import { ProjectStatusCell } from "@confire/ui/timeline/ProjectStatus.tsx";
import { useUiI18n } from "@confire/ui/i18n.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

type TextFn = (key: string, ...args: Array<string | number>) => string;

/** `ui` reads the `@confire/ui` bundle, which holds the status words. */
function requestsFeature(t: TextFn, ui: TextFn): ListFeature {
  return {
    tableId: "requests",
    title: t("NAV_REQUESTS"),
    columns: [
      { key: "name", label: t("ADMIN_COL_REQUEST") },
      { key: "cardName", label: t("ADMIN_COL_CUSTOMER"), groupable: true },
      { key: "cardCode", label: t("ADMIN_COL_BP"), width: 150, hidden: true, linkConfig: { route: "/b1/BusinessPartners" } },
      { key: "modelName", label: t("ADMIN_COL_MODEL"), groupable: true },
      { key: "status", label: t("ADMIN_STATUS"), type: "enum", options: projectStatusOptions(ui), width: 170, groupable: true },
      { key: "assignee", label: t("ADMIN_COL_ASSIGNEE"), groupable: true },
      // The server computes it per caller: the seeded "Assigned to me" view filters on it.
      { key: "mine", label: t("ADMIN_COL_MINE"), type: "enum", options: [{ value: "yes", label: t("ADMIN_YES") }, { value: "no", label: t("ADMIN_NO") }], hidden: true },
      { key: "quoteResponse", label: t("ADMIN_COL_QUOTE_RESPONSE"), type: "enum", options: [{ value: "accepted", label: t("ADMIN_ACCEPTED") }, { value: "declined", label: t("ADMIN_DECLINED") }], width: 150 },
      { key: "updatedAt", label: t("ADMIN_LAST_CHANGED"), type: "date", width: 150 },
    ],
    // All / Open / Assigned to me are the workspace's seeded shared views (server ui-views.ts).
    filterFields: [{ key: "cardName" }, { key: "status" }, { key: "assignee" }],
  };
}

function requestCells(t: TextFn) {
  return {
    status: (row: Row) => <ProjectStatusCell status={row.status} />,
    quoteResponse: (row: Row) =>
      row.quoteResponse === "accepted" ? <ObjectStatus state="Positive">{t("ADMIN_ACCEPTED")}</ObjectStatus>
      : row.quoteResponse === "declined" ? <ObjectStatus state="Critical">{t("ADMIN_DECLINED")}</ObjectStatus>
      : <Text />,
  };
}

// Portal → Requests (spec §10): the clients' projects from their first submit on — a client's draft
// is private. Any member. A row opens the configuration process page, which carries the decisions.

export const Route = createFileRoute("/$slug/requests/")({
  head: () => title(t("NAV_REQUESTS")),
  // A hovered link (a home tile, a row's link) warms the views the list waits on, never awaited.
  loader: ({ context }) => void context.queryClient.prefetchQuery(viewsQuery(orpc, "requests")),
  component: Requests,
});

function Requests() {
  const i18n = useI18n();
  const ui = useUiI18n();
  const t = (key: string, ...args: Array<string | number>) => i18n.getText(key, ...args);
  const feature = useMemo(() => requestsFeature(t, (k) => ui.getText(k)), [i18n, ui]);
  const cells = useMemo(() => requestCells(t), [i18n]);
  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.requests.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/configs", keyOf: (r) => r.id },
  );
  return <ListReport feature={feature} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} cellTemplates={cells} />;
}
