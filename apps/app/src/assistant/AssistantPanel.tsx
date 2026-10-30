import { useLayoutEffect, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BusyIndicator, Button, FlexBox, Icon, Label, MessageStrip, Text, Title } from "@ui5/webcomponents-react";
import { confirm } from "@confire/ui/confirm.ts";
import { useI18n } from "../i18n.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { useAssistantThread } from "./useAssistant.ts";
import { ChatView, kindOf, refusalText, useRoute } from "./ChatView.tsx";

// The assistant panel (assistant spec §4.2, plan "The look"): Joule's side panel, floating over the
// page's right edge — its head on the assistant gradient, and the chat of the page's configuration (or
// the user's general one). Styled inline over the theme's own assistant parameters, so it follows
// Horizon, Horizon Dark and the high-contrast themes.

/** Joule's head: the theme's assistant gradient (flat in the high-contrast themes), the bar on it drawn
 *  in the assistant's text colour through the parameters its components read. */
const HEAD = {
  background: "var(--sapAssistant_BackgroundGradient)",
  "--sapPageHeader_Background": "transparent",
  "--sapContent_HeaderShadow": "none",
  "--sapTextColor": "var(--sapAssistant_TextColor)",
  "--sapGroup_TitleTextColor": "var(--sapAssistant_TextColor)",
  "--sapContent_LabelColor": "var(--sapAssistant_TextColor)",
  "--sapButton_Lite_TextColor": "var(--sapAssistant_TextColor)",
  "--sapButton_Lite_Hover_TextColor": "var(--sapAssistant_Hover_TextColor)",
  "--sapButton_Lite_Hover_Background": "var(--sapAssistant_Hover_Background)",
  "--sapButton_Lite_Hover_BorderColor": "var(--sapAssistant_Hover_BorderColor)",
  "--sapButton_Lite_Active_Background": "var(--sapAssistant_Active_Background)",
  "--sapButton_Lite_Active_BorderColor": "var(--sapAssistant_Active_BorderColor)",
  "--sapButton_Active_TextColor": "var(--sapAssistant_Active_TextColor)",
} as CSSProperties;

/** The greeting below the bar while the chat is empty; the first message collapses it — a 1fr → 0fr
 *  grid row, which animates where `auto` does not. */
const hero = (shown: boolean): CSSProperties => ({
  display: "grid",
  gridTemplateRows: shown ? "1fr" : "0fr",
  opacity: shown ? 1 : 0,
  visibility: shown ? "visible" : "hidden",
  transition: matchMedia("(prefers-reduced-motion: reduce)").matches ? "none"
    : shown ? "grid-template-rows 0.4s ease-in-out, opacity 0.4s"
    : "grid-template-rows 0.4s ease-in-out, opacity 0.25s, visibility 0s 0.4s",
});

