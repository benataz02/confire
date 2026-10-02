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

export const Route = createFileRoute("/_authed/models/")({ component: Models });

const FEATURE: ListFeature = {
  tableId: "models",
  title: "Models",
  columns: [
    { key: "name", label: "Name", type: "string" },
    { key: "updatedAt", label: "Last changed", type: "date" },
  ],
  filterFields: [{ key: "name" }],
};

function Models() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // models.list still exists for GlobalSearch; this page pages models.rows, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.models.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.models.rows.key() });
  };

  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.models.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/models", keyOf: (r) => r.id },
  );

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
    async (sel: Row[], clear: () => void) => {
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
      feature={FEATURE}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      error={remove.error ?? duplicate.error}
      toolbarActions={({ rows: sel, clear }) => (
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
