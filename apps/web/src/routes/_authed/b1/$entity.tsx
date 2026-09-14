import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { listQuery, schemaColumns, useListSpec } from "../../../variants.ts";
import { ListReport } from "../../../components/ListReport.tsx";
import { PrintActions } from "../../../components/b1/PrintActions.tsx";

export const Route = createFileRoute("/_authed/b1/$entity")({ component: EntityList });

// Any B1 entity set as a list report. The saved view IS the query: the server compiles the same
// ListVariantDef into OData, so a variant behaves here exactly as it does on a local list.
// The columns come from the cached $metadata — nothing about the entity is hand-written.
function EntityList() {
  const { entity } = Route.useParams();
  const navigate = useNavigate();
  const schema = useQuery({
    ...orpc.entities.schema.queryOptions({ input: { entity } }),
    retry: false,
    // The server answers this from entity_meta in Postgres and never re-reads $metadata on its
    // own, so a day in the browser cache costs nothing: the Refresh button writes through with
    // setQueryData, and a reload falls back to the row.
    staleTime: 24 * 60 * 60_000,
  });
  const listSpec = useListSpec(`b1:${entity}`);
  const columns = useMemo(() => schemaColumns(schema.data?.fields ?? []), [schema.data]);

  // Two things worth knowing about this input:
  //  - listQuery, not the spec itself: widths and labels live in the same document and the whole
  //    document is the infinite-query key, so sending them raw made a column resize refetch page 1.
  //  - the cursor is B1's own @odata.nextLink, sealed server-side. The browser never computes an
  //    offset and never sees a Service Layer URL; page size is B1_PAGE_SIZE, not ours to pick.
  const pageInput = (cursor: string | undefined) =>
    ({ entity, spec: listQuery(listSpec.spec), ...(cursor ? { cursor } : { count: true }) });
  const page = useInfiniteQuery({
    ...orpc.entities.rows.infiniteOptions({
      input: pageInput,
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor,
    }),
    // Both gates matter: no schema means no column names to compile against, and an unapplied
    // view would fire one render's worth of requests carrying the previous entity's fields.
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
        // A composite key travels as JSON so one route param can carry both halves.
        const key = keys.length === 1 ? String(row[keys[0]!] ?? "") : JSON.stringify(Object.fromEntries(keys.map((k) => [k, row[k]])));
        if (!key) return;
        void navigate({ to: "/b1/$entity/$key", params: { entity, key } });
      }}
      actions={({ rows: sel }) => (
        /* Unmounts with the selection, which closes any open preview — the blob URL is released
           by PrintActions' own cleanup, so there is nothing to tear down here. */
        sel.length === 1 ? <PrintActions entity={entity} docEntry={Number(sel[0]!.DocEntry)} /> : null
      )}
    />
  );
}
