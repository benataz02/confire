import { useCallback, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { listQuery, useListSpec, type ListColumn } from "../../../variants.ts";
import { ListReport } from "../../../components/ListReport.tsx";
import { confirm } from "../../../components/confirm.ts";
import { toast } from "../../../components/toast.ts";

export const Route = createFileRoute("/_authed/models/")({ component: Models });

const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "updatedAt", type: "date", label: "Last changed" },
];

function Models() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // models.list still exists for GlobalSearch; this page pages models.rows, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
  };

  // The saved view IS the query: it compiles to SQL server-side, as it compiles to OData for B1.
  const listSpec = useListSpec("models");
  const page = useInfiniteQuery({
    ...orpc.models.rows.infiniteOptions({
      input: (skip: number | undefined) => ({ spec: listQuery(listSpec.spec), top: 100, ...(skip ? { skip } : {}) }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (last) => last.nextSkip,
    }),
    enabled: listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);

  const remove = useMutation(orpc.models.remove.mutationOptions({ onSuccess: invalidate }));
  const duplicate = useMutation(
    orpc.models.duplicate.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        toast("Model duplicated");
        void navigate({ to: "/models/$id", params: { id: r.id } });
      },
    }),
  );

  const del = useCallback(
    async (sel: Record<string, unknown>[], clear: () => void) => {
      const one = sel.length === 1;
      // The server still refuses deleting in-use models; this guards accidental clicks on unused ones.
      const ok = await confirm({
        title: one ? "Delete model" : "Delete models",
        message: one
          ? `Delete "${String(sel[0]!.name)}"? This can't be undone.`
          : `Delete ${sel.length} models? This can't be undone.`,
        actionText: "Delete",
        destructive: true,
      });
      if (!ok) return; // the user backed out; the selection stays as it was
      try {
        // One call, all-or-nothing: an in-use model refuses the whole batch and names itself.
        await remove.mutateAsync({ ids: sel.map((r) => String(r.id)) });
      } catch {
        return; // remove.error is on screen; keep the selection so it can be narrowed down
      }
      clear();
      toast(one ? "Model deleted" : `${sel.length} models deleted`);
    },
    [remove],
  );

  return (
    <ListReport
      listSpec={listSpec}
      title="Models"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={page.data?.pages[0]?.total ?? rows.length}
      loading={page.isFetching && !page.isFetchingNextPage}
      error={page.error ?? remove.error ?? duplicate.error}
      hasMore={page.hasNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
      onRowClick={(row) => navigate({ to: "/models/$id", params: { id: String(row.id) } })}
      actions={({ rows: sel, clear }) => (
        <>
          <Button design="Transparent" onClick={() => { void navigate({ to: "/models/new" }); }}>New model</Button>
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
