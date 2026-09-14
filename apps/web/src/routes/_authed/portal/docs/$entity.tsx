import { useMemo } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { orpc } from "../../../../orpc.ts";
import { listQuery, schemaColumns, useListSpec } from "../../../../variants.ts";
import { ListReport } from "../../../../components/ListReport.tsx";
import { PrintActions } from "../../../../components/b1/PrintActions.tsx";

// The four document sets a portal client may browse. The server fences this independently
// (portal.docs's PORTAL_ENTITIES); this guard only keeps a typo out of the URL bar.
const PORTAL_ENTITIES = new Set(["Quotations", "Orders", "DeliveryNotes", "Invoices"]);

export const Route = createFileRoute("/_authed/portal/docs/$entity")({
  beforeLoad: ({ params }) => {
    if (!PORTAL_ENTITIES.has(params.entity)) throw redirect({ to: "/portal" });
  },
  component: PortalDocs,
});

function PortalDocs() {
  const { entity } = Route.useParams();
  const navigate = useNavigate();
  const schema = useQuery({
    ...orpc.portal.docs.schema.queryOptions({ input: { entity } }),
    retry: false,
    staleTime: 24 * 60 * 60_000,
  });
  const listSpec = useListSpec(`portal:${entity}`);
  const columns = useMemo(() => schemaColumns(schema.data?.fields ?? []), [schema.data]);

  // listQuery, not the spec itself: widths and labels live in the same document and the whole
  // document is the infinite-query key, so sending them raw made a column resize refetch page 1.
  // The cursor is B1's own @odata.nextLink, sealed server-side.
  const pageInput = (cursor: string | undefined) =>
    ({ entity, spec: listQuery(listSpec.spec), ...(cursor ? { cursor } : { count: true }) });
  const page = useInfiniteQuery({
    ...orpc.portal.docs.rows.infiniteOptions({
      input: pageInput,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor,
    }),
    enabled: !!schema.data && listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);

  if (schema.isPending) return <BusyIndicator active delay={0} />;
  if (schema.error) return <MessageStrip design="Negative" hideCloseButton>{schema.error.message}</MessageStrip>;

  const keys = schema.data!.keys;
  return (
    <ListReport
      listSpec={listSpec}
      title={schema.data!.label}
      columns={columns}
      keyField={keys[0] ?? ""}
      rows={rows}
      total={page.data?.pages[0]?.total ?? rows.length}
      loading={page.isFetching && !page.isFetchingNextPage}
      error={page.error}
      hasMore={page.hasNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
      onRowClick={(row) => {
        const key = keys.length === 1 ? String(row[keys[0]!] ?? "") : JSON.stringify(Object.fromEntries(keys.map((k) => [k, row[k]])));
        if (!key) return;
        void navigate({ to: "/portal/docs/$entity/$key", params: { entity, key } });
      }}
      actions={({ rows: sel }) =>
        sel.length === 1 ? <PrintActions entity={entity} docEntry={Number(sel[0]!.DocEntry)} scope="portal" /> : null
      }
    />
  );
}
