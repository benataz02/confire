import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  Bar, BusyIndicator, Button, FlexBox, Input, Menu, MenuItem, MessageStrip, ToolbarButton,
  type InputDomRef,
} from "@ui5/webcomponents-react";
import { confirm, promptNote } from "@confire/ui/confirm.ts";
import { toast } from "@confire/ui/toast.ts";
import type { FilterValue } from "@confire/ui/types.ts";
import { useI18n } from "../i18n.ts";
import { client, orpc } from "../orpc.ts";
import { ReportView } from "../reports/ReportView.tsx";
import type { Result } from "../reports/widgets.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { ChatView, refusalText, useRoute, type HeadState } from "./ChatView.tsx";
import type { Thread } from "./useAssistant.ts";

// The AI page (assistant spec §4.2): one chat for everything — the chat loads the skill the user's ask
// needs (server, skills.ts). `/assistant` is a new chat (the user's blank thread, `blankThread`),
// `/assistant/<chat>` one of theirs; its chats are found with the shell's search (GlobalSearch), and
// the chat's title opens its menu (pin, rename, delete). The panel is not drawn here
// (AssistantProvider), so leaving mid-answer stops the answer, as Stop does.
//
// A report's chat (reports spec §6.2) is this page too: once the chat's first report_set result
// arrives, the chat slides to the right (a view transition) and the report grows in on its left. A
// saved report opened from home (`/reports/<id>`, `reportId`) opens to be read, its chat closed:
// *Edit* docks the chat (Fiori's display → edit), *Done* closes it; a chat search hit (`#chat`) opens
// it docked. One ChatView element in every state, so a stream in progress goes on as it moves — and
// as it hides.

type Row = { id: string; title: string; projectId: string | null; projectName: string | null; reportTitle: string | null; pinned: boolean; updatedAt: Date };
type Action = "pin" | "rename" | "delete";

const CHAT_WIDTH = 360;

/** One layout change, slid as a view transition (reduced motion: none). */
const transition = (fn: () => void) => {
  if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return fn();
  document.startViewTransition(() => { flushSync(fn); });
};

