import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BusyIndicator, Button, Icon, MessageStrip } from "@ui5/webcomponents-react";
import { getTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
import { attachThemeLoaded, detachThemeLoaded } from "@ui5/webcomponents-base/dist/Theming.js";
import { firstName } from "@confire/ui/format.ts";
import { useI18n } from "../i18n.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { useAssistantShell } from "./shell.ts";
import { useAssistantThread, type Thread } from "./useAssistant.ts";
import { ChatDrawer, useChats, type ChatRow } from "./ChatDrawer.tsx";
import { REPORT_ROUTE, threadInput } from "./routeContext.ts";
import { paletteFor, paletteVars, type Palette } from "./palette.ts";
import { cardBox, clampPos, type Pos } from "./geometry.ts";
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
  height: "2.625rem", flex: "none", display: "flex", alignItems: "center", gap: "0.25rem", padding: "0 0.5rem",
  touchAction: "none", userSelect: "none",
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
  const kind = projectId ? "configure" : thread.data?.reportId ? "report" : kindOf(route);
  const [drawer, setDrawer] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The box (geometry.ts). Local state is enough: the panel never unmounts once mounted, so a drag
  // survives restore and close/reopen, and is forgotten on reload, as Joule's.
  const [maximized, setMaximized] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [pos, setPos] = useState<Pos | null>(null);
  const [animating, setAnimating] = useState(false);
  const [view, setView] = useState({ vw: innerWidth, vh: innerHeight });
  useEffect(() => {
    const onResize = () => setView({ vw: innerWidth, vh: innerHeight });
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  // Under the ShellBar, whatever its density: measured when the panel opens.
  const [top, setTop] = useState(60);
  useLayoutEffect(() => {
    const bottom = document.querySelector("ui5-shellbar")?.getBoundingClientRect().bottom;
    if (bottom) setTop(bottom + 8);
  }, [shell.open]);
  const box = cardBox({ maximized, pos, ...view, top });
  const aside = useRef<HTMLElement>(null);

  /** Joule's transition, only while toggling (never while dragging); none with reduced motion. */
  const resize = (max: boolean) => {
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setAnimating(true);
      setTimeout(() => setAnimating(false), 600); // the 0.5 s transition, done
    }
    setMaximized(max);
  };
  // The chats beside the chat: the card's drawer, or the maximized panel's sidebar.
  const chatsOpen = maximized ? sidebar : drawer;
  const setChatsOpen = maximized ? setSidebar : setDrawer;
  // Whenever the chat takes the user to a page, back to the card so the page shows (spec §5.4).
  useEffect(() => { if (maximized) resize(false); }, [route]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!shell.open) setMaximized(false); }, [shell.open]);

  // A drag moves the element itself and is stored once, on release: state per pointer move would
  // re-render the whole chat at pointer rate.
  // ponytail: drag by pointer only; arrow keys on the header if someone needs to move it without a mouse.
  const drag = useRef<{ dx: number; dy: number; at: Pos } | null>(null);
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (maximized || e.button !== 0 || (e.target as Element).closest("ui5-button, ui5-toggle-button, ui5-input, button, input")) return;
    drag.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, at: { x: box.left, y: box.top } };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !aside.current) return;
    d.at = clampPos({ x: e.clientX - d.dx, y: e.clientY - d.dy }, box, view.vw, view.vh);
    aside.current.style.left = `${d.at.x}px`;
    aside.current.style.top = `${d.at.y}px`;
  };
  const endDrag = () => { if (drag.current) setPos(drag.current.at); drag.current = null; };

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

  // A chip's text goes into one chat's box, once: a chat drawn later (another one picked) does not get
  // it again. Marked after the chat it was for has drawn — a child's effects run before its parent's.
  const used = useRef(0);
  const prefill = shell.asked?.text && shell.asked.at > used.current ? { text: shell.asked.text, at: shell.asked.at } : undefined;
  useEffect(() => { if (prefill && thread.data && !thread.isPlaceholderData) used.current = prefill.at; });

  const row = chats.rows.find((r) => r.id === thread.data?.id);

  const icon = (name: string, label: string, onClick: (e: { currentTarget: unknown }) => void, extra?: object) => (
    <Button design="Transparent" icon={name} tooltip={label} accessibleName={label} onClick={onClick} {...extra} />
  );
  const head = ({ empty }: { empty: boolean }) => (
    <>
      <div style={{ ...HEAD, cursor: maximized ? "default" : "move" }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        {/* Maximized, an open sidebar has its own ☰. */}
        {!maximized || !sidebar ? icon("menu2", t("ASSISTANT_CHATS"), () => setChatsOpen((o) => !o), { accessibilityAttributes: { expanded: chatsOpen } }) : null}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "1rem", fontWeight: "bold" }}>
          {empty || !row ? t("ASSISTANT_TITLE") : chats.label(row)}
        </span>
        {/* Pin, rename and delete are the drawer rows' •••. */}
        {icon("write-new", t("ASSISTANT_NEW_CHAT"), () => void newChat())}
        {icon(maximized ? "exit-full-screen" : "full-screen", t(maximized ? "ASSISTANT_RESTORE" : "ASSISTANT_MAXIMIZE"), () => resize(!maximized))}
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
      <Icon name="ai" style={{ width: maximized ? "6rem" : "4rem", height: maximized ? "6rem" : "4rem", color: "var(--cf-a-mark)" }} />
      <div style={{ fontSize: maximized ? "1.5rem" : "1rem", fontWeight: "bold", margin: "0.75rem 0 0.5rem" }}>{t("ASSISTANT_HELLO", firstName(me.data?.user))}</div>
      <div>{t(kind === "configure" ? "ASSISTANT_WELCOME_CONFIGURE" : "ASSISTANT_WELCOME_START")}</div>
    </>
  );

  return (
    // Over the ShellBar (NavigationLayout's is at 3), which a dragged card or the maximized panel covers;
    // UI5's popups render in the top layer, so menus and dialogs opened from here still show above it.
    // Closed, it stays mounted, and the ChatView keeps its place in every state: an answer streaming
    // goes on through close, maximize, restore and drag.
    <aside ref={aside} role="complementary" aria-label={t("ASSISTANT_TITLE")}
      // Escape closes the card's drawer first, then the panel.
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") (drawer && !maximized ? setDrawer(false) : shell.close()); }}
      style={{
        ...paletteVars(palette),
        position: "fixed", zIndex: 4, left: box.left, top: box.top, width: box.width, height: box.height, borderRadius: box.radius,
        transition: animating ? "all 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)" : "none",
        display: shell.open ? "flex" : "none", overflow: "hidden", boxSizing: "border-box",
        background: "var(--cf-a-page)", color: "var(--cf-a-text)", boxShadow: maximized ? "none" : "var(--cf-a-shadow)",
        // The card is the page's white on white: a light edge sets it apart. Maximized, it is the window.
        border: maximized ? "none" : "1px solid var(--sapGroup_ContentBorderColor)",
      }}>
      <ChatDrawer open={chatsOpen} mode={maximized ? "sidebar" : "card"} openId={thread.data?.id ?? null} chats={chats}
        onPick={pick} onHide={() => setChatsOpen(false)} onRemoved={removed} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {thread.data ? <ChatView key={thread.data.id} thread={thread.data} route={route} kind={kind} head={head} welcome={welcome} wide={maximized}
          onTool={onTool} prefill={prefill} />
          : (
            <>
              {head({ empty: true })}
              {thread.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{refusalText(i18n, thread.error)}</MessageStrip>
                : <BusyIndicator active style={{ margin: "auto" }} />}
            </>
          )}
      </div>
    </aside>
  );
}
