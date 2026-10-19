import { useMemo, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { BusyIndicator } from "@ui5/webcomponents-react";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import { useFieldConstraints } from "@confire/ui/metadata.ts";
import { useListView } from "@confire/ui/useListView.ts";
import { PrintActions } from "@confire/ui/PrintActions.tsx";
import type { ListQuery, Row } from "@confire/ui/types.ts";
import { orpc } from "../../../../orpc.ts";
import { docFeature, isDocEntity, type DocEntity } from "../../../../features/documents.ts";

// Documents ▸ <entity> (spec §9, §13.1): the company's own SAP documents, columns from the tenant's
// field list. The server fences every page to the company; there is no customer column to filter.

export const Route = createFileRoute("/$slug/_authed/docs/$entity")({
  beforeLoad: ({ params }) => {
    if (!isDocEntity(params.entity)) throw redirect({ to: "/$slug", params });
  },
  component: DocsPage,
});

function DocsPage() {
  const { entity } = Route.useParams();
  return <DocList key={entity} entity={entity as DocEntity} />;
}

const NO_QUERY: ListQuery = { select: [], filter: [], orderby: [] };

function DocList({ entity }: { entity: DocEntity }) {
  const meta = useFieldConstraints(entity);
  const feature = useMemo(() => (meta.data ? docFeature(entity, meta.data) : null), [entity, meta.data]);
  const [query, setQuery] = useState<ListQuery | null>(null);
  // The cursor is B1's own @odata.nextLink, sealed to this company server-side; page 1 asks for the count.
  const data = useListView(
    {
      ...orpc.docs.rows.infiniteOptions({
        input: (cursor: string | undefined) => ({ entity, query: query ?? NO_QUERY, ...(cursor ? { cursor } : { count: true }) }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor,
      }),
      enabled: !!query && !!meta.data,
    },
    { route: `/docs/${entity}`, keyOf: (r) => r.DocEntry },
  );

  if (meta.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (meta.error || !feature) return <PageError error={meta.error ?? new Error("No metadata")} />;
  return (
    <ListReport
      feature={feature.list}
      constraints={meta.data.fields}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.DocEntry ?? "")}
      readOnly
      // Unmounts with the selection, which closes any open preview — PrintActions releases its blob URL.
      toolbarActions={({ rows }) => (rows.length === 1
        ? <PrintActions entity={entity} docEntry={Number((rows[0] as Row).DocEntry)} />
        : null)}
    />
  );
}