export function AssistantPage({ threadId, reportId: openedReport }: { threadId: string | null; reportId?: string }) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const qc = useQueryClient();
  const shell = useAssistantShell();
  const navigate = useNavigate({ from: "/$slug" });
  const route = useRoute();

  // A new chat is the user's blank thread, under its own address.
  const [newError, setNewError] = useState<unknown>(null);
  useEffect(() => {
    if (threadId) return;
    client.assistant.newThread({}).then(
      ({ id }) => navigate({ to: "/$slug/assistant/$id", params: { id }, replace: true }), setNewError);
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read mode (a saved report opened from home): the chat is not even loaded until Edit.
  const fromChat = useLocation({ select: (l) => l.hash === "chat" });
  const reading = !!openedReport && !fromChat;
  const [editing, setEditing] = useState(!reading);
  const [opened, setOpened] = useState(!reading);
  const thread = useQuery({ ...orpc.assistant.thread.queryOptions({ input: { id: threadId ?? "" } }), enabled: !!threadId && opened, staleTime: Infinity });

  // The chat's report: the one opened, else the thread's — which its first report_set makes (`adopted`).
  const [adopted, setAdopted] = useState<string | null>(null);
  const reportId = openedReport ?? thread.data?.reportId ?? adopted;
  const report = useQuery({ ...orpc.reports.get.queryOptions({ input: { id: reportId ?? "" } }), enabled: !!reportId });
  // docked: there is a report to show, the chat (when shown) beside it.
  const docked = !!report.data?.definition;

  const edit = (on: boolean) => transition(() => { setEditing(on); if (on) setOpened(true); });
  // A report with nothing drafted has nothing to read: its chat is the page.
  useEffect(() => { if (report.data && !report.data.definition && !opened) { setOpened(true); setEditing(true); } }, [report.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // `#chat` is a one-off request, cleared once read: the same hit picked again opens it again.
  useEffect(() => {
    if (!fromChat || !openedReport) return;
    if (!editing) edit(true);
    void navigate({ to: "/$slug/reports/$id", params: { id: openedReport }, hash: "", replace: true });
  }, [fromChat]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live on open: the stored result shows at once, SAP's answer replaces it.
  const [live, setLive] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // Each report_set and each run is a new generation: a live run that started before one is not drawn over it.
  const generation = useRef(0);
  // The filter bar's values, kept for Refresh; none = the definition's defaults.
  const filters = useRef<Record<string, FilterValue> | undefined>(undefined);
  const runLive = async () => {
    if (!reportId) return;
    const g = ++generation.current; // a later Go wins over a run still answering
    setBusy(true);
    setFailed(null);
    try {
      const r = await client.reports.run({ id: reportId, filters: filters.current });
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

  /** The chat changed the report: show what it stored. The first time — a general chat's first
   *  report_set, which made the report — the thread is read again for its report, and the report's
   *  arrival docks the chat; a refused call (the model fixes and calls again) changes nothing. */
  const onTool = (name: string) => {
    if (name !== "report_set") return;
    generation.current++;
    filters.current = undefined; // a new definition opens on its own defaults
    ran.current = true; // what report_set stored is already live
    setLive(null);
    setFailed(null);
    if (!reportId) {
      // Read past the cache: the chat mounted from its cached copy, which must not change under it.
      if (threadId) void client.assistant.thread({ id: threadId }).then((d) => {
        if (!d.reportId) return;
        setAdopted(d.reportId);
        void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
      });
      return;
    }
    void report.refetch();
  };
  // The report's first definition slides the chat over (a view transition), once.
  const wasDocked = useRef<boolean | null>(null);
  useEffect(() => {
    if (wasDocked.current === false && docked) transition(() => { setEditing(true); setOpened(true); });
    if (report.data || !reportId) wasDocked.current = docked;
  }, [docked]); // eslint-disable-line react-hooks/exhaustive-deps

  const [prefill, setPrefill] = useState<{ text: string; at: number } | undefined>();
  // A chip asks the chat for a change, so it opens the chat if it is closed.
  const onChip = (label: string) => {
    if (!editing) edit(true);
    setPrefill({ text: t("REPORT_CHANGE_CHIP", label), at: Date.now() });
  };

  // The user's chats: what names the open one and says whether it is pinned.
  const all = useQuery(orpc.assistant.threads.queryOptions({ input: undefined }));
  const label = (r: Row) => r.title || r.reportTitle || r.projectName || t("ASSISTANT_UNTITLED");
  const current = all.data?.find((r) => r.id === threadId);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const picked = useRef<Action | null>(null);
  const [renaming, setRenaming] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { toast(refusalText(i18n, e)); }
    void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
    if (reportId) {
      void qc.invalidateQueries({ queryKey: orpc.reports.get.key({ input: { id: reportId } }) });
      void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
    }
  };
  const rename = (r: Row, title: string | null) => {
    setRenaming(false);
    if (title?.trim() && title.trim() !== label(r)) void act(() => client.assistant.renameThread({ id: r.id, title }));
  };
  const remove = async (r: Row) => {
    if (!(await confirm({ message: t("ASSISTANT_DELETE_CONFIRM"), actionText: t("ASSISTANT_DELETE"), destructive: true }))) return;
    await act(async () => {
      await client.assistant.deleteThread({ id: r.id });
      // Every cached copy goes, the panel's by configuration too: none may come back as a chat.
      qc.removeQueries({ queryKey: orpc.assistant.thread.key(), predicate: (x) => (x.state.data as Thread | undefined)?.id === r.id });
      if (r.id === threadId) void navigate({ to: "/$slug/assistant" });
    });
  };
  // The title's menu acts once it has closed: it hands focus back to its button as it closes, which
  // would otherwise take it from the rename field straight away.
  const onMenuClosed = () => {
    const a = picked.current;
    picked.current = null;
    setMenu(null);
    if (!current) return;
    if (a === "pin") void act(() => client.assistant.pinThread({ id: current.id, pinned: !current.pinned }));
    if (a === "rename") setRenaming(true);
    if (a === "delete") void remove(current);
  };

  // The report's own: its title, and deleting it deletes its chat.
  const renameReport = async () => {
    const title = await promptNote({ title: t("REPORT_RENAME"), message: report.data?.title ?? "", actionText: t("REPORT_RENAME"), label: t("REPORT_RENAME") });
    if (title?.trim() && reportId) void act(() => client.reports.rename({ id: reportId, title: title.trim() }));
  };
  const removeReport = async () => {
    if (!reportId || !await confirm({ message: t("REPORT_DELETE_CONFIRM"), actionText: t("REPORT_DELETE"), destructive: true })) return;
    await act(async () => {
      await client.reports.delete({ id: reportId });
      qc.removeQueries({ queryKey: orpc.assistant.thread.key(), predicate: (x) => (x.state.data as Thread | undefined)?.id === threadId });
      void navigate({ to: "/$slug" });
    });
  };

  // To the configuration's form, the chat open beside it in the panel.
  const openConfig = (id: string) => {
    if (!shell.open) shell.toggle();
    void navigate({ to: "/$slug/configs/$id", params: { id } });
  };

  // A new chat has nothing to put on the bar, so it has none; a docked chat's actions are the report's.
  const bar = ({ busy: working, projectId, empty }: HeadState) => (docked || (empty && !projectId) ? null : (
    <Bar
      startContent={!empty && current ? (renaming
        ? <RenameField value={label(current)} label={t("ASSISTANT_RENAME")} onDone={(v) => rename(current, v)} />
        : (
          <Button design="Transparent" endIcon="slim-arrow-down" tooltip={t("ASSISTANT_CHAT_ACTIONS")} style={{ maxWidth: "20rem" }}
            accessibilityAttributes={{ hasPopup: "menu", expanded: !!menu }} onClick={(e) => setMenu(e.currentTarget as HTMLElement)}>
            {label(current)}
          </Button>
        )) : null}
      endContent={
        <>
          {/* Waits for the answer: leaving mid-answer would stop it. */}
          {projectId ? (
            <Button design="Transparent" icon="sales-quote" disabled={working} onClick={() => openConfig(projectId)}>{t("ASSISTANT_OPEN_CONFIG")}</Button>
          ) : null}
          {!empty ? <Button design="Transparent" icon="write-new" onClick={() => void navigate({ to: "/$slug/assistant" })}>{t("ASSISTANT_NEW_CHAT")}</Button> : null}
        </>
      } />
  ));

  // The report view's Toolbar puts these behind its own overflow button: no Menu of ours to manage.
  const reportActions = (
    <>
      <ToolbarButton overflowPriority="NeverOverflow" design="Emphasized" text={t(editing ? "REPORT_DONE" : "REPORT_EDIT")}
        onClick={() => edit(!editing)} />
      <ToolbarButton overflowPriority="AlwaysOverflow" icon="edit" text={t("REPORT_RENAME")}
        accessibilityAttributes={{ hasPopup: "dialog" }} onClick={() => void renameReport()} />
      <ToolbarButton overflowPriority="AlwaysOverflow" icon="delete" text={t("REPORT_DELETE")}
        accessibilityAttributes={{ hasPopup: "dialog" }} onClick={() => void removeReport()} />
    </>
  );

  const error = thread.error ?? newError ?? report.error;
  if (error) return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, error)}</MessageStrip>;
  // margin: auto centres only inside a flex box, which the route's outlet is not. Only a report opened
  // to be read waits for it: a chat on screen never unmounts (it may be answering).
  if (reading && !report.data) return <FlexBox fitContainer justifyContent="Center" alignItems="Center"><BusyIndicator active /></FlexBox>;

  const kind = reportId ? "report" : thread.data?.projectId ? "configure" : "general";
  return (
    <FlexBox style={{ height: "100%", minHeight: 0, background: "var(--sapBackgroundColor)" }}>
      {docked && report.data ? (
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
          <ReportView report={report.data} result={live ?? report.data.lastResult} busy={busy} failed={failed} actions={reportActions}
            onChip={onChip} onRefresh={() => void runLive()} onSave={(saved) => void act(() => client.reports.save({ id: reportId!, saved }))}
            onFilter={(values) => { filters.current = values; void runLive(); }} />
        </div>
      ) : null}
      {opened ? (
        <FlexBox direction="Column" style={{
          minHeight: 0, viewTransitionName: "cf-report-chat",
          ...(docked ? { width: CHAT_WIDTH, flex: "none", borderInlineStart: "1px solid var(--sapGroup_TitleBorderColor)" } : { flex: 1, minWidth: 0 }),
          ...(docked && !editing ? { display: "none" } : {}),
        }}>
          {thread.data
            ? <ChatView key={thread.data.id} thread={thread.data} route={route} page={!docked} kind={kind} head={bar} onTool={onTool} prefill={prefill} />
            : <BusyIndicator active style={{ margin: "auto" }} />}
        </FlexBox>
      ) : null}
      <Menu open={!!menu} opener={menu ?? undefined} onClose={onMenuClosed}
        onItemClick={(e) => { picked.current = (e.detail.item as HTMLElement).dataset.action as Action; }}>
        <MenuItem data-action="pin" icon={current?.pinned ? "pushpin-off" : "pushpin-on"} text={t(current?.pinned ? "ASSISTANT_UNPIN" : "ASSISTANT_PIN")} />
        <MenuItem data-action="rename" icon="edit" text={t("ASSISTANT_RENAME")} />
        <MenuItem data-action="delete" icon="delete" text={t("ASSISTANT_DELETE")} />
      </Menu>
    </FlexBox>
  );
}

/** The chat's title as a field: Enter or leaving it saves, Escape keeps the old one. */
function RenameField({ value, label, onDone }: { value: string; label: string; onDone(v: string | null): void }) {
  const ref = useRef<InputDomRef>(null);
  const done = useRef(false);
  const finish = (v: string | null) => { if (!done.current) { done.current = true; onDone(v); } };
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <Input ref={ref} value={value} maxlength={200} accessibleName={label} style={{ width: "20rem" }}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(ref.current?.value ?? value);
        if (e.key === "Escape") { e.stopPropagation(); finish(null); }
      }}
      onBlur={() => finish(ref.current?.value ?? value)} />
  );
}
