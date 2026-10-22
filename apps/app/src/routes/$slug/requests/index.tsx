import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ObjectStatus, Text } from "@ui5/webcomponents-react";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

type TextFn = (key: string, ...args: Array<string | number>) => string;

const STATUS_KEY: Record<keyof typeof PROJECT_STATUS, string> = {
  draft: "ADMIN_STATUS_DRAFT",
  submitted: "ADMIN_STATUS_SUBMITTED",
  in_review: "ADMIN_STATUS_IN_REVIEW",
  returned: "ADMIN_CHANGES_REQUESTED",
  declined: "ADMIN_STATUS_DECLINED",
  quoted: "ADMIN_STATUS_QUOTED",
};

function requestsFeature(t: TextFn): ListFeature {
  const statusOptions = (Object.keys(STATUS_KEY) as (keyof typeof STATUS_KEY)[]).map((value) => ({ value, label: t(STATUS_KEY[value]) }));
  return {
    tableId: "requests",
    title: t("NAV_REQUESTS"),
    columns: [
      { key: "name", label: t("ADMIN_COL_REQUEST") },
      { key: "cardName", label: t("ADMIN_COL_CUSTOMER"), groupable: true },
      { key: "cardCode", label: t("ADMIN_COL_BP"), width: 150, hidden: true, linkConfig: { route: "/b1/BusinessPartners" } },
      { key: "modelName", label: t("ADMIN_COL_MODEL"), groupable: true },
      { key: "status", label: t("ADMIN_STATUS"), type: "enum", options: statusOptions, width: 170, groupable: true },
      { key: "assignee", label: t("ADMIN_COL_ASSIGNEE"), groupable: true },
      // The server computes it per caller: the "Mine" view filters on it.
      { key: "mine", label: t("ADMIN_COL_MINE"), type: "enum", options: [{ value: "yes", label: t("ADMIN_YES") }, { value: "no", label: t("ADMIN_NO") }], hidden: true },
      { key: "quoteResponse", label: t("ADMIN_COL_QUOTE_RESPONSE"), type: "enum", options: [{ value: "accepted", label: t("ADMIN_ACCEPTED") }, { value: "declined", label: t("ADMIN_STATUS_DECLINED") }], width: 150 },
      { key: "updatedAt", label: t("ADMIN_LAST_CHANGED"), type: "date", width: 150 },
    ],
    filterFields: [{ key: "cardName" }, { key: "status" }, { key: "assignee" }],
    systemViews: [
      { key: "new", name: t("ADMIN_VIEW_NEW"), state: { filterValues: { status: ["submitted"] } }, isDefault: true },
      { key: "mine", name: t("ADMIN_VIEW_MINE"), state: { filterValues: { status: ["in_review"], mine: ["yes"] }, adaptFilterKeys: ["cardName", "status", "mine"] } },
      { key: "returned", name: t("ADMIN_CHANGES_REQUESTED"), state: { filterValues: { status: ["returned"] } } },
      { key: "declined", name: t("ADMIN_VIEW_DECLINED"), state: { filterValues: { status: ["declined"] } } },
      { key: "quoted", name: t("ADMIN_VIEW_QUOTED"), state: { filterValues: { status: ["quoted"] } } },
      { key: "responses", name: t("ADMIN_VIEW_RESPONSES"), state: { filterValues: { quoteResponse: ["accepted", "declined"] }, adaptFilterKeys: ["cardName", "status", "quoteResponse"] } },
    ],
  };
}

function requestCells(t: TextFn) {
  return {
    status: (row: Row) => {
      const s = PROJECT_STATUS[row.status as keyof typeof PROJECT_STATUS];
      const key = STATUS_KEY[row.status as keyof typeof STATUS_KEY];
      return s && key ? <ObjectStatus inverted state={s.state}>{t(key)}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
    },
    quoteResponse: (row: Row) =>
      row.quoteResponse === "accepted" ? <ObjectStatus state="Positive">{t("ADMIN_ACCEPTED")}</ObjectStatus>
      : row.quoteResponse === "declined" ? <ObjectStatus state="Critical">{t("ADMIN_STATUS_DECLINED")}</ObjectStatus>
      : <Text />,
  };
}

// Portal → Requests (spec §10): the clients' projects from their first submit on — a client's draft
// is private. Any member. A row opens the configuration process page, which carries the decisions.

export const Route = createFileRoute("/$slug/requests/")({ component: Requests });

function Requests() {
  const i18n = useI18n();
  const t = (key: string, ...args: Array<string | number>) => i18n.getText(key, ...args);
  const feature = useMemo(() => requestsFeature(t), [i18n]);
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
