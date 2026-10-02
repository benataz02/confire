import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button, ObjectStatus, Text } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "../../../shared/list-report/ListReport.tsx";
import { useListView } from "../../../shared/useListView.ts";
import { portalStatusUi, type PortalStatus } from "../../../components/portal/portalUi.ts";
import type { ListFeature, ListQuery, Row } from "../../../shared/types.ts";

export const Route = createFileRoute("/_authed/portal/")({ component: MyRequests });

const FEATURE: ListFeature = {
  tableId: "portal:projects",
  title: "My requests",
  columns: [
    { key: "name", label: "Name", type: "string" },
    { key: "modelName", label: "Product", type: "string" },
    {
      key: "status", label: "Status", type: "enum",
      options: Object.entries(portalStatusUi).map(([value, ui]) => ({ value, label: ui.text })),
    },
    { key: "updatedAt", label: "Updated", type: "date" },
  ],
  filterFields: [{ key: "name" }, { key: "status" }],
};

const CELLS = {
  status: (row: Row) => {
    const ui = portalStatusUi[row.status as PortalStatus];
    return ui ? <ObjectStatus state={ui.state}>{ui.text}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
  },
};

function MyRequests() {
  const navigate = useNavigate();
  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.portal.projects.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/portal", keyOf: (r) => r.id },
  );

  // Views are declared only: a portal client has no saved views, so no server calls either.
  return (
    <ListReport feature={FEATURE} data={data} onQuery={setQuery} keyOf={(r) => String(r.id)} localViews
      cellTemplates={CELLS}
      /* "New request" left the nav in favour of the document items; it lives here. */
      toolbarActions={() => <Button design="Emphasized" onClick={() => navigate({ to: "/portal/new" })}>New request</Button>} />
  );
}
