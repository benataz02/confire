import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { BusyIndicator } from "@ui5/webcomponents-react";
import { orpc } from "../../../../orpc.ts";
import { PORTAL_FEATURES } from "../../../../features/portal/documents.tsx";
import { ListReport } from "../../../../shared/list-report/ListReport.tsx";
import { PageError } from "../../../../shared/object-page/ObjectPageSkeleton.tsx";
import { useFieldConstraints } from "../../../../shared/metadata.ts";
import { useListView } from "../../../../shared/useListView.ts";
import { PrintActions } from "../../../../components/b1/PrintActions.tsx";
import type { ListQuery, Row } from "../../../../shared/types.ts";

// The four document sets a portal client may browse. The server fences this independently
// (portal.docs's PORTAL_ENTITIES + CardCode); this guard only keeps a typo out of the URL bar.

export const Route = createFileRoute("/_authed/portal/docs/$entity")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_FEATURES[params.entity]) throw redirect({ to: "/portal" });
  },
  component: PortalDocs,
});

const NO_QUERY: ListQuery = { select: [], filter: [], orderby: [] };

function PortalDocs() {
  const { entity } = Route.useParams();
  const feature = PORTAL_FEATURES[entity]!;
  const meta = useFieldConstraints(entity, "portal");
  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.portal.docs.rows.infiniteOptions({
        input: (cursor: string | undefined) => ({ entity, query: query ?? NO_QUERY, ...(cursor ? { cursor } : { count: true }) }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor,
      }),
      enabled: !!query && !!meta.data,
    },
    { route: `/portal/docs/${entity}`, keyOf: (r) => r.DocEntry },
  );

  if (meta.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (meta.error) return <PageError error={meta.error} />;
  return (
    <ListReport key={entity} feature={feature.list} constraints={meta.data.fields} data={data} onQuery={setQuery}
      keyOf={(r) => String(r.DocEntry ?? "")} readOnly localViews
      toolbarActions={({ rows }) =>
        rows.length === 1 ? <PrintActions entity={entity} docEntry={Number((rows[0] as Row).DocEntry)} scope="portal" /> : null} />
  );
}
