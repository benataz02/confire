import { useCallback, useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button, ObjectStatus, Text,
} from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { listQuery, useListSpec, type ListColumn } from "../../../variants.ts";
import { ListReport } from "../../../components/ListReport.tsx";
import { statusUi } from "../../../components/configurator/runView.ts";
import { confirm } from "../../../components/confirm.ts";
import { toast } from "../../../components/toast.ts";

export const Route = createFileRoute("/_authed/configs/")({ component: Configs });

// Read the value off `cell`, not the documented top-level `value` prop: AnalyticalTable's
// CellInstance Omit<>s over an index signature, which erases the flattened props from the type.
// Both exist at runtime; only this one type-checks.
const StatusCell = ({ cell }: { cell: { value?: unknown } }) => {
  const ui = statusUi[cell.value as keyof typeof statusUi];
  return ui ? <ObjectStatus inverted state={ui.state}>{ui.text}</ObjectStatus> : <Text>{String(cell.value ?? "")}</Text>;
};

// `customer` is jsonb; the server flattens it to customerName so it can be filtered/sorted/searched
// like any other column instead of needing its own cell renderer.
const COLUMNS: ListColumn[] = [
  { name: "name", type: "string", label: "Name" },
  { name: "modelName", type: "string", label: "Model" },
  { name: "customerName", type: "string", label: "Customer" },
  {
    name: "status",
    type: "enum",
    label: "Status",
    options: Object.entries(statusUi).map(([value, ui]) => ({ value, text: ui.text })),
    Cell: StatusCell,
  },
  { name: "updatedAt", type: "date", label: "Last changed" },
];

function Configs() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery(orpc.configs.models.queryOptions());
  // configs.list still exists for GlobalSearch; this page pages configs.rows, so both keys go.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: orpc.configs.list.queryOptions().queryKey });
    void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
  };

  // The saved view IS the query: it compiles to SQL server-side, exactly as it compiles to OData for
  // a B1 entity list. The old Requested/In-progress SegmentedButton is the seeded shared "Requested" view.
  const listSpec = useListSpec("configs");
  const page = useInfiniteQuery({
    ...orpc.configs.rows.infiniteOptions({
      input: (skip: number | undefined) => ({ spec: listQuery(listSpec.spec), top: 100, ...(skip ? { skip } : {}) }),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: (last) => last.nextSkip,
    }),
    enabled: listSpec.ready,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => (page.data?.pages ?? []).flatMap((p) => p.rows), [page.data]);

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
    async (sel: Record<string, unknown>[], clear: () => void) => {
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
      listSpec={listSpec}
      title="Configurations"
      columns={COLUMNS}
      keyField="id"
      rows={rows}
      total={page.data?.pages[0]?.total ?? rows.length}
      loading={page.isFetching && !page.isFetchingNextPage}
      error={page.error ?? remove.error ?? duplicate.error}
      hasMore={page.hasNextPage}
      onLoadMore={() => { if (!page.isFetchingNextPage) void page.fetchNextPage(); }}
      onRowClick={(row) => navigate({ to: "/configs/$id", params: { id: String(row.id) } })}
      actions={({ rows: sel, clear }) => {
        const quotedSel = sel.some((r) => r.status === "quoted");
        return (
          <>
            <Button
              design="Transparent"
              disabled={!first}
              tooltip={first ? undefined : "No configurator models yet — an admin creates those first."}
              onClick={() => { void navigate({ to: "/configs/new" }); }}
            >
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
