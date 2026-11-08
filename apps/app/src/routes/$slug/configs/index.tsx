import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { t, title } from "../../../head.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { viewsQuery } from "@confire/ui/views.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { projectStatusOptions } from "@confire/ui/timeline/projectStatus.ts";
import { ProjectStatusCell } from "@confire/ui/timeline/ProjectStatus.tsx";
import { EntityLink } from "@confire/ui/EntityLink.tsx";
import { useUiI18n } from "@confire/ui/i18n.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../../i18n.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

export const Route = createFileRoute("/$slug/configs/")({
  head: () => title(t("NAV_CONFIGS")),
  // A hovered link (a home tile, a row's link) warms the views the list waits on, never awaited.
  loader: ({ context }) => void context.queryClient.prefetchQuery(viewsQuery(orpc, "configs")),
  component: Configs,
});

const CELLS = {
  status: (row: Row) => <ProjectStatusCell status={row.status} />,
  // The last document opens on its own entity's page (an order, a delivery…), so the route is the row's.
  docNum: (row: Row) => row.docNum == null ? null : (
    <EntityLink route={`/b1/${String(row.docEntity)}`} target={String(row.docEntry)}>{String(row.docNum)}</EntityLink>
  ),
};

function Configs() {
  const i18n = useI18n();
  const ui = useUiI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const qc = useQueryClient();
  const models = useQuery(orpc.configs.models.queryOptions());
  const invalidate = () => {
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
    { route: "/configs", keyOf: (r) => r.id, create: "/configs/new" },
  );

  const remove = useMutation(orpc.configs.remove.mutationOptions({ onSuccess: invalidate }));
  // Slower than the other two duplicates: the server recalculates the copy against live SAP before
  // it answers, which is why the button carries a pending label rather than just a disabled state.
  const duplicate = useMutation(
    orpc.configs.duplicate.mutationOptions({
      onSuccess: (r) => {
        invalidate();
        toast(t("CONFIG_TOAST_DUPLICATED"));
        void navigate({ to: "/$slug/configs/$id", params: { id: r.id } });
      },
    }),
  );

  const del = useCallback(
    async (sel: Row[], clear: () => void) => {
      const one = sel.length === 1;
      const ok = await confirm({
        title: one ? t("CONFIG_DELETE_TITLE") : t("CONFIG_DELETE_TITLE_MANY"),
        message: one
          ? t("CONFIG_DELETE_ONE_RUNS", String(sel[0]!.name))
          : t("CONFIG_DELETE_MANY", String(sel.length)),
        actionText: t("CONFIG_DELETE"),
        destructive: true,
      });
      if (!ok) return; // the user backed out; the selection stays as it was
      try {
        await remove.mutateAsync({ ids: sel.map((r) => String(r.id)) });
      } catch {
        return; // remove.error is on screen; keep the selection so it can be narrowed down
      }
      clear();
      toast(one ? t("CONFIG_TOAST_DELETED") : t("CONFIG_TOAST_DELETED_MANY", String(sel.length)));
    },
    [remove, i18n],
  );

  const first = models.data?.[0]?.id;
  // The bundle object is stable across a language switch; the strings are not, so they are the deps.
  const title = t("CONFIG_LIST_TITLE");
  const colName = t("CONFIG_COL_NAME");
  const colModel = t("CONFIG_COL_MODEL");
  const colCustomer = t("CONFIG_COL_CUSTOMER");
  const colCardCode = t("CONFIG_COL_CARD_CODE");
  const colDocument = t("CONFIG_COL_DOCUMENT");
  const colStatus = t("CONFIG_COL_STATUS");
  const colUpdated = t("CONFIG_COL_UPDATED");
  const colMine = t("CONFIG_COL_MINE");
  const yes = t("ADMIN_YES");
  const no = t("ADMIN_NO");
  const statusOptions = projectStatusOptions((k) => ui.getText(k));
  const feature = useMemo<ListFeature>(() => ({
    // `customer` is jsonb; the server flattens it to customerName so it filters, sorts and searches
    // like any other column.
    tableId: "configs",
    title,
    columns: [
      { key: "name", label: colName, type: "string" },
      { key: "modelName", label: colModel, type: "string", groupable: true },
      { key: "cardCode", label: colCardCode, type: "string", linkConfig: { route: "/b1/BusinessPartners" } },
      { key: "customerName", label: colCustomer, type: "string", groupable: true },
      { key: "status", label: colStatus, type: "enum", groupable: true, options: statusOptions },
      // The status's SAP document (order, delivery, invoice), else the quotation: the DocNum, opened by
      // DocEntry (CELLS); the server leaves it empty for another company's document.
      { key: "docNum", label: colDocument, type: "number", integer: true },
      { key: "updatedAt", label: colUpdated, type: "date" },
      // The server computes it per caller: the home page's "My drafts" links here with ?mine=yes.
      { key: "mine", label: colMine, type: "enum", options: [{ value: "yes", label: yes }, { value: "no", label: no }], hidden: true },
    ],
    filterFields: [{ key: "name" }, { key: "customerName" }, { key: "status" }],
  // The status words change with the language, as `title` does.
  }), [title, colName, colModel, colCardCode, colCustomer, colDocument, colStatus, colUpdated, colMine, yes, no]);

  return (
    <ListReport
      feature={feature}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      cellTemplates={CELLS}
      error={remove.error ?? duplicate.error}
      createDisabled={first ? undefined : t("CONFIG_NO_MODELS")}
      toolbarActions={({ rows: sel, clear }) => {
        const quotedSel = sel.some((r) => r.status === "quoted");
        return (
          <>
            <Button icon="copy" design="Transparent" disabled={sel.length !== 1 || duplicate.isPending}
              onClick={() => duplicate.mutate({ id: String(sel[0]!.id) })}>
              {duplicate.isPending ? t("CONFIG_DUPLICATING") : t("CONFIG_DUPLICATE")}
            </Button>
            <Button icon="delete" design="Transparent" disabled={!sel.length || quotedSel || remove.isPending}
              tooltip={quotedSel ? t("CONFIG_DELETE_LOCKED") : undefined}
              onClick={() => void del(sel, clear)}>
              {t("CONFIG_DELETE")}
            </Button>
          </>
        );
      }}
    />
  );
}
