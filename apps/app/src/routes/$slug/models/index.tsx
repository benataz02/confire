import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { orpc } from "../../../orpc.ts";
import { useI18n } from "../../../i18n.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

export const Route = createFileRoute("/$slug/models/")({ component: Models });

function Models() {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const feature = useMemo<ListFeature>(() => ({
    tableId: "models",
    title: i18n.getText("MODEL_LIST_TITLE"),
    columns: [
      { key: "name", label: i18n.getText("MODEL_NAME"), type: "string" },
      { key: "updatedAt", label: i18n.getText("MODEL_LAST_CHANGED"), type: "date" },
    ],
    filterFields: [{ key: "name" }],
  }), [i18n]);
  const navigate = useNavigate({ from: "/$slug" });
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
        toast(t("MODEL_TOAST_DUPLICATED"));
        void navigate({ to: "/$slug/models/$id", params: { id: r.id } });
      },
    }),
  );

  const del = useCallback(
    async (sel: Row[], clear: () => void) => {
      const one = sel.length === 1;
      // The server still refuses deleting in-use models; this guards accidental clicks on unused ones.
      const ok = await confirm({
        title: one ? t("MODEL_DELETE_TITLE") : t("MODEL_DELETE_TITLE_N"),
        message: one
          ? t("MODEL_DELETE_ONE", String(sel[0]!.name))
          : t("MODEL_DELETE_N", String(sel.length)),
        actionText: t("MODEL_DELETE"),
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
      toast(one ? t("MODEL_TOAST_DELETED") : t("MODEL_TOAST_DELETED_N", String(sel.length)));
    },
    [remove, t],
  );

  return (
    <ListReport
      feature={feature}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      error={remove.error ?? duplicate.error}
      toolbarActions={({ rows: sel, clear }) => (
        <>
          <Button design="Transparent" onClick={() => { void navigate({ to: "/$slug/models/new" }); }}>{t("MODEL_NEW")}</Button>
          <Button design="Transparent" disabled={sel.length !== 1 || duplicate.isPending}
            onClick={() => duplicate.mutate({ id: String(sel[0]!.id) })}>
            {t("MODEL_DUPLICATE")}
          </Button>
          <Button design="Transparent" disabled={!sel.length || remove.isPending}
            onClick={() => void del(sel, clear)}>
            {t("MODEL_DELETE")}
          </Button>
        </>
      )}
    />
  );
}
