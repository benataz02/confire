import { useCallback, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ObjectStatus, Text } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "../../../shared/list-report/ListReport.tsx";
import { useListView } from "../../../shared/useListView.ts";
import { statusUi } from "../../../components/configurator/runView.ts";
import { confirm } from "../../../components/confirm.ts";
import { toast } from "../../../components/toast.ts";
import type { ListFeature, ListQuery, Row } from "../../../shared/types.ts";

export const Route = createFileRoute("/_authed/configs/")({ component: Configs });

// `customer` is jsonb; the server flattens it to customerName so it filters, sorts and searches
// like any other column. The old Requested/In-progress toggle is the declared "Requested" view.
const FEATURE: ListFeature = {
  tableId: "configs",
  title: "Configurations",
  columns: [
    { key: "name", label: "Name", type: "string" },
    { key: "modelName", label: "Model", type: "string", groupable: true },
    { key: "customerName", label: "Customer", type: "string", groupable: true },
    {
      key: "status", label: "Status", type: "enum", groupable: true,
      options: Object.entries(statusUi).map(([value, ui]) => ({ value, label: ui.text })),
    },
    { key: "updatedAt", label: "Last changed", type: "date" },
  ],
  filterFields: [{ key: "name" }, { key: "customerName" }, { key: "status" }],
  systemViews: [
    {
      key: "requested", name: "Requested",
      state: { filterValues: { status: ["requested"] }, sortBy: [{ field: "updatedAt", direction: "desc" }] },
    },
  ],
};

const statusCell = (row: Row) => {
  const ui = statusUi[row.status as keyof typeof statusUi];
  return ui ? <ObjectStatus inverted state={ui.state}>{ui.text}</ObjectStatus> : <Text>{String(row.status ?? "")}</Text>;
};
const CELLS = { status: statusCell };

function Configs() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery(orpc.configs.models.queryOptions());
  // configs.list still exists for GlobalSearch; this page pages configs.rows, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
  };

  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.configs.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/configs", keyOf: (r) => r.id },
  );

  const remove = useMutation(orpc.configs.remove.mutationOptions({ onSuccess: invalidate }));
  // Slower than the other two duplicates: the server recalculates the copy against live SAP before
  // it answers, which is why the button carries a pending label rather than just a disabled state.
  const duplicate = useMutation(
    orpc.configs.duplicate.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        toast("Configuration duplicated");
        void navigate({ to: "/configs/$id", params: { id: r.id } });
      },
    }),
  );

  const del = useCallback(
    async (sel: Row[], clear: () => void) => {
      const one = sel.length === 1;
      const ok = await confirm({
        title: one ? "Delete configuration" : "Delete configurations",
        message: one
          ? `Delete "${String(sel[0]!.name)}"? This also removes its calculation runs and can't be undone.`
          : `Delete ${sel.length} configurations? This also removes their calculation runs and can't be undone.`,
        actionText: "Delete",
        destructive: true,
      });
      if (!ok) return; // the user backed out; the selection stays as it was
      try {
        await remove.mutateAsync({ ids: sel.map((r) => String(r.id)) });
      } catch {
        return; // remove.error is on screen; keep the selection so it can be narrowed down
      }
      clear();
      toast(one ? "Configuration deleted" : `${sel.length} configurations deleted`);
    },
    [remove],
  );

  const first = models.data?.[0]?.id;

  return (
    <ListReport
      feature={FEATURE}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      cellTemplates={CELLS}
      error={remove.error ?? duplicate.error}
      toolbarActions={({ rows: sel, clear }) => {
        const quotedSel = sel.some((r) => r.status === "quoted");
        return (
          <>
            <Button design="Transparent" disabled={!first}
              tooltip={first ? undefined : "No configurator models yet — an admin creates those first."}
              onClick={() => { void navigate({ to: "/configs/new" }); }}>
              New configuration
            </Button>
            <Button design="Transparent" disabled={sel.length !== 1 || duplicate.isPending}
              onClick={() => duplicate.mutate({ id: String(sel[0]!.id) })}>
              {duplicate.isPending ? "Duplicating…" : "Duplicate"}
            </Button>
            <Button icon="delete" design="Transparent" disabled={!sel.length || quotedSel || remove.isPending}
              tooltip={quotedSel ? "A quoted configuration cannot be deleted" : undefined}
              onClick={() => void del(sel, clear)}>
              Delete
            </Button>
          </>
        );
      }}
    />
  );
}
