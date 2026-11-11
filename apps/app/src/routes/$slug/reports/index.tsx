import { useCallback, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui5/webcomponents-react";
import { t, title } from "../../../head.ts";
import { useI18n } from "../../../i18n.ts";
import { client, orpc } from "../../../orpc.ts";
import { viewsQuery } from "@confire/ui/views.ts";
import { ListReport } from "@confire/ui/list-report/ListReport.tsx";
import { useListView } from "@confire/ui/useListView.ts";
import { confirm } from "@confire/ui/confirm.ts";
import type { ListFeature, ListQuery, Row } from "@confire/ui/types.ts";

type TextFn = (key: string, ...args: Array<string | number>) => string;

const reportsFeature = (t: TextFn): ListFeature => ({
  tableId: "reports",
  title: t("HOME_REPORTS"),
  columns: [
    { key: "title", label: t("REPORTS_TITLE"), type: "string" },
    { key: "subtitle", label: t("REPORTS_SUBTITLE"), type: "string" },
    { key: "saved", label: t("REPORTS_ON_HOME"), type: "boolean", sortable: false },
    { key: "updatedAt", label: t("REPORTS_UPDATED"), type: "date" },
    { key: "createdAt", label: t("REPORTS_CREATED"), type: "date", hidden: true },
  ],
  filterFields: [{ key: "title" }],
});

export const Route = createFileRoute("/$slug/reports/")({
  head: () => title(t("HOME_REPORTS")),
  loader: ({ context }) => void context.queryClient.prefetchQuery(viewsQuery(orpc, "reports")),
  component: Reports,
});

// The user's reports (personal, like their chats). A report is made by its chat, so there is no
// Create here: a row opens the report, whose Edit opens that chat.
function Reports() {
  const i18n = useI18n();
  const t: TextFn = (key, ...args) => i18n.getText(key, ...args);
  const feature = useMemo(() => reportsFeature(t), [i18n]);
  const qc = useQueryClient();
  const [query, setQuery] = useState<ListQuery | null>(null);
  const data = useListView(
    {
      ...orpc.reports.rows.infiniteOptions({
        input: (skip: number | undefined) => ({ query: query!, top: 100, ...(skip ? { skip } : {}) }),
        initialPageParam: undefined as number | undefined,
        getNextPageParam: (last) => last.nextSkip,
      }),
      enabled: !!query,
    },
    { route: "/reports", keyOf: (r) => r.id },
  );
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  // As the report page's Delete: the chat goes with it (server side, under its lease).
  const del = useCallback(async (sel: Row[], clear: () => void) => {
    if (!await confirm({ message: t("REPORT_DELETE_CONFIRM"), actionText: t("REPORT_DELETE"), destructive: true })) return;
    setBusy(true);
    setError(null);
    try {
      for (const r of sel) await client.reports.delete({ id: String(r.id) });
      clear();
    } catch (e) {
      setError(e as Error); // THREAD_BUSY: a chat still answering; the rest stay selected
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: orpc.reports.key() });
      void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
      qc.removeQueries({ queryKey: orpc.assistant.thread.key() });
    }
  }, [i18n, qc]);

  return (
    <ListReport
      feature={feature}
      data={data}
      onQuery={setQuery}
      keyOf={(r) => String(r.id)}
      error={error}
      cellTemplates={{ title: (row) => String(row.title || t("REPORT_UNTITLED")) }}
      toolbarActions={({ rows: sel, clear }) => (
        <Button icon="delete" design="Transparent" disabled={!sel.length || busy} onClick={() => void del(sel, clear)}>
          {t("REPORT_DELETE")}
        </Button>
      )}
    />
  );
}
