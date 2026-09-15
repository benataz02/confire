import { useCallback, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { listQuery, useListSpec, type ListColumn } from "../../../variants.ts";
import { ListReport } from "../../../components/ListReport.tsx";
import { confirm } from "../../../components/confirm.ts";
import { toast } from "../../../components/toast.ts";

export const Route = createFileRoute("/_authed/masterdata/")({ component: Masterdata });

// Tenant masterdata: one list for both kinds. A "table" keeps its values here, a "query" reads
// them live from SAP — models reference either by name and never hold the definition.

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "kind", type: "string", label: "Kind", options: [{ value: "Table", text: "Table" }, { value: "Query", text: "Query" }] },
  { name: "source", type: "string", label: "Source" },
  { name: "columnCount", type: "number", label: "Columns" },
  { name: "rowCount", type: "string", label: "Rows" },
  { name: "updatedAt", type: "date", label: "Last changed" },
];

function Masterdata() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // masterdata.list still exists — MasterdataEditor and useDraftModel need whole rows. This page
  // pages masterdata.rows, which returns only the six display columns, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.masterdata.rows.key() });
  };

  // kind/source/columnCount/rowCount used to be derived here; they are SQL expressions now, because
  // a saved view has to sort and filter on them across pages this page no longer holds.
  const listSpec = useListSpec("masterdata");
  const page = useInfiniteQuery({
    ...orpc.masterdata.rows.infiniteOptions({
      input: (skip: number | undefined) => ({ spec: listQuery(listSpec.spec), top: 100, ...(skip ? { skip } : {}) }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (last) => last.nextSkip,
    }),
    enabled: listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);

  const remove = useMutation(orpc.masterdata.remove.mutationOptions({ onSuccess: invalidate }));
  const duplicate = useMutation(
    orpc.masterdata.duplicate.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        toast("Table duplicated");
        void navigate({ to: "/masterdata/$id", params: { id: r.id } });
      },
    }),
  );

  const del = useCallback(
    async (sel: Record<string, unknown>[], clear: () => void) => {
      const one = sel.length === 1;
      // Masterdata is shared across models. The server refuses a table a model still references,
      // so the warning here is about the ones it will let through.
      const ok = await confirm({
        title: one ? "Delete table" : "Delete tables",
        message: one
          ? `Delete "${String(sel[0]!.name)}"? A table used by a model can't be deleted. This can't be undone.`
          : `Delete ${sel.length} tables? Tables used by a model can't be deleted. This can't be undone.`,
        actionText: "Delete",
        destructive: true,
      });
      if (!ok) return; // the user backed out; the selection stays as it was
      try {
        // One call, all-or-nothing: a referenced table refuses the whole batch and names itself.
        await remove.mutateAsync({ ids: sel.map((r) => String(r.id)) });
      } catch {
        return; // remove.error is on screen; keep the selection so it can be narrowed down
      }
      clear();
      toast(one ? "Table deleted" : `${sel.length} tables deleted`);
    },
    [remove],
  );

  return (
    <ListReport
      listSpec={listSpec}
      title="Masterdata"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={page.data?.pages[0]?.total ?? rows.length}
      loading={page.isFetching && !page.isFetchingNextPage}
      error={page.error ?? remove.error ?? duplicate.error}
      hasMore={page.hasNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
      onRowClick={(row) => navigate({ to: "/masterdata/$id", params: { id: String(row.id) } })}
      actions={({ rows: sel, clear }) => (
        <>
          <Button design="Transparent" onClick={() => navigate({ to: "/masterdata/new" })}>Create</Button>
          <Button design="Transparent" disabled={sel.length !== 1 || duplicate.isPending}
            onClick={() => duplicate.mutate({ id: String(sel[0]!.id) })}>
            Duplicate
          </Button>
          <Button design="Transparent" disabled={!sel.length || remove.isPending}
            onClick={() => void del(sel, clear)}>
            Delete
          </Button>
        </>
      )}
    />
  );
}