export function AssistantPanel() {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const qc = useQueryClient();
  const route = useRoute();
  const me = useQuery(meQuery);
  const thread = useAssistantThread(route.projectId);
  // The chat's configuration: the page's, else the thread's (one the chat created, followed elsewhere).
  const projectId = route.projectId ?? thread.data?.projectId ?? null;
  const config = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: projectId ?? "" } }), enabled: !!projectId });
  const [wide, setWide] = useState(false);

  // Below the ShellBar, whatever its density: measured when the panel opens.
  const [top, setTop] = useState(52);
  useLayoutEffect(() => {
    const bottom = document.querySelector("ui5-shellbar")?.getBoundingClientRect().bottom;
    if (bottom) setTop(bottom);
  }, [shell.open]);

  // New chat: a new general thread, or a configuration's thread started over — that one is deleted,
  // so it asks first. Refused while the chat is still answering (the thread's lease).
  const [newChatError, setNewChatError] = useState<unknown>(null);
  const newChat = async () => {
    const cleared = route.projectId;
    if (cleared && !(await confirm({ message: t("ASSISTANT_NEW_CHAT_CONFIRM"), actionText: t("ASSISTANT_NEW_CHAT"), destructive: true }))) return;
    setNewChatError(null);
    const input = cleared ? { projectId: cleared } : {};
    try {
      const { id } = await client.assistant.newThread(input);
      qc.setQueryData(orpc.assistant.thread.queryKey({ input }), { id, projectId: cleared ?? null, messages: [] });
    } catch (e) {
      setNewChatError(e);
    }
  };
  const kind = projectId ? "configure" : kindOf(route);
  const subtitle = projectId ? config.data?.project.name ?? "" : t("ASSISTANT_GENERAL");
  const firstName = (me.data?.user?.name || me.data?.user?.email || "").split(/[ @]/)[0] ?? "";

  const head = (empty: boolean) => (
    <>
      <div style={HEAD}>
        <Bar
          startContent={
            <FlexBox alignItems="Baseline" gap="0.5rem" style={{ minWidth: 0 }}>
              <Title level="H5" wrappingType="None" style={{ flexShrink: 0 }}>{t("ASSISTANT_TITLE")}</Title>
              <Label wrappingType="None" style={{ minWidth: 0 }}>{subtitle}</Label>
            </FlexBox>
          }
          endContent={
            <>
              <Button design="Transparent" icon="add" tooltip={t("ASSISTANT_NEW_CHAT")} accessibleName={t("ASSISTANT_NEW_CHAT")}
                onClick={() => void newChat()} />
              <Button design="Transparent" icon={wide ? "exit-full-screen" : "full-screen"}
                tooltip={t(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND")} accessibleName={t(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND")}
                onClick={() => setWide((w) => !w)} />
              <Button design="Transparent" icon="decline" tooltip={t("ASSISTANT_CLOSE")} accessibleName={t("ASSISTANT_CLOSE")} onClick={shell.close} />
            </>
          } />
        <div style={hero(empty)}>
          <div style={{ minHeight: 0, overflow: "hidden" }}>
            <FlexBox direction="Column" alignItems="Center" gap="0.5rem" style={{ padding: "1.5rem 1rem 2.5rem", textAlign: "center" }}>
              <Icon name="ai" style={{ width: "3rem", height: "3rem", color: "var(--sapAssistant_TextColor)" }} />
              <Title level="H3">{t("ASSISTANT_HELLO", firstName)}</Title>
              <Text>{t(kind === "configure" ? "ASSISTANT_WELCOME_CONFIGURE" : "ASSISTANT_WELCOME_GENERAL")}</Text>
            </FlexBox>
          </div>
        </div>
      </div>
      {newChatError ? (
        <MessageStrip design="Negative" onClose={() => setNewChatError(null)} style={{ margin: "0.5rem 1rem 0", width: "auto" }}>
          {refusalText(i18n, newChatError)}
        </MessageStrip>
      ) : null}
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
        position: "fixed", zIndex: 1, top: `calc(${top}px + 0.5rem)`, bottom: "0.5rem", insetInlineEnd: "0.5rem",
        width: `min(${wide ? "48rem, 60vw" : "26rem"}, 100vw - 1rem)`,
        display: shell.open ? "flex" : "none", flexDirection: "column", overflow: "hidden",
        // A page's own background, as a List Report draws behind its table: cards and the composer stand out.
        background: "var(--sapBackgroundColor)", color: "var(--sapTextColor)",
        borderRadius: "var(--sapElement_BorderCornerRadius)", boxShadow: "var(--sapContent_Shadow2)",
      }}>
      {thread.data ? <ChatView key={thread.data.id} thread={thread.data} route={route} kind={kind} head={({ empty }) => head(empty)} />
        : (
          <>
            {head(false)}
            {thread.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{thread.error.message}</MessageStrip>
              : <BusyIndicator active style={{ margin: "auto" }} />}
          </>
        )}
    </aside>
  );
}
