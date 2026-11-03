import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BusyIndicator, Button, FlexBox, Menu, MenuItem, MessageStrip } from "@ui5/webcomponents-react";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import { useI18n } from "../i18n.ts";
import { client, orpc } from "../orpc.ts";
import { ChatView, refusalText, useRoute } from "../assistant/ChatView.tsx";
import { ReportView } from "./ReportView.tsx";
import type { Result } from "./widgets.ts";

// A report's page (reports spec §6.2): three states, one chat element through all of them. Ask — the
// chat alone, its banner and starters; build — the chat centred while it works; refine — once the
// first report_set result arrives the chat slides to the right (a view transition, as ChatView's own
// box) and the report grows in on its left. A saved report opens straight in the third.

const CHAT_WIDTH = 360;

export function ReportPage({ id }: { id: string }) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const qc = useQueryClient();
  const navigate = useNavigate({ from: "/$slug" });
  const route = useRoute();
  const report = useQuery(orpc.reports.get.queryOptions({ input: { id } }));
  const threadId = report.data?.threadId ?? "";
  const thread = useQuery({ ...orpc.assistant.thread.queryOptions({ input: { id: threadId } }), enabled: !!threadId, staleTime: Infinity });

  const [docked, setDocked] = useState<boolean | null>(null);
  useEffect(() => { if (report.data && docked === null) setDocked(!!report.data.definition); }, [report.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live on open: the stored result shows at once, SAP's answer replaces it.
  const [live, setLive] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Each report_set is a new generation: a live run that started before one is not drawn over it.
  const generation = useRef(0);
  const runLive = async () => {
    const g = generation.current;
    setBusy(true);
    setFailed(null);
    try {
      const r = await client.reports.run({ id });
      if (g === generation.current) setLive(r);
      void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
    } catch (e) {
      setFailed(refusalText(i18n, e));
    } finally {
      setBusy(false);
    }
  };
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || !report.data?.definition) return;
    ran.current = true;
    void runLive();
  }, [report.data?.definition]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The chat changed the report: show what it stored, docking the chat the first time there is a
   *  report to show — a refused first call (the model fixes and calls again) docks nothing. */
  const dockedNow = useRef(false);
  dockedNow.current = !!docked;
  const onTool = (name: string) => {
    if (name !== "report_set") return;
    generation.current++;
    ran.current = true; // what report_set stored is already live
    setLive(null);
    setFailed(null);
    void report.refetch().then((r) => {
      if (!r.data?.definition || dockedNow.current) return;
      dockedNow.current = true;
      if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) { setDocked(true); return; }
      document.startViewTransition(() => { flushSync(() => setDocked(true)); });
    });
  };

  const [prefill, setPrefill] = useState<{ text: string; at: number } | undefined>();
  const onChip = (label: string) => setPrefill({ text: t("REPORT_CHANGE_CHIP", label), at: Date.now() });

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { toast(refusalText(i18n, e)); }
    void qc.invalidateQueries({ queryKey: orpc.reports.get.key({ input: { id } }) });
    void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
  };
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const picked = useRef<string | null>(null);
  const onMenuClosed = async () => {
    const a = picked.current;
    picked.current = null;
    setMenu(null);
    if (a === "rename") {
      const title = await promptNote({ title: t("REPORT_RENAME"), message: report.data?.title ?? "", actionText: t("REPORT_RENAME"), label: t("REPORT_RENAME") });
      if (title?.trim()) void act(() => client.reports.rename({ id, title: title.trim() }));
    }
    if (a === "delete" && await confirm({ message: t("REPORT_DELETE_CONFIRM"), actionText: t("REPORT_DELETE"), destructive: true })) {
      await act(async () => {
        await client.reports.delete({ id });
        void navigate({ to: "/$slug" });
      });
    }
  };

  const error = report.error ?? thread.error;
  if (error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, error)}</MessageStrip>;
  if (!report.data || !thread.data || docked === null) return <BusyIndicator active style={{ margin: "auto" }} />;

  const actions = (
    <Button design="Transparent" icon="overflow" tooltip={t("REPORT_ACTIONS")} accessibilityAttributes={{ hasPopup: "menu", expanded: !!menu }}
      onClick={(e) => setMenu(e.currentTarget as HTMLElement)} />
  );
  return (
    <FlexBox style={{ height: "100%", minHeight: 0, background: "var(--sapBackgroundColor)" }}>
      {docked ? (
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          <ReportView report={report.data} result={live ?? report.data.lastResult} busy={busy} failed={failed} actions={actions}
            onChip={onChip} onRefresh={() => void runLive()} onSave={(saved) => void act(() => client.reports.save({ id, saved }))} />
        </div>
      ) : null}
      {/* One element in every state, so a stream in progress goes on as it moves. */}
      <FlexBox direction="Column" style={{
        minHeight: 0, viewTransitionName: "cf-report-chat",
        ...(docked ? { width: CHAT_WIDTH, flex: "none", borderInlineStart: "1px solid var(--sapGroup_TitleBorderColor)", background: "var(--sapAssistant_Background, var(--sapBaseColor))" } : { flex: 1 }),
      }}>
        <ChatView key={thread.data.id} thread={thread.data} route={route} page={!docked} kind="report" onTool={onTool} prefill={prefill} />
      </FlexBox>
      <Menu open={!!menu} opener={menu ?? undefined} onClose={() => void onMenuClosed()}
        onItemClick={(e) => { picked.current = (e.detail.item as HTMLElement).dataset.action ?? null; }}>
        <MenuItem data-action="rename" icon="edit" text={t("REPORT_RENAME")} />
        <MenuItem data-action="delete" icon="delete" text={t("REPORT_DELETE")} />
      </Menu>
    </FlexBox>
  );
}
