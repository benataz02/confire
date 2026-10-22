import { useCallback, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { useI18n } from "../../../i18n.ts";
import { orpc } from "../../../orpc.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { confirm } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

type TextFn = (key: string, ...args: Array<string | number>) => string;

function masterdataFeature(t: TextFn): ListFeature {
  return {
    tableId: "masterdata",
    title: t("NAV_MASTERDATA"),
    columns: [
      { key: "name", label: t("ADMIN_NAME"), type: "string" },
      { key: "kind", label: t("ADMIN_KIND"), type: "string", groupable: true, options: [{ value: "Table", label: t("ADMIN_KIND_TABLE") }, { value: "Query", label: t("ADMIN_KIND_QUERY") }] },
      { key: "source", label: t("ADMIN_SOURCE"), type: "string" },
      { key: "columnCount", label: t("ADMIN_COLUMNS"), type: "number" },
      { key: "rowCount", label: t("ADMIN_ROWS"), type: "string" },
      // A query's rows are a cache, so how old they are is a property worth sorting on.
      { key: "syncedAt", label: t("ADMIN_LAST_SYNCED"), type: "date" },
      { key: "updatedAt", label: t("ADMIN_LAST_CHANGED"), type: "date" },
    ],
    filterFields: [{ key: "name" }, { key: "kind" }],
  };
}

/** The Source column is composed in SQL (`Maintained here`, `B1 · Items`, `B1 · no entity set`). */
function sourceLabel(raw: string, t: TextFn): string {
  if (raw === "Maintained here") return t("ADMIN_MAINTAINED_HERE");
  const m = /^(B1|Beas) · (.*)$/.exec(raw);
  if (!m) return raw;
  const rest = m[2] === "no entity set" ? t("ADMIN_NO_ENTITY_SET") : m[2]!;
  return `${m[1]} · ${rest}`;
}

export const Route = createFileRoute("/$slug/masterdata/")({ component: Masterdata });

// Tenant masterdata: one list for both kinds. A "table" keeps its values here, a "query" caches
// them from SAP on a sync — models reference either by name and never hold the definition.
// kind/source/columnCount/rowCount are SQL expressions server-side, so a view can sort and filter
// on them across pages.
function Masterdata() {
  const i18n = useI18n();
  const t = (key: string, ...args: Array<string | number>) => i18n.getText(key, ...args);
  const feature = useMemo(() => masterdataFeature(t), [i18n]);
  const navigate = useNavigate({ from: "/$slug" });
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
        toast(t("ADMIN_TABLE_DUPLICATED"));
        void navigate({ to: "/$slug/masterdata/$id", params: { id: r.id } });
      },
    }),
  );

  const del = useCallback(
    async (sel: Row[], clear: () => void) => {
      const one = sel.length === 1;
      // Masterdata is shared across models. The server refuses a table a model still references,
      // so the warning here is about the ones it will let through.
      const ok = await confirm({
        title: t(one ? "ADMIN_DELETE_TABLE" : "ADMIN_DELETE_TABLES"),
        message: one
          ? t("ADMIN_DELETE_ONE", String(sel[0]!.name))
          : t("ADMIN_DELETE_MANY", sel.length),
        actionText: t("ADMIN_DELETE"),
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
      toast(one ? t("ADMIN_TABLE_DELETED") : t("ADMIN_TABLES_DELETED", sel.length));
    },
    [remove, i18n],
  );

  return (
    <ListReport
      feature={feature}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      error={remove.error ?? duplicate.error}
      cellTemplates={{ source: (row) => sourceLabel(String(row.source ?? ""), t) }}
      toolbarActions={({ rows: sel, clear }) => (
        <>
          <Button design="Transparent" onClick={() => navigate({ to: "/$slug/masterdata/new" })}>{t("ADMIN_CREATE")}</Button>
          <Button design="Transparent" disabled={sel.length !== 1 || duplicate.isPending}
            onClick={() => duplicate.mutate({ id: String(sel[0]!.id) })}>
            {t("ADMIN_DUPLICATE")}
          </Button>
          <Button design="Transparent" disabled={!sel.length || remove.isPending}
            onClick={() => void del(sel, clear)}>
            {t("ADMIN_DELETE")}
          </Button>
        </>
      )}
    />
  );
}
