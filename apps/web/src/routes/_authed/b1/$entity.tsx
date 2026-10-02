import { useMemo, useState } from "react";
import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, Toolbar, ToolbarButton } from "@ui5/webcomponents-react";
import { client, orpc } from "../../../orpc.ts";
import { b1Feature } from "../../../features/b1/index.ts";
import { ListReport } from "../../../shared/list-report/ListReport.tsx";
import { ObjectPage } from "../../../shared/object-page/ObjectPage.tsx";
import { ObjectPageSkeleton, PageError } from "../../../shared/object-page/ObjectPageSkeleton.tsx";
import { useFieldConstraints } from "../../../shared/metadata.ts";
import { useListView } from "../../../shared/useListView.ts";
import { useDetailView } from "../../../shared/useDetailView.ts";
import { PrintActions } from "../../../components/b1/PrintActions.tsx";
import type { EntityFeature, ListQuery, Row } from "../../../shared/types.ts";

// One declared B1 entity's list — or, with the `#create` fragment, its object page in create mode
// (Beas' createModeMatch: `/items#create` is the detail component, `/items` the list). Only the
// declared features have a page; any other entity set name goes home.

export const Route = createFileRoute("/_authed/b1/$entity")({
  beforeLoad: ({ params }) => {
    if (!b1Feature(params.entity)) throw redirect({ to: "/" });
  },
  component: EntityPage,
});

function EntityPage() {
  const { entity } = Route.useParams();
  const hash = useLocation({ select: (l) => l.hash });
  const feature = b1Feature(entity)!;
  return hash === "create" ? <EntityCreate key={entity} feature={feature} /> : <EntityList key={entity} feature={feature} />;
}

const NO_QUERY: ListQuery = { select: [], filter: [], orderby: [] };

function EntityList({ feature }: { feature: EntityFeature }) {
  const { entity } = feature;
  const qc = useQueryClient();
  const meta = useFieldConstraints(entity);
  const [query, setQuery] = useState<ListQuery | null>(null);
  // The cursor is B1's own @odata.nextLink, sealed server-side; page 1 also asks for the count.
  const data = useListView(
    {
      ...orpc.entities.rows.infiniteOptions({
        input: (cursor: string | undefined) => ({ entity, query: query ?? NO_QUERY, ...(cursor ? { cursor } : { count: true }) }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor,
      }),
      enabled: !!query && !!meta.data,
    },
    { route: `/b1/${entity}`, keyOf: (r) => r[feature.keyField], create: true },
  );
  // The server never re-reads $metadata on its own (a UDF added in B1 waits for this button).
  const refresh = useMutation({
    mutationFn: () => client.entities.metadata({ entity, refresh: true }),
    onSuccess: (fresh) => qc.setQueryData(orpc.entities.metadata.queryOptions({ input: { entity } }).queryKey, fresh),
  });

  if (meta.isPending) return <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  if (meta.error) return <PageError error={meta.error} />;
  const printable = meta.data.printable;

  return (
    <ListReport
      feature={feature.list}
      constraints={meta.data.fields}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r[feature.keyField] ?? "")}
      readOnly={!meta.data.writable}
      error={refresh.error}
      headerActions={
        <Toolbar design="Transparent">
          <ToolbarButton design="Transparent" icon="refresh" tooltip="Refresh SAP fields" accessibleName="Refresh SAP fields"
            disabled={refresh.isPending} onClick={() => refresh.mutate()} />
        </Toolbar>
      }
      toolbarActions={printable ? ({ rows }) => (
        // Unmounts with the selection, which closes any open preview — PrintActions releases the
        // blob URL in its own cleanup.
        rows.length === 1 ? <PrintActions entity={entity} docEntry={Number((rows[0] as Row).DocEntry)} /> : null
      ) : undefined}
    />
  );
}

function EntityCreate({ feature }: { feature: EntityFeature }) {
  const navigate = useNavigate();
  const route = `/b1/${feature.entity}`;
  const d = useDetailView({ entity: feature.entity, route, isNew: true });
  // Fresh per "Create and new": the epoch is what makes a new, empty record.
  const seed = useMemo(() => feature.detail.createDefaults?.() ?? {}, [feature, d.createEpoch]);

  if (d.loading) return <ObjectPageSkeleton />;
  if (d.error || !d.constraints) return <PageError error={d.error ?? new Error("No metadata")} />;
  if (!d.constraints.writable) return <PageError error={new Error(`${d.constraints.label} is read-only in Confire.`)} />;
  return (
    <ObjectPage key={d.createEpoch} isNew entity={feature.entity} constraints={d.constraints} data={seed}
      sections={feature.detail.sections} header={feature.detail.header}
      onSave={d.save} onCancelCreate={() => void navigate({ href: route })} />
  );
}
