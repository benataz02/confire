import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BusyIndicator, FlexBox, MessageStrip, ToolbarButton } from "@ui5/webcomponents-react";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import type { FilterValue } from "@confire/ui/types.ts";
import { useI18n } from "../i18n.ts";
import { client, orpc } from "../orpc.ts";
import { useAssistantShell } from "../assistant/shell.ts";
import { refusalText } from "../assistant/ChatView.tsx";
import type { Thread } from "../assistant/useAssistant.ts";
import { ReportView } from "./ReportView.tsx";
import type { Result } from "./widgets.ts";

// A report's page (Joule spec §5.8): the report alone, live on open. Its chat is the assistant panel
// (the panel finds it through the report, `threadInput`): *Edit* and a chip open it, and the panel's
// report_set invalidates `reports.get`, which brings the new definition here.

export function ReportPage({ id }: { id: string }) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const qc = useQueryClient();
  const shell = useAssistantShell();
  const navigate = useNavigate({ from: "/$slug" });
  const report = useQuery(orpc.reports.get.queryOptions({ input: { id } }));
  const definition = report.data?.definition;

  // Live on open: the stored result shows at once, SAP's answer replaces it.
  const [live, setLive] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Each new definition and each run is a new generation: a live run that started before one is not drawn over it.
  const generation = useRef(0);
  // The filter bar's values, kept for Refresh; none = the definition's defaults.
  const filters = useRef<Record<string, FilterValue> | undefined>(undefined);
  const runLive = async () => {
    const g = ++generation.current; // a later Go wins over a run still answering
    setBusy(true);
    setFailed(null);
    try {
      const r = await client.reports.run({ id, filters: filters.current });
      if (g === generation.current) setLive(r);
      void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
    } catch (e) {
      setFailed(refusalText(i18n, e));
    } finally {
      setBusy(false);
    }
  };
  // The definition the page opened with runs live, once. A later one is the chat's report_set, which
  // stored its own run: shown as stored, on its own defaults. "Later" is by reference — TanStack Query's
  // structural sharing keeps the definition's reference until its content really changes.
  const seen = useRef<{ def: unknown } | null>(null);
  useEffect(() => {
    if (!report.data) return;
    if (!seen.current) {
      seen.current = { def: definition };
      if (definition) void runLive();
      else shell.openChat(); // nothing drafted: the chat is where it gets drafted
      return;
    }
    if (seen.current.def === definition) return;
    seen.current.def = definition;
    generation.current++;
    filters.current = undefined;
    setLive(null);
    setFailed(null);
  }, [report.data, definition]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { toast(refusalText(i18n, e)); }
    void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
    void qc.invalidateQueries({ queryKey: orpc.reports.get.key({ input: { id } }) });
    void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
  };
  const renameReport = async () => {
    const title = await promptNote({ title: t("REPORT_RENAME"), message: report.data?.title ?? "", actionText: t("REPORT_RENAME"), label: t("REPORT_RENAME") });
    if (title?.trim()) void act(() => client.reports.rename({ id, title: title.trim() }));
  };
  // Deleting the report deletes its chat: every cached copy of that thread goes, none may come back as a chat.
  const removeReport = async () => {
    if (!await confirm({ message: t("REPORT_DELETE_CONFIRM"), actionText: t("REPORT_DELETE"), destructive: true })) return;
    const threadId = report.data?.threadId;
    await act(async () => {
      await client.reports.delete({ id });
      qc.removeQueries({ queryKey: orpc.assistant.thread.key(), predicate: (x) => (x.state.data as Thread | undefined)?.id === threadId });
      void navigate({ to: "/$slug" });
    });
  };

  // The report view's Toolbar puts these behind its own overflow button: no Menu of ours to manage.
  const actions = (
    <>
      <ToolbarButton overflowPriority="NeverOverflow" design="Emphasized" text={t("REPORT_EDIT")} onClick={() => shell.openChat()} />
      <ToolbarButton overflowPriority="AlwaysOverflow" icon="edit" text={t("REPORT_RENAME")}
        accessibilityAttributes={{ hasPopup: "dialog" }} onClick={() => void renameReport()} />
      <ToolbarButton overflowPriority="AlwaysOverflow" icon="delete" text={t("REPORT_DELETE")}
        accessibilityAttributes={{ hasPopup: "dialog" }} onClick={() => void removeReport()} />
    </>
  );

  if (report.error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, report.error)}</MessageStrip>;
  // margin: auto centres only inside a flex box, which the route's outlet is not.
  if (!report.data) return <FlexBox fitContainer justifyContent="Center" alignItems="Center"><BusyIndicator active /></FlexBox>;
  if (!report.data.definition) return <MessageStrip design="Information" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{t("REPORT_NOTHING_YET")}</MessageStrip>;
  return (
    <div style={{ height: "100%", overflowY: "auto", background: "var(--sapBackgroundColor)" }}>
      <ReportView report={report.data} result={live ?? report.data.lastResult} busy={busy} failed={failed} actions={actions}
        // The assumption chips help edit: shown only while editing, i.e. with the chat open.
        onChip={shell.open ? (label) => shell.openChat(t("REPORT_CHANGE_CHIP", label)) : undefined} onRefresh={() => void runLive()}
        onSave={(saved) => void act(() => client.reports.save({ id, saved }))}
        onFilter={(values) => { filters.current = values; void runLive(); }} />
    </div>
  );
}
