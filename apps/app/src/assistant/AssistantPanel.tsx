import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { UIMessage } from "@tanstack/ai-react";
import { TextPart } from "@tanstack/ai-react/ui";
import {
  Bar, BusyIndicator, Button, Icon, IllustratedMessage, Label, Link, MessageStrip, Tag, Text, TextArea, Title,
} from "@ui5/webcomponents-react";
import type { TextAreaDomRef } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { useLanguage } from "@confire/ui/i18n.ts";
import { useI18n } from "../i18n.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { nextReplies } from "./replies.ts";
import { routeContext, type RouteContext } from "./routeContext.ts";
import { useAssistantChat, useAssistantThread, type Thread } from "./useAssistant.ts";
import { progressText, renderTool } from "./cards/registry.tsx";
import "./assistant.css";

// The assistant panel (assistant spec §4.2, plan "The look"): Joule's side panel, floating over the
// page's right edge. Text is for words and cards for data: every tool result is a card from
// cards/registry.tsx, chosen by the tool's name. Colours come from the theme's assistant parameters.

type Kind = "configure" | "general" | "model";
const kindOf = (r: RouteContext): Kind =>
  r.projectId ? "configure" : r.routeId.startsWith("/$slug/models/") ? "model" : "general";

const LANGS = new Set(["en", "es", "eu"]);

/** The deepest route match, as a string so the selector is stable between renders. */
function useRoute(): RouteContext {
  const key = useRouterState({
    select: (s) => { const m = s.matches.at(-1); return m ? JSON.stringify([m.routeId, m.params]) : ""; },
  });
  return useMemo(() => {
    if (!key) return routeContext([]);
    const [routeId, params] = JSON.parse(key) as [string, Record<string, string>];
    return routeContext([{ routeId, params }]);
  }, [key]);
}

