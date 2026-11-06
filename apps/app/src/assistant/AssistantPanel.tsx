import { useEffect, useLayoutEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, Button, Icon, MenuItem, MessageStrip } from "@ui5/webcomponents-react";
import { getTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
import { attachThemeLoaded, detachThemeLoaded } from "@ui5/webcomponents-base/dist/Theming.js";
import { firstName } from "@confire/ui/format.ts";
import { useI18n } from "../i18n.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { useAssistantThread, type Thread } from "./useAssistant.ts";
import { ChatDrawer, ChatMenu, useChats, type ChatRow } from "./ChatDrawer.tsx";
import { RenameField } from "./RenameField.tsx";
import { useOpenForm } from "./cards/registry.tsx";
import { REPORT_ROUTE, threadInput } from "./routeContext.ts";
import { paletteFor, paletteVars, type Palette } from "./palette.ts";
import { ChatView, kindOf, refusalText, useRoute } from "./ChatView.tsx";

// The assistant panel (Joule spec): Joule's card, floating over the page's right edge — its header bar,
// and the chat of the page's configuration or report (or one picked, or the general one). Styled inline
// over Joule's palette in Horizon and Horizon Dark, the theme's own parameters elsewhere (palette.ts).

/** The palette for the theme actually applied: UI5's, which Horizon Auto resolves by the OS. */
function usePalette(): Palette {
  const dark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const [p, setP] = useState(() => paletteFor(getTheme(), dark()));
  useEffect(() => {
    const update = () => setP(paletteFor(getTheme(), dark()));
    const os = matchMedia("(prefers-color-scheme: dark)");
    attachThemeLoaded(update);
    os.addEventListener("change", update);
    return () => { detachThemeLoaded(update); os.removeEventListener("change", update); };
  }, []);
  return p;
}

/** The header bar's buttons in Joule's header colours, through the parameters UI5's buttons read. */
const HEAD = {
  height: "2.625rem", flex: "none", display: "flex", alignItems: "center", gap: "0.25rem", padding: "0 0.5rem 0 1rem",
  background: "var(--cf-a-head)", color: "var(--cf-a-head-text)",
  "--sapButton_Lite_TextColor": "var(--cf-a-head-text)",
  "--sapButton_Lite_Hover_TextColor": "var(--cf-a-head-hover)",
  "--sapButton_Active_TextColor": "var(--cf-a-head-active)",
  "--sapButton_Lite_Background": "transparent",
  "--sapButton_Lite_BorderColor": "transparent",
  "--sapButton_Lite_Hover_Background": "transparent",
  "--sapButton_Lite_Hover_BorderColor": "transparent",
  "--sapButton_Lite_Active_Background": "transparent",
  "--sapButton_Lite_Active_BorderColor": "transparent",
} as CSSProperties;

export function AssistantPanel() {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const qc = useQueryClient();
  const route = useRoute();
  const me = useQuery(meQuery);
  const navigate = useNavigate({ from: "/$slug" });
  const openForm = useOpenForm();
  const chats = useChats();
  const palette = usePalette();
  // A report's page: the panel is its chat, found through the report.
  const reportId = route.routeId === REPORT_ROUTE ? route.params.id ?? null : null;
  const report = useQuery({ ...orpc.reports.get.queryOptions({ input: { id: reportId ?? "" } }), enabled: !!reportId });
  const reportThread = report.error ? null : report.data ? report.data.threadId : undefined;
  // A chat picked in the drawer, until a page with its own chat or an openChat takes over.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { if (route.projectId || reportId) setPicked(null); }, [route.projectId, reportId]);
  useEffect(() => { if (shell.asked) setPicked(null); }, [shell.asked?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const thread = useAssistantThread(threadInput({ picked, projectId: route.projectId, reportId, reportThread }));
  // The chat's configuration: the page's, else the thread's (one the chat created, followed elsewhere).
  const projectId = route.projectId ?? thread.data?.projectId ?? null;
  const config = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: projectId ?? "" } }), enabled: !!projectId });
  const kind = projectId ? "configure" : thread.data?.reportId ? "report" : kindOf(route);
  const [wide, setWide] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Below the ShellBar, whatever its density: measured when the panel opens.
  const [top, setTop] = useState(52);
  useLayoutEffect(() => {
    const bottom = document.querySelector("ui5-shellbar")?.getBoundingClientRect().bottom;
    if (bottom) setTop(bottom);
  }, [shell.open]);

  /** New chat: always a blank general one (the user's blank thread, if there is one). */
  const newChat = async () => {
    setError(null);
    try {
      const { id } = await client.assistant.newThread({});
      qc.setQueryData(orpc.assistant.thread.queryKey({ input: { id } }), { id, projectId: null, reportId: null, messages: [] });
      setPicked(id);
      setDrawer(false);
    } catch (e) {
      setError(e);
    }
  };
  /** A report's chat edits what its page shows, so it goes there; any other stays where the user is. */
  const pick = (r: ChatRow) => {
    setDrawer(false);
    if (!r.reportId) return setPicked(r.id);
    setPicked(null);
    void navigate({ to: "/$slug/reports/$id", params: { id: r.reportId } });
  };
  /** The shown chat deleted: back to the page's own (a fresh one) or the general; its report went too. */
  const removed = (r: ChatRow) => {
    if (r.id !== thread.data?.id) return;
    setPicked(null);
    if (reportId && r.reportId === reportId) void navigate({ to: "/$slug" });
  };

  /** The chat stored a report: the page re-reads it. A general chat's first report made the report,
   *  so the thread is read again for it — past the cache, as the chat mounted from its copy — and the
   *  user goes to its page. The copy seeded by id is what the report's page shows, so the ChatView
   *  (keyed by the thread's id) stays, its answer still streaming. */
  const onTool = (name: string) => {
    if (name !== "report_set") return;
    void qc.invalidateQueries({ queryKey: orpc.reports.get.key() });
    void qc.invalidateQueries({ queryKey: orpc.reports.tiles.key() });
    void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
    const shown = thread.data;
    if (!shown || shown.reportId) return;
    void client.assistant.thread({ id: shown.id }).then((d) => {
      if (!d.reportId) return;
      qc.setQueryData(orpc.assistant.thread.queryKey({ input: { id: d.id } }), d as Thread);
      void navigate({ to: "/$slug/reports/$id", params: { id: d.reportId } });
    });
  };

  const row = chats.rows.find((r) => r.id === thread.data?.id);
  // Open configuration, unless its form is what the page shows (a client's request's form is its own page).
  const formRoute = config.data?.request ? "/$slug/configs/$id_/configuration" : "/$slug/configs/$id";
  const offerForm = kind === "configure" && !!projectId && !(route.projectId === projectId && route.routeId === formRoute);
  const onMenu = async (a: string | null) => {
    setMenu(null);
    if (a === "open" && projectId) void openForm(projectId);
    if (!row) return;
    if (a === "pin") void chats.pin(row);
    if (a === "rename") setRenaming(true);
    if (a === "delete" && await chats.remove(row)) removed(row);
  };

  const icon = (name: string, label: string, onClick: (e: { currentTarget: unknown }) => void, extra?: object) => (
    <Button design="Transparent" icon={name} tooltip={label} accessibleName={label} onClick={onClick} {...extra} />
  );
  const head = ({ empty }: { empty: boolean }) => (
    <>
      <div style={HEAD}>
        {icon("menu2", t("ASSISTANT_CHATS"), () => setDrawer((d) => !d), { accessibilityAttributes: { expanded: drawer } })}
        {renaming && row
          ? <RenameField value={chats.label(row)} label={t("ASSISTANT_RENAME")} onDone={(v) => { setRenaming(false); chats.rename(row, v); }} />
          : (
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "1rem", fontWeight: "bold" }}>
              {empty || !row ? t("ASSISTANT_TITLE") : chats.label(row)}
            </span>
          )}
        {!empty && row ? icon("overflow", t("ASSISTANT_CHAT_ACTIONS"), (e) => setMenu(e.currentTarget as HTMLElement), { accessibilityAttributes: { hasPopup: "menu" } }) : null}
        {icon(wide ? "exit-full-screen" : "full-screen", t(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND"), () => setWide((w) => !w))}
        {icon("decline", t("ASSISTANT_CLOSE"), shell.close)}
      </div>
      {error ? (
        <MessageStrip design="Negative" onClose={() => setError(null)} style={{ margin: "0.5rem 1rem 0", width: "auto" }}>
          {refusalText(i18n, error)}
        </MessageStrip>
      ) : null}
    </>
  );
  // Joule's welcome: the mark, the greeting, what the chat is for. Plain elements: the colour is inherited.
  const welcome = (
    <>
      <Icon name="ai" style={{ width: "4rem", height: "4rem", color: "var(--cf-a-mark)" }} />
      <div style={{ fontSize: "1rem", fontWeight: "bold", margin: "0.75rem 0 0.5rem" }}>{t("ASSISTANT_HELLO", firstName(me.data?.user))}</div>
      <div>{t(kind === "configure" ? "ASSISTANT_WELCOME_CONFIGURE" : "ASSISTANT_WELCOME_START")}</div>
    </>
  );

  return (
    // Under the shell, over the page: NavigationLayout stacks its side nav at 2 and its ShellBar at 3 (so
    // the collapsed nav's flyout overlaps the panel); an ObjectPage is its own context at 0, and a
    // DynamicPage's layers stop at 1, which the panel wins by coming later in the DOM. Closed, it stays
    // mounted: closing must not cut off an answer still streaming.
    <aside role="complementary" aria-label={t("ASSISTANT_TITLE")}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") shell.close(); }}
      style={{
        ...paletteVars(palette),
        position: "fixed", zIndex: 1, top: `calc(${top}px + 0.5rem)`, bottom: "1rem", insetInlineEnd: "1rem",
        width: `min(${wide ? "48rem, 60vw" : "26rem"}, 100vw - 2rem)`,
        display: shell.open ? "flex" : "none", overflow: "hidden",
        background: "var(--cf-a-page)", color: "var(--cf-a-text)", borderRadius: "1rem", boxShadow: "var(--cf-a-shadow)",
      }}>
      <ChatDrawer open={drawer} mode="card" openId={thread.data?.id ?? null} chats={chats}
        onPick={pick} onNew={() => void newChat()} onHide={() => setDrawer(false)} onRemoved={removed} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {thread.data ? <ChatView key={thread.data.id} thread={thread.data} route={route} kind={kind} head={head} welcome={welcome}
          onTool={onTool} prefill={shell.asked?.text ? { text: shell.asked.text, at: shell.asked.at } : undefined} />
          : (
            <>
              {head({ empty: true })}
              {thread.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, thread.error)}</MessageStrip>
                : <BusyIndicator active style={{ margin: "auto" }} />}
            </>
          )}
      </div>
      <ChatMenu opener={menu} pinned={!!row?.pinned} onAction={(a) => void onMenu(a)}>
        {offerForm ? <MenuItem data-action="open" icon="sales-quote" text={t("ASSISTANT_OPEN_CONFIG")} /> : null}
      </ChatMenu>
    </aside>
  );
}
