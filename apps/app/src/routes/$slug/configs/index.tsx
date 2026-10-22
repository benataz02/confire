import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ObjectStatus, Text } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { projectStatusText, statusUi } from "../../../components/configurator/runView.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../../../i18n.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

export const Route = createFileRoute("/$slug/configs/")({ component: Configs });

function Configs() {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
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
  const statuses = statusUi(t);
  // The bundle object is stable across a language switch; the strings are not, so they are the deps.
  const title = t("CONFIG_LIST_TITLE");
  const colName = t("CONFIG_COL_NAME");
  const colModel = t("CONFIG_COL_MODEL");
  const colCustomer = t("CONFIG_COL_CUSTOMER");
  const colStatus = t("CONFIG_COL_STATUS");
  const colUpdated = t("CONFIG_COL_UPDATED");
  const draftText = statuses.draft.text;
  const quotedText = statuses.quoted.text;
  const feature = useMemo<ListFeature>(() => ({
    // `customer` is jsonb; the server flattens it to customerName so it filters, sorts and searches
    // like any other column.
    tableId: "configs",
    title,
    columns: [
      { key: "name", label: colName, type: "string" },
      { key: "modelName", label: colModel, type: "string", groupable: true },
      { key: "customerName", label: colCustomer, type: "string", groupable: true },
      {
        key: "status", label: colStatus, type: "enum", groupable: true,
        options: [
          { value: "draft", label: draftText },
          { value: "quoted", label: quotedText },
        ],
      },
      { key: "updatedAt", label: colUpdated, type: "date" },
    ],
    filterFields: [{ key: "name" }, { key: "customerName" }, { key: "status" }],
  }), [title, colName, colModel, colCustomer, colStatus, colUpdated, draftText, quotedText]);
  const cells = useMemo(() => ({
    status: (row: Row) => {
      const known = statusUi(t)[row.status as "draft" | "quoted"];
      return known
        ? <ObjectStatus inverted state={known.state}>{known.text}</ObjectStatus>
        : <Text>{projectStatusText(t, String(row.status ?? ""))}</Text>;
    },
  // `t` is a new function each render; the status words change only with the language.
  }), [draftText, quotedText]);

  return (
    <ListReport
      feature={feature}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      cellTemplates={cells}
      error={remove.error ?? duplicate.error}
      toolbarActions={({ rows: sel, clear }) => {
        const quotedSel = sel.some((r) => r.status === "quoted");
        return (
          <>
            <Button design="Transparent" disabled={!first}
              tooltip={first ? undefined : t("CONFIG_NO_MODELS")}
              onClick={() => { void navigate({ to: "/$slug/configs/new" }); }}>
              {t("CONFIG_NEW")}
            </Button>
            <Button design="Transparent" disabled={sel.length !== 1 || duplicate.isPending}
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
