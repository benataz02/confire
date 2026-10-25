import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { UIMessage } from "@tanstack/ai-react";
import { TextPart } from "@tanstack/ai-react/ui";
import {
  Bar, BusyIndicator, Button, Icon, IllustratedMessage, Label, Link, MessageStrip, Tag, Text, TextArea, Title, Token,
} from "@ui5/webcomponents-react";
import type { TextAreaDomRef } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { useLanguage } from "@confire/ui/i18n.ts";
import { FILE_MAX_MB } from "@confire/ui/files.ts";
import { ORPCError } from "@orpc/client";
import { useI18n } from "../i18n.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { nextReplies } from "./replies.ts";
import { routeContext, type RouteContext } from "./routeContext.ts";
import { useAssistantChat, useAssistantInvalidate, useAssistantThread, type Thread } from "./useAssistant.ts";
import { progressText, renderTool, type CardCtx } from "./cards/registry.tsx";
import { READABLE, refuseFile, sendDrop } from "./intake.ts";
import { openQuestions } from "./questions.ts";
import { QuestionCard } from "./cards/QuestionCard.tsx";
import { CandidatesCard } from "./cards/CandidatesCard.tsx";
import type { ExtractResult } from "./cards/ExtractionCard.tsx";
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
  const invalidate = useAssistantInvalidate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dropError, setDropError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [threadProjectId, setThreadProjectId] = useState(thread.projectId);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<TextAreaDomRef>(null);
  const picker = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const latest = useRef(chat.messages);
  latest.current = chat.messages;
  const timeline = useQuery({ ...orpc.timeline.list.queryOptions({ input: { projectId: route.projectId ?? "" } }), enabled: !!route.projectId });

  const busy = chat.isLoading || !!pending;
  const off = status.data && !status.data.enabled;
  const limited = !!status.data?.limitReached;
  const disabled = !!off || limited;

  /** A refusal as the panel says it: its own text for a code it knows, else the server's words. */
  const errorText = (e: unknown) => {
    const code = e instanceof ORPCError ? e.code : (e as { code?: string })?.code;
    const key = `ASSISTANT_ERR_${code}`;
    if (code && i18n.getText(key, String(FILE_MAX_MB)) !== key) return i18n.getText(key, String(FILE_MAX_MB));
    return e instanceof Error ? e.message : t("ASSISTANT_FAILED");
  };
  const append = (ms: UIMessage[]) => { chat.setMessages([...latest.current, ...ms]); invalidate(); };

  const addFiles = (list: FileList | File[]) => {
    const picked = [...list];
    const refused = picked.map(refuseFile).find(Boolean);
    setDropError(refused ? errorText(refused) : null);
    setFiles((fs) => [...fs, ...picked.filter((f) => !refuseFile(f))]);
  };

  const drop = async (msg: string) => {
    setPending(t("ASSISTANT_READING", files.map((f) => f.name).join(", ")));
    setDropError(null);
    stick.current = true;
    try {
      append(await sendDrop({ projectId: route.projectId, threadId: thread.id, files, text: msg }));
      setFiles([]);
      setText("");
    } catch (e) {
      setDropError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  const send = (s: string) => {
    const msg = s.trim();
    if (busy || disabled) return;
    if (files.length) { void drop(msg); return; }
    if (!msg) return;
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

  // The files on this configuration the chat has not read yet (a client's request comes with its
  // drawing on the timeline): offered as one "Read files" step.
  // By id, and by name: starting a configuration copies the drop to new ids on its timeline.
  const readRefs = new Set(chat.messages.flatMap((m) => m.parts.flatMap((p) => {
    if (p.type !== "document" && p.type !== "image") return [];
    const meta = p.metadata as { title?: string; file?: { id: string; name: string } } | undefined;
    return [meta?.file?.id, meta?.file?.name ?? meta?.title];
  })));
  const unread = route.projectId ? (timeline.data?.events ?? []).flatMap((e) => {
    const f = e.kind === "file" ? e.payload as { fileId: string; name: string } | null : null;
    const mime = f && (/\.pdf$/i.test(f.name) ? "application/pdf" : /\.png$/i.test(f.name) ? "image/png" : /\.jpe?g$/i.test(f.name) ? "image/jpeg" : null);
    return f && mime && !readRefs.has(f.fileId) && !readRefs.has(f.name) ? [{ kind: "project" as const, id: f.fileId, name: f.name, mime }] : [];
  }) : [];
  const readUnread = async () => {
    setPending(t("ASSISTANT_READING", unread.map((f) => f.name).join(", ")));
    setDropError(null);
    try {
      append((await client.assistant.extract({ threadId: thread.id, projectId: route.projectId!, refs: unread })).messages as UIMessage[]);
    } catch (e) {
      setDropError(errorText(e));
    } finally {
      setPending(null);
    }
  };

  // The configuration's live state, under the chat: what is still open, then what can be picked.
  const extracts = chat.messages.flatMap((m) => m.parts.flatMap((p) =>
    p.type === "tool-call" && p.name === "extract_values" ? [(p.output ?? parse(results.get(p.id)?.content)) as ExtractResult] : []))
    .filter((x) => x && Array.isArray(x.questions));
  const live = route.projectId && view.data && chat.messages.length ? view.data : null;
  const questions = live ? openQuestions(live, extracts, kept) : [];
  const questionKeys = questions.map((q) => q.key);
  const { setQuestionKeys } = shell;
  const projectKey = route.projectId;
  useEffect(() => { if (projectKey) setQuestionKeys(projectKey, questionKeys); }, [projectKey, questionKeys.join("\u0000"), setQuestionKeys]);

  const lastDropMsg = [...chat.messages].reverse().find((m) => m.role === "user" && m.parts.some((p) => p.type === "document" || p.type === "image"));
  const cardCtx: CardCtx = {
    projectId: route.projectId, threadId: thread.id, threadProjectId,
    onStarted: (id) => {
      setThreadProjectId(id);
      // The configuration's thread is this one: the panel keeps this chat on its page.
      qc.setQueryData(orpc.assistant.thread.queryKey({ input: { projectId: id } }), { id: thread.id, projectId: id, messages: [...latest.current] });
    },
    append, setPending,
    lastFiles: (lastDropMsg?.parts ?? []).flatMap((p) => (p.type === "document" || p.type === "image") ? [String((p.metadata as { title?: string } | undefined)?.title ?? "")] : []),
    errorText,
  };

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
      return <div key={i} className="cf-assistant__card">{renderTool({ name: p.name, input: p.input, output, error }, cardCtx)}</div>;
    }
    return null;
  };

  const attachedOf = (m: UIMessage) => m.parts.flatMap((p, i) => {
    if (p.type !== "document" && p.type !== "image") return [];
    const title = (p.metadata as { title?: string } | undefined)?.title ?? "";
    return [<Tag key={i} design="Neutral" wrappingType="None"
      icon={<Icon name={p.type === "document" ? "pdf-attachment" : "attachment-photo"} />}>{title}</Tag>];
  });

  return (
    <div className={`cf-assistant__chat${dragging ? " cf-assistant--drop" : ""}`}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) addFiles(e.dataTransfer.files); }}>
      <div ref={scroller} className="cf-assistant__body"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }}>
        {off ? (
          // Two different fixes: an admin turns the switch on; whoever runs the server sets its API key.
          <IllustratedMessage name="NoData" design="Spot"
            titleText={t(status.data?.reason === "no_key" ? "ASSISTANT_NO_KEY" : "ASSISTANT_OFF")}
            subtitleText={t(status.data?.reason === "no_key" ? "ASSISTANT_NO_KEY_SUB" : "ASSISTANT_OFF_SUB")}>
            {status.data?.isAdminHint && status.data.reason === "switch" ? (
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
          const attached = m.role === "user" ? attachedOf(m) : [];
          if (!parts.length && !attached.length) return null;
          return (
            <div key={m.id} className={`cf-assistant__turn${m.role === "user" ? " cf-assistant__turn--user" : ""}`}>
              {attached.length ? <div className="cf-assistant__files">{attached}</div> : null}
              {parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}
            </div>
          );
        })}
        {pending ? (
          <div className="cf-assistant__busy" aria-live="polite"><BusyIndicator active size="S" /><Text>{pending}</Text></div>
        ) : chat.isLoading && last?.role === "user" ? (
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
        {live && questions.length ? (
          <div className="cf-assistant__card">
            <QuestionCard projectId={route.projectId!} view={live} questions={questions} here
              onKeep={(k) => setKept((s) => new Set([...s, k]))} />
          </div>
        ) : null}
        {live && !live.missing.length && live.candidates.rows.length ? (
          <div className="cf-assistant__card"><CandidatesCard projectId={route.projectId!} view={live} /></div>
        ) : null}
        {replies.length ? (
          <div className="cf-assistant__chips">
            {replies.map((r) => <Button key={r} onClick={() => send(r)}>{r}</Button>)}
          </div>
        ) : null}
      </div>
      <div className="cf-assistant__foot">
        {dropError ? <MessageStrip design="Negative" onClose={() => setDropError(null)}>{dropError}</MessageStrip> : null}
        {unread.length && !disabled ? (
          <div><Button icon="ai" disabled={busy} onClick={() => void readUnread()}>{t("ASSISTANT_READ_FILES", String(unread.length))}</Button></div>
        ) : null}
        {files.length ? (
          <div className="cf-assistant__chips">
            {files.map((f, i) => (
              <Token key={`${f.name}${i}`} text={f.name} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}
                aria-label={t("ASSISTANT_REMOVE_FILE", f.name)} />
            ))}
          </div>
        ) : null}
        <div className="cf-assistant__composer">
          <input ref={picker} type="file" multiple accept={READABLE.join(",")} hidden
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <Button design="Transparent" icon="attachment" tooltip={t("ASSISTANT_ATTACH")} accessibleName={t("ASSISTANT_ATTACH")}
            disabled={disabled || busy} onClick={() => picker.current?.click()} />
          <TextArea ref={input} growing growingMaxRows={8} rows={1} value={text} disabled={disabled}
            placeholder={t("ASSISTANT_PLACEHOLDER")} accessibleName={t("ASSISTANT_PLACEHOLDER")}
            onInput={(e) => setText(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
          {busy ? (
            <Button design="Emphasized" icon="stop" tooltip={t("ASSISTANT_STOP")} accessibleName={t("ASSISTANT_STOP")} onClick={() => chat.stop()} />
          ) : (
            <Button design="Emphasized" icon="paper-plane" tooltip={t("ASSISTANT_SEND")} accessibleName={t("ASSISTANT_SEND")}
              disabled={disabled || (!text.trim() && !files.length)} onClick={() => send(text)} />
          )}
        </div>
        <Label className="cf-assistant__notice" wrappingType="Normal">
          <span className="cf-assistant__notice--long">{t("ASSISTANT_NOTICE")}</span>
          <span className="cf-assistant__notice--short">{t("ASSISTANT_NOTICE_SHORT")}</span>
        </Label>
      </div>
    </div>
  );
}
