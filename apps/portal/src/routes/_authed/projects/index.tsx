import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button, ObjectStatus, Text } from "@ui5/webcomponents-react";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { PROJECT_STATUS, PROJECT_STATUS_OPTIONS } from "@confire/ui/timeline/projectStatus.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";
import { meQuery, orpc } from "../../../orpc.ts";

// Projects (spec §9): the company's projects, one configuration each, with personal views on top of
// the declared ones. Buyers and owners start new ones from the catalog.

export const Route = createFileRoute("/_authed/projects/")({ component: Projects });

const FEATURE: ListFeature = {
  tableId: "portal:projects",
  title: "Projects",
  columns: [
    { key: "name", label: "Project" },
    { key: "modelName", label: "Product", groupable: true },
    { key: "status", label: "Status", type: "enum", options: PROJECT_STATUS_OPTIONS, width: 180, groupable: true },
    { key: "createdBy", label: "Created by", groupable: true },
    { key: "updatedAt", label: "Last changed", type: "date", width: 150 },
  ],
  filterFields: [{ key: "name" }, { key: "status" }, { key: "modelName" }],
  systemViews: [
    { key: "all", name: "All", state: null, isDefault: true },
    { key: "drafts", name: "Drafts", state: { filterValues: { status: ["draft"] } } },
    { key: "progress", name: "In progress", state: { filterValues: { status: ["submitted", "in_review"] } } },
    { key: "returned", name: "Changes requested", state: { filterValues: { status: ["returned"] } } },
    { key: "quoted", name: "Quoted", state: { filterValues: { status: ["quoted"] } } },
  ],
};

const CELLS = {
  status: (row: Row) => {
    const s = PROJECT_STATUS[row.status as keyof typeof PROJECT_STATUS];
    return s ? <ObjectStatus inverted state={s.state}>{s.text}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
  },
};

function Projects() {
  const navigate = useNavigate();
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
    <ListReport feature={FEATURE} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} cellTemplates={CELLS}
      toolbarActions={role === "viewer" ? undefined : () => (
        <Button design="Transparent" icon="add" onClick={() => void navigate({ to: "/projects/new" })}>New project</Button>
      )} />
  );
}