export function AssistantPanel() {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const qc = useQueryClient();
  const route = useRoute();
  const thread = useAssistantThread(route.projectId);
  const config = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: route.projectId ?? "" } }), enabled: !!route.projectId });
  const [wide, setWide] = useState(false);
  const root = useRef<HTMLElement>(null);

  // Below the ShellBar, whatever its density: measured when the panel opens.
  useLayoutEffect(() => {
    const bottom = document.querySelector("ui5-shellbar")?.getBoundingClientRect().bottom;
    if (bottom && root.current) root.current.style.setProperty("--cf-shellbar-bottom", `${bottom}px`);
  }, [shell.open]);

  const newChat = async () => {
    const { id } = await client.assistant.newThread();
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: {} }), { id, projectId: null, messages: [] });
  };
  const kind = kindOf(route);
  const subtitle = route.projectId ? config.data?.project.name ?? "" : i18n.getText("ASSISTANT_GENERAL");

  return (
    <aside ref={root} className={`cf-assistant${wide ? " cf-assistant--wide" : ""}`} hidden={!shell.open}
      role="complementary" aria-label={i18n.getText("ASSISTANT_TITLE")}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") shell.close(); }}>
      <Bar className="cf-assistant__head"
        startContent={
          <div className="cf-assistant__heading">
            <Title level="H5">{i18n.getText("ASSISTANT_TITLE")}</Title>
            <span className="cf-assistant__sub">{subtitle}</span>
          </div>
        }
        endContent={
          <>
            {kind !== "configure" ? (
              <Button design="Transparent" icon="add" tooltip={i18n.getText("ASSISTANT_NEW_CHAT")}
                accessibleName={i18n.getText("ASSISTANT_NEW_CHAT")} onClick={() => void newChat()} />
            ) : null}
            <Button design="Transparent" icon={wide ? "exit-full-screen" : "full-screen"}
              tooltip={i18n.getText(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND")}
              accessibleName={i18n.getText(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND")} onClick={() => setWide((w) => !w)} />
            <Button design="Transparent" icon="decline" tooltip={i18n.getText("ASSISTANT_CLOSE")}
              accessibleName={i18n.getText("ASSISTANT_CLOSE")} onClick={shell.close} />
          </>
        } />
      {thread.data ? <ChatView key={thread.data.id} thread={thread.data} route={route} kind={kind} />
        : thread.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{thread.error.message}</MessageStrip>
        : <BusyIndicator active style={{ margin: "auto" }} />}
    </aside>
  );
}

/** A tool call paired with its result, as the card registry takes it. */
function toolParts(messages: readonly UIMessage[]) {
  const results = new Map<string, { content: unknown; error?: string }>();
  for (const m of messages)
    for (const p of m.parts)
      if (p.type === "tool-result") results.set(p.toolCallId, { content: p.content, error: p.error ?? (p.state === "error" ? String(p.content) : undefined) });
  return results;
}

const parse = (v: unknown) => {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
};

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.content : "")).join("");

function ChatView({ thread, route, kind }: { thread: Thread; route: RouteContext; kind: Kind }) {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const navigate = useNavigate({ from: "/$slug" });
  const { language } = useLanguage();
  const status = useQuery(orpc.assistant.status.queryOptions());
  const me = useQuery(meQuery);
  const view = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: route.projectId ?? "" } }), enabled: !!route.projectId });
  const { chat, refusal, clearRefusal } = useAssistantChat(thread);
  const [text, setText] = useState("");
  const input = useRef<TextAreaDomRef>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const busy = chat.isLoading;
  const off = status.data && !status.data.enabled;
  const limited = !!status.data?.limitReached;
  const disabled = !!off || limited;

  const send = (s: string) => {
    const msg = s.trim();
    if (!msg || busy || disabled) return;
    clearRefusal();
    setText("");
    stick.current = true;
    void chat.sendMessage(msg, {
      body: { route: { routeId: route.routeId, params: route.params }, dirty: shell.dirty, language: LANGS.has(language) ? language : "en" },
    });
  };

  // Focus the composer on open; follow new parts unless the user scrolled up to read.
  useEffect(() => { if (shell.open) setTimeout(() => input.current?.focus(), 0); }, [shell.open]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const results = useMemo(() => toolParts(chat.messages), [chat.messages]);
  const last = chat.messages.at(-1);
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  const failed = !busy && (!!chat.error || !!refusal) && last?.role === "user";
  const replies = !busy && !failed && last?.role === "assistant"
    ? nextReplies({ kind, view: view.data }, (k) => t(k)) : [];
  const firstName = (me.data?.user?.name || me.data?.user?.email || "").split(/[ @]/)[0] ?? "";

  const renderPart = (m: UIMessage, p: UIMessage["parts"][number], i: number): ReactNode => {
    if (p.type === "text") {
      if ((p as { metadata?: { fileLabel?: boolean } }).metadata?.fileLabel || !p.content.trim()) return null;
      return m.role === "user"
        ? <div key={i} className="cf-assistant__bubble cf-assistant__bubble--user">{p.content}</div>
        : <div key={i} className="cf-assistant__bubble cf-assistant__bubble--answer"><TextPart content={p.content} role="assistant" /></div>;
    }
    if (p.type === "tool-call") {
      const r = results.get(p.id);
      const output = p.output ?? parse(r?.content);
      const error = r?.error ?? (output && typeof output === "object" && "error" in output && Object.keys(output).length === 1 ? String((output as { error: unknown }).error) : undefined);
      if (!r && p.output === undefined) {
        return (
          <div key={i} className="cf-assistant__busy" aria-live="polite">
            <BusyIndicator active size="S" /><Text>{progressText(p.name, (k) => t(k))}</Text>
          </div>
        );
      }
      return <div key={i} className="cf-assistant__card">{renderTool({ name: p.name, input: p.input, output, error }, { projectId: route.projectId })}</div>;
    }
    return null;
  };

  const files = (m: UIMessage) => m.parts.flatMap((p, i) => {
    if (p.type !== "document" && p.type !== "image") return [];
    const title = (p.metadata as { title?: string } | undefined)?.title ?? "";
    return [<Tag key={i} design="Neutral" wrappingType="None"
      icon={<Icon name={p.type === "document" ? "pdf-attachment" : "attachment-photo"} />}>{title}</Tag>];
  });

  return (
    <>
      <div ref={scroller} className="cf-assistant__body"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }}>
        {off ? (
          <IllustratedMessage name="NoData" design="Spot" titleText={t("ASSISTANT_OFF")} subtitleText={t("ASSISTANT_OFF_SUB")}>
            {status.data?.isAdminHint ? (
              <Link onClick={() => void navigate({ to: "/$slug/settings", search: { tab: "assistant" } })}>{t("ASSISTANT_OFF_SETTINGS")}</Link>
            ) : null}
          </IllustratedMessage>
        ) : null}
        {limited ? <MessageStrip design="Critical" hideCloseButton>{t("ASSISTANT_LIMIT")}</MessageStrip> : null}
        {!off && !chat.messages.length ? (
          <div className="cf-assistant__welcome">
            <Title level="H4">{t("ASSISTANT_HELLO", firstName)}</Title>
            <Text>{t(kind === "configure" ? "ASSISTANT_WELCOME_CONFIGURE" : "ASSISTANT_WELCOME_GENERAL")}</Text>
            <div className="cf-assistant__chips">
              {(kind === "configure" ? ["ASSISTANT_PROMPT_MISSING", "ASSISTANT_PROMPT_UNAVAILABLE"] : ["ASSISTANT_PROMPT_WAITING", "ASSISTANT_PROMPT_MONTH"])
                .map((k) => <Button key={k} icon="ai" disabled={disabled} onClick={() => send(t(k))}>{t(k)}</Button>)}
            </div>
          </div>
        ) : null}
        {chat.messages.map((m) => {
          const parts = m.parts.map((p, i) => renderPart(m, p, i)).filter(Boolean);
          const attached = m.role === "user" ? files(m) : [];
          if (!parts.length && !attached.length) return null;
          return (
            <div key={m.id} className={`cf-assistant__turn${m.role === "user" ? " cf-assistant__turn--user" : ""}`}>
              {attached.length ? <div className="cf-assistant__files">{attached}</div> : null}
              {parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}
            </div>
          );
        })}
        {busy && last?.role === "user" ? (
          <div className="cf-assistant__busy" aria-live="polite"><BusyIndicator active size="S" /><Text>{t("ASSISTANT_WORKING")}</Text></div>
        ) : null}
        {failed ? (
          <MessageStrip design="Negative" hideCloseButton>
            {refusal && i18n.getText(`ASSISTANT_ERR_${refusal.code}`) !== `ASSISTANT_ERR_${refusal.code}`
              ? t(`ASSISTANT_ERR_${refusal.code}`) : t("ASSISTANT_FAILED")}
            {" "}
            {lastUser ? <Link onClick={() => send(textOf(lastUser))}>{t("ASSISTANT_RETRY")}</Link> : null}
          </MessageStrip>
        ) : null}
        {replies.length ? (
          <div className="cf-assistant__chips">
            {replies.map((r) => <Button key={r} onClick={() => send(r)}>{r}</Button>)}
          </div>
        ) : null}
      </div>
      <div className="cf-assistant__foot">
        <div className="cf-assistant__composer">
          <TextArea ref={input} growing growingMaxRows={8} rows={1} value={text} disabled={disabled}
            placeholder={t("ASSISTANT_PLACEHOLDER")} accessibleName={t("ASSISTANT_PLACEHOLDER")}
            onInput={(e) => setText(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
          {busy ? (
            <Button design="Emphasized" icon="stop" tooltip={t("ASSISTANT_STOP")} accessibleName={t("ASSISTANT_STOP")} onClick={() => chat.stop()} />
          ) : (
            <Button design="Emphasized" icon="paper-plane" tooltip={t("ASSISTANT_SEND")} accessibleName={t("ASSISTANT_SEND")}
              disabled={disabled || !text.trim()} onClick={() => send(text)} />
          )}
        </div>
        <Label className="cf-assistant__notice" wrappingType="Normal">
          <span className="cf-assistant__notice--long">{t("ASSISTANT_NOTICE")}</span>
          <span className="cf-assistant__notice--short">{t("ASSISTANT_NOTICE_SHORT")}</span>
        </Label>
      </div>
    </>
  );
}
