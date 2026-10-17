import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ObjectStatus, Text } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { PROJECT_STATUS, PROJECT_STATUS_OPTIONS } from "@confire/ui/timeline/projectStatus.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

// Portal → Requests (spec §10): the clients' projects from their first submit on — a client's draft
// is private. Any member. A row opens the configuration process page, which carries the decisions.

export const Route = createFileRoute("/_authed/requests/")({ component: Requests });

const RESPONSE = [{ value: "accepted", label: "Accepted" }, { value: "declined", label: "Declined" }];

const FEATURE: ListFeature = {
  tableId: "requests",
  title: "Requests",
  columns: [
    { key: "name", label: "Request" },
    { key: "cardName", label: "Customer", groupable: true },
    { key: "cardCode", label: "Business partner", width: 150, hidden: true, linkConfig: { route: "/b1/BusinessPartners" } },
    { key: "modelName", label: "Model", groupable: true },
    { key: "status", label: "Status", type: "enum", options: PROJECT_STATUS_OPTIONS, width: 170, groupable: true },
    { key: "assignee", label: "Assigned to", groupable: true },
    // The server computes it per caller: the "Mine" view filters on it.
    { key: "mine", label: "Assigned to me", type: "enum", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], hidden: true },
    { key: "quoteResponse", label: "Quote response", type: "enum", options: RESPONSE, width: 150 },
    { key: "updatedAt", label: "Last changed", type: "date", width: 150 },
  ],
  filterFields: [{ key: "cardName" }, { key: "status" }, { key: "assignee" }],
  systemViews: [
    { key: "new", name: "New", state: { filterValues: { status: ["submitted"] } }, isDefault: true },
    { key: "mine", name: "Mine", state: { filterValues: { status: ["in_review"], mine: ["yes"] }, adaptFilterKeys: ["cardName", "status", "mine"] } },
    { key: "returned", name: "Changes requested", state: { filterValues: { status: ["returned"] } } },
    { key: "declined", name: "Declined", state: { filterValues: { status: ["declined"] } } },
    { key: "quoted", name: "Quoted", state: { filterValues: { status: ["quoted"] } } },
    { key: "responses", name: "Quote responses", state: { filterValues: { quoteResponse: ["accepted", "declined"] }, adaptFilterKeys: ["cardName", "status", "quoteResponse"] } },
  ],
};

const CELLS = {
  status: (row: Row) => {
    const s = PROJECT_STATUS[row.status as keyof typeof PROJECT_STATUS];
    return s ? <ObjectStatus inverted state={s.state}>{s.text}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
  },
  quoteResponse: (row: Row) =>
    row.quoteResponse === "accepted" ? <ObjectStatus state="Positive">Accepted</ObjectStatus>
    : row.quoteResponse === "declined" ? <ObjectStatus state="Critical">Declined</ObjectStatus>
    : <Text />,
};

function Requests() {
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
  return <ListReport feature={FEATURE} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} cellTemplates={CELLS} />;
}
