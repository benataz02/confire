import { useCallback, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "../../../shared/list-report/ListReport.tsx";
import { useListView } from "../../../shared/useListView.ts";
import { confirm } from "../../../components/confirm.ts";
import { toast } from "../../../components/toast.ts";
import type { ListFeature, ListQuery, Row } from "../../../shared/types.ts";

export const Route = createFileRoute("/_authed/masterdata/")({ component: Masterdata });

// Tenant masterdata: one list for both kinds. A "table" keeps its values here, a "query" caches
// them from SAP on a sync — models reference either by name and never hold the definition.
// kind/source/columnCount/rowCount are SQL expressions server-side, so a view can sort and filter
// on them across pages.
const FEATURE: ListFeature = {
  tableId: "masterdata",
  title: "Masterdata",
  columns: [
    { key: "name", label: "Name", type: "string" },
    { key: "kind", label: "Kind", type: "string", groupable: true, options: [{ value: "Table", label: "Table" }, { value: "Query", label: "Query" }] },
    { key: "source", label: "Source", type: "string" },
    { key: "columnCount", label: "Columns", type: "number" },
    { key: "rowCount", label: "Rows", type: "string" },
    // A query's rows are a cache, so how old they are is a property worth sorting on.
    { key: "syncedAt", label: "Last synced", type: "date" },
    { key: "updatedAt", label: "Last changed", type: "date" },
  ],
  filterFields: [{ key: "name" }, { key: "kind" }],
};

function Masterdata() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // masterdata.list still exists — MasterdataEditor and useDraftModel need whole rows. This page
  // pages masterdata.rows, which returns only the display columns, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.masterdata.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.masterdata.rows.key() });
  };

  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.masterdata.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/masterdata", keyOf: (r) => r.id },
  );

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
    async (sel: Row[], clear: () => void) => {
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
      feature={FEATURE}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      error={remove.error ?? duplicate.error}
      toolbarActions={({ rows: sel, clear }) => (
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
