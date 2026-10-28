import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { UIMessage } from "@tanstack/ai-react";
import { TextPart } from "@tanstack/ai-react/ui";
import {
  Bar, BusyIndicator, Button, Card, FlexBox, Icon, Label, Link, MessageStrip, Tag, Text, TextArea, Title, Token, Tokenizer,
  type TextAreaDomRef,
} from "@ui5/webcomponents-react";
import { Button as AiButton, ButtonState } from "@ui5/webcomponents-ai-react";
import { confirm } from "@confire/ui/confirm.ts";
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
import { blocks, type ToolCall } from "./steps.ts";
import { Steps, type StepResult } from "./Steps.tsx";
import { READABLE, refuseFile, sendDrop } from "./intake.ts";
import { openQuestions } from "./questions.ts";
import { assistantToggle } from "./toggle.ts";
import { QuestionCard } from "./cards/QuestionCard.tsx";
import { CandidatesCard } from "./cards/CandidatesCard.tsx";
import type { ExtractResult } from "./cards/ExtractionCard.tsx";
import "./assistant.css";

// The assistant panel (assistant spec §4.2, plan "The look"): Joule's side panel, floating over the
// page's right edge. Text is for words, steps for the agent's work (its thinking and tool calls, each
// tool's card behind its line), and a card in the chat only where the user decides (steps.ts DECISION).
// One question on screen at a time. Colours come from the theme's assistant parameters.
// Docked (the AI configuration page) it is the page: laid over the page's slot, with no form beside it.

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
  // The chat's configuration: the page's, else the thread's (one the chat created, followed elsewhere).
  const projectId = route.projectId ?? thread.data?.projectId ?? null;
  const config = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: projectId ?? "" } }), enabled: !!projectId });
  const [wide, setWide] = useState(false);
  const root = useRef<HTMLElement>(null);
  const navigate = useNavigate({ from: "/$slug" });
  const docked = shell.dock !== null;

  // Below the ShellBar, whatever its density: measured when the panel opens.
  useLayoutEffect(() => {
    const bottom = document.querySelector("ui5-shellbar")?.getBoundingClientRect().bottom;
    if (bottom && root.current) root.current.style.setProperty("--cf-shellbar-bottom", `${bottom}px`);
  }, [shell.open]);

  // Docked: over the slot, following it as the side nav opens and closes. The panel stays outside the
  // page's DOM, so the chat — and an answer still streaming — outlives a move to another page.
  // The box is dropped only on leaving the page: `/assistant` → `/assistant/$id` swaps one slot for
  // another, and a panel without its height for that moment loses its scroll to the top.
  useLayoutEffect(() => {
    const slot = shell.dock, me = root.current;
    if (!me) return;
    if (!slot) {
      for (const k of ["top", "left", "width", "height"]) me.style.removeProperty(k);
      return;
    }
    const place = () => {
      const r = slot.getBoundingClientRect();
      Object.assign(me.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(slot);
    addEventListener("resize", place);
    return () => {
      ro.disconnect();
      removeEventListener("resize", place);
    };
  }, [shell.dock]);

  // New chat: a new general thread, or a configuration's thread started over — that one is deleted,
  // so it asks first. Refused while the chat is still answering (the thread's lease). Docked, it is the
  // next configuration: a new general thread on the bare page, and nothing is deleted.
  const [newChatError, setNewChatError] = useState<unknown>(null);
  const newChat = async () => {
    const cleared = docked ? null : route.projectId;
    if (cleared && !(await confirm({
      message: i18n.getText("ASSISTANT_NEW_CHAT_CONFIRM"), actionText: i18n.getText("ASSISTANT_NEW_CHAT"), destructive: true,
    }))) return;
    setNewChatError(null);
    const input = cleared ? { projectId: cleared } : {};
    try {
      const { id } = await client.assistant.newThread(input);
      qc.setQueryData(orpc.assistant.thread.queryKey({ input }), { id, projectId: cleared ?? null, messages: [] });
      if (docked && route.projectId) void navigate({ to: "/$slug/assistant" });
    } catch (e) {
      setNewChatError(e);
    }
  };
  const kind = projectId ? "configure" : kindOf(route);
  const subtitle = projectId ? config.data?.project.name ?? "" : docked ? "" : i18n.getText("ASSISTANT_GENERAL");
  const me = useQuery(meQuery);
  const firstName = (me.data?.user?.name || me.data?.user?.email || "").split(/[ @]/)[0] ?? "";
  // To the configuration's page, the chat floating beside the form.
  const openConfig = (id: string) => {
    if (!shell.open) shell.toggle();
    void navigate({ to: "/$slug/configs/$id", params: { id } });
  };

  return (
    <aside ref={root} className={`cf-assistant${docked ? " cf-assistant--page" : wide ? " cf-assistant--wide" : ""}`}
      hidden={!shell.open && !docked} role={docked ? "region" : "complementary"}
      aria-label={i18n.getText(docked ? "ASSISTANT_PAGE_TITLE" : "ASSISTANT_TITLE")}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape" && !docked) shell.close(); }}>
      {/* A card in both modes, so docking never remounts the chat: docked it is a card on the page,
          floating its frame is the panel's (assistant.css). */}
      <Card className="cf-assistant__card">
        {/* Joule's welcome: the assistant gradient holds the greeting while the chat is empty (ChatView
            marks that with .cf-assistant__welcome) and shrinks to the bar once it starts. */}
        <div className="cf-assistant__head">
          <Bar
            startContent={
              <FlexBox alignItems="Baseline" gap="0.5rem" style={{ minWidth: 0 }}>
                <Title level="H5" wrappingType="None" style={{ flexShrink: 0 }}>
                  {i18n.getText(docked ? "ASSISTANT_PAGE_TITLE" : "ASSISTANT_TITLE")}
                </Title>
                <Label wrappingType="None" style={{ minWidth: 0 }}>{subtitle}</Label>
              </FlexBox>
            }
            endContent={
              docked ? (
                <>
                  {route.projectId ? (
                    <Button design="Transparent" icon="sales-quote" onClick={() => openConfig(route.projectId!)}>
                      {i18n.getText("ASSISTANT_OPEN_CONFIG")}
                    </Button>
                  ) : null}
                  <Button design="Transparent" icon="write-new" onClick={() => void newChat()}>{i18n.getText("ASSISTANT_NEW_CHAT")}</Button>
                </>
              ) : (
                <>
                  <Button design="Transparent" icon="add" tooltip={i18n.getText("ASSISTANT_NEW_CHAT")}
                    accessibleName={i18n.getText("ASSISTANT_NEW_CHAT")} onClick={() => void newChat()} />
                  <Button design="Transparent" icon={wide ? "exit-full-screen" : "full-screen"}
                    tooltip={i18n.getText(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND")}
                    accessibleName={i18n.getText(wide ? "ASSISTANT_COLLAPSE" : "ASSISTANT_EXPAND")} onClick={() => setWide((w) => !w)} />
                  <Button design="Transparent" icon="decline" tooltip={i18n.getText("ASSISTANT_CLOSE")}
                    accessibleName={i18n.getText("ASSISTANT_CLOSE")} onClick={shell.close} />
                </>
              )
            } />
          <div className="cf-assistant__hero">
            <div>
              <FlexBox direction="Column" alignItems="Center" gap="0.5rem" className="cf-assistant__hello">
                <Icon name="ai" />
                <Title level="H3">{i18n.getText("ASSISTANT_HELLO", firstName)}</Title>
                <Text>{i18n.getText(kind === "configure" ? "ASSISTANT_WELCOME_CONFIGURE" : docked ? "ASSISTANT_WELCOME_START" : "ASSISTANT_WELCOME_GENERAL")}</Text>
              </FlexBox>
            </div>
          </div>
        </div>
        {newChatError ? (
          <MessageStrip design="Negative" onClose={() => setNewChatError(null)} style={{ margin: "0.5rem 1rem 0" }}>
            {refusalText(i18n, newChatError)}
          </MessageStrip>
        ) : null}
        {thread.data ? <ChatView key={thread.data.id} thread={thread.data} route={route} kind={kind} />
          : thread.error ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{thread.error.message}</MessageStrip>
          : <BusyIndicator active style={{ margin: "auto" }} />}
      </Card>
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

/** A refusal as the panel says it: its own text for a code it knows, else the server's words. */
function refusalText(i18n: ReturnType<typeof useI18n>, e: unknown): string {
  const code = e instanceof ORPCError ? e.code : (e as { code?: string })?.code;
  const key = `ASSISTANT_ERR_${code}`;
  if (code && i18n.getText(key, String(FILE_MAX_MB)) !== key) return i18n.getText(key, String(FILE_MAX_MB));
  return e instanceof Error ? e.message : i18n.getText("ASSISTANT_FAILED");
}

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === "text" ? p.content : "")).join("");

/** Fiori's AI button with one state: the sparkle and the action's text (quick prompts, Read files). */
const AiAction = ({ text, disabled, onClick }: { text: string; disabled?: boolean; onClick: () => void }) => (
  <AiButton state="go" disabled={disabled} onClick={onClick}><ButtonState name="go" icon="ai" text={text} /></AiButton>
);

/** One line while something runs: the busy dots and what it is doing. */
const Working = ({ text }: { text: string }) => (
  <FlexBox alignItems="Center" gap="0.5rem" aria-live="polite"><BusyIndicator active size="S" /><Label>{text}</Label></FlexBox>
);

/** An answer as it streams, revealed a few characters a frame. The API sends text in bursts of ~12
 *  deltas (~150 characters) every ~350 ms (raw SSE, measured 2026-10-25), and drawing each burst as it
 *  lands shows blocks of text. A twelfth of the backlog per frame keeps up with it; at least two
 *  characters a frame finishes the tail. A stored answer (`live` false at mount) shows whole. */
function AnswerText({ content, live }: { content: string; live: boolean }) {
  const [shown, setShown] = useState(() => (live ? 0 : content.length));
  useEffect(() => {
    if (shown >= content.length) return;
    const id = requestAnimationFrame(() =>
      setShown((n) => Math.min(content.length, n + Math.max(2, Math.ceil((content.length - n) / 12)))));
    return () => cancelAnimationFrame(id);
  }, [shown, content.length]);
  return <TextPart content={content.slice(0, shown)} role="assistant" />;
}

function ChatView({ thread, route, kind }: { thread: Thread; route: RouteContext; kind: Kind }) {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const navigate = useNavigate({ from: "/$slug" });
  // Docked there is no form on screen: a card's "show me the field" leaves for the configuration's page.
  const docked = shell.dock !== null;
  const formHere = docked ? null : route.projectId;
  const { language } = useLanguage();
  const status = useQuery(orpc.assistant.status.queryOptions());
  const { chat, refusal, clearRefusal } = useAssistantChat(thread);
  const invalidate = useAssistantInvalidate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dropError, setDropError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [threadProjectId, setThreadProjectId] = useState(thread.projectId);
  // What the chat works on: the page's configuration, else its own — the tools reach it from any page.
  const projectId = route.projectId ?? threadProjectId;
  const view = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: projectId ?? "" } }), enabled: !!projectId });
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const input = useRef<TextAreaDomRef>(null);
  const picker = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const latest = useRef(chat.messages);
  latest.current = chat.messages;
  const timeline = useQuery({ ...orpc.timeline.list.queryOptions({ input: { projectId: projectId ?? "" } }), enabled: !!projectId });

  const busy = chat.isLoading || !!pending;
  const off = status.data && !status.data.enabled;
  const limited = !!status.data?.limitReached;
  const disabled = !!off || limited;
  const sendLabel = t(chat.isLoading ? "ASSISTANT_STOP" : "ASSISTANT_SEND");

  const errorText = (e: unknown) => refusalText(i18n, e);
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
      append(await sendDrop({ projectId, threadId: thread.id, files, text: msg }));
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
  useEffect(() => { if (shell.open || docked) setTimeout(() => input.current?.focus(), 0); }, [shell.open, docked]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const results = useMemo(() => toolParts(chat.messages), [chat.messages]);
  // One answer per run: its model turns are consecutive assistant messages, drawn as one so its steps
  // fold together. Keyed by the first, so a run that grows never remounts what it already drew.
  const turns = useMemo(() => chat.messages.reduce<{ key: string; m: UIMessage }[]>((out, m) => {
    const prev = out.at(-1);
    if (prev?.m.role === "assistant" && m.role === "assistant") prev.m = { ...m, parts: [...prev.m.parts, ...m.parts] };
    else out.push({ key: m.id, m });
    return out;
  }, []), [chat.messages]);
  const last = chat.messages.at(-1);
  // The model's question stays open until the user's next message: while it is, it is the one question
  // on screen — no question card, no quick replies.
  const asked = last?.role === "assistant" && last.parts.some((p) => p.type === "tool-call" && p.name === "ask_user");
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  const failed = !busy && (!!chat.error || !!refusal) && last?.role === "user";

  // The files on this configuration the chat has not read yet (a client's request comes with its
  // drawing on the timeline): offered as one "Read files" step.
  // By id, and by name: starting a configuration copies the drop to new ids on its timeline.
  const readRefs = new Set(chat.messages.flatMap((m) => m.parts.flatMap((p) => {
    if (p.type !== "document" && p.type !== "image") return [];
    const meta = p.metadata as { title?: string; file?: { id: string; name: string } } | undefined;
    return [meta?.file?.id, meta?.file?.name ?? meta?.title];
  })));
  const unread = projectId ? (timeline.data?.events ?? []).flatMap((e) => {
    const f = e.kind === "file" ? e.payload as { fileId: string; name: string } | null : null;
    const mime = f && (/\.pdf$/i.test(f.name) ? "application/pdf" : /\.png$/i.test(f.name) ? "image/png" : /\.jpe?g$/i.test(f.name) ? "image/jpeg" : null);
    return f && mime && !readRefs.has(f.fileId) && !readRefs.has(f.name) ? [{ kind: "project" as const, id: f.fileId, name: f.name, mime }] : [];
  }) : [];
  const readUnread = async () => {
    setPending(t("ASSISTANT_READING", unread.map((f) => f.name).join(", ")));
    setDropError(null);
    try {
      append((await client.assistant.extract({ threadId: thread.id, projectId: projectId!, refs: unread })).messages as UIMessage[]);
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
  const live = projectId && view.data && chat.messages.length ? view.data : null;
  const questions = live ? openQuestions(live, extracts, kept) : [];
  const replies = !busy && !failed && last?.role === "assistant" && !asked
    ? nextReplies({ kind, view: view.data, asking: questions.length > 0 }, (k) => t(k)) : [];
  const questionKeys = questions.map((q) => q.key);
  const { setQuestionKeys } = shell;
  const projectKey = projectId;
  useEffect(() => { if (projectKey) setQuestionKeys(projectKey, questionKeys); }, [projectKey, questionKeys.join("\u0000"), setQuestionKeys]);
  // The question card writes without the model. Once the user has been through every question (none
  // is left but what they skipped), the answers go to the chat as the user's message: the model knows
  // they are the user's and goes on with what the card does not ask (a broken rule, a table, the
  // candidates, what was skipped) instead of standing still.
  const answered = useRef<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  useEffect(() => {
    if (!live || !questions.every((q) => skipped.includes(q.key)) || !answered.current.length || busy || disabled) return;
    const said = answered.current.join(" · ");
    answered.current = [];
    send(t("ASSISTANT_ANSWERED", said));
  }, [live, questionKeys.join("\u0000"), skipped, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // A started configuration's chat is this thread: the chat works on it from here, and its page (the
  // configuration's, or docked the AI configuration's) opens this same chat.
  const link = (id: string) => {
    setThreadProjectId(id);
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: { projectId: id } }), { id: thread.id, projectId: id, messages: [...latest.current] });
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: {} }), (t: Thread | undefined) => (t?.id === thread.id ? { ...t, projectId: id } : t));
  };
  // The proposal card's Create opens the configuration: its form, or docked the chat's own page.
  const onStarted = async (id: string) => {
    link(id);
    await (docked
      ? navigate({ to: "/$slug/assistant/$id", params: { id } })
      : navigate({ to: "/$slug/configs/$id", params: { id } }));
  };
  // A typed request has no proposal card: the chat creates the configuration itself (configs_create)
  // and goes on with it where the user is; docked, the page follows it.
  const typedStart = !threadProjectId ? chat.messages.flatMap((m) => m.parts.flatMap((p) => {
    if (p.type !== "tool-call" || p.name !== "configs_create") return [];
    const out = (p.output ?? parse(results.get(p.id)?.content)) as { id?: unknown } | undefined;
    return typeof out?.id === "string" ? [out.id] : [];
  })).at(-1) : undefined;
  useEffect(() => {
    if (!typedStart) return;
    if (docked) void onStarted(typedStart);
    else link(typedStart);
  }, [typedStart]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastDropMsg = [...chat.messages].reverse().find((m) => m.role === "user" && m.parts.some((p) => p.type === "document" || p.type === "image"));
  const cardCtx: CardCtx = {
    projectId: formHere, threadId: thread.id, threadProjectId, onStarted,
    append, setPending,
    lastFiles: (lastDropMsg?.parts ?? []).flatMap((p) => (p.type === "document" || p.type === "image") ? [String((p.metadata as { title?: string } | undefined)?.title ?? "")] : []),
    errorText, send, busy,
  };

  /** A tool call's result, none while it runs. A lone `{ error }` output is the tool's refusal. */
  const resultOf = (p: ToolCall): StepResult => {
    const r = results.get(p.id);
    if (!r && p.output === undefined) return undefined;
    const output = p.output ?? parse(r?.content);
    const error = r?.error ?? (output && typeof output === "object" && "error" in output && Object.keys(output).length === 1 ? String((output as { error: unknown }).error) : undefined);
    return { output, error };
  };
  const renderMessage = (m: UIMessage, at: number): ReactNode[] => {
    const bs = blocks(m.parts);
    const answer = turns.slice(at + 1).find((x) => x.m.role === "user")?.m;
    return bs.map((b, i) => {
      if (b.kind === "text") {
        return m.role === "user"
          ? <div key={i} className="cf-assistant__bubble cf-assistant__bubble--user">{b.part.content}</div>
          : <div key={i} className="cf-assistant__bubble cf-assistant__bubble--answer"><AnswerText content={b.part.content} live={chat.isLoading && m.id === last?.id} /></div>;
      }
      const live = chat.isLoading && m.id === last?.id && i === bs.length - 1;
      if (b.kind === "steps") return <Steps key={i} steps={b.steps} live={live} resultOf={resultOf} ctx={cardCtx} />;
      const r = resultOf(b.part);
      if (!r) return live ? <Working key={i} text={progressText(b.part.name, (k) => t(k))} /> : null;
      return (
        <Fragment key={i}>
          {renderTool({ name: b.part.name, input: b.part.input, output: r.output, error: r.error }, { ...cardCtx, ...(answer ? { answer: textOf(answer) } : {}) })}
        </Fragment>
      );
    });
  };

  const attachedOf = (m: UIMessage) => m.parts.flatMap((p, i) => {
    if (p.type !== "document" && p.type !== "image") return [];
    const title = (p.metadata as { title?: string } | undefined)?.title ?? "";
    return [<Tag key={i} design="Neutral" wrappingType="None"
      icon={<Icon name={p.type === "document" ? "pdf-attachment" : "attachment-photo"} />}>{title}</Tag>];
  });

  return (
    <FlexBox direction="Column" className={`cf-assistant__chat${dragging ? " cf-assistant--drop" : ""}`}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) addFiles(e.dataTransfer.files); }}>
      {/* 1 rem from the edge, 1.5 rem between groupings, 0.5 rem inside one. */}
      <FlexBox ref={scroller} direction="Column" gap="1.5rem" className="cf-assistant__body"
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }}>
        {limited ? <MessageStrip design="Critical" hideCloseButton>{t("ASSISTANT_LIMIT")}</MessageStrip> : null}
        {/* The panel never opens while off; the AI configuration page does, so it says why. */}
        {off ? <MessageStrip design="Critical" hideCloseButton>{assistantToggle(status.data, (k) => t(k)).tooltip}</MessageStrip> : null}
        {/* The greeting is the panel's header; this marks the chat as empty for it. */}
        {!off && !chat.messages.length ? (
          <FlexBox wrap="Wrap" gap="0.5rem" justifyContent="Center" className="cf-assistant__welcome">
            {(kind === "configure" ? ["ASSISTANT_PROMPT_MISSING", "ASSISTANT_PROMPT_UNAVAILABLE"] : docked ? [] : ["ASSISTANT_PROMPT_WAITING", "ASSISTANT_PROMPT_MONTH"])
              .map((k) => <AiAction key={k} text={t(k)} disabled={disabled} onClick={() => send(t(k))} />)}
          </FlexBox>
        ) : null}
        {turns.map(({ key, m }, at) => {
          const parts = renderMessage(m, at).filter(Boolean);
          const attached = m.role === "user" ? attachedOf(m) : [];
          if (!parts.length && !attached.length) return null;
          return (
            <FlexBox key={key} direction="Column" gap="0.5rem" alignItems={m.role === "user" ? "End" : undefined}>
              {attached.length ? <FlexBox wrap="Wrap" gap="0.25rem" justifyContent="End">{attached}</FlexBox> : null}
              {parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}
            </FlexBox>
          );
        })}
        {pending ? <Working text={pending} />
          : chat.isLoading && last?.role === "user" ? <Working text={t("ASSISTANT_WORKING")} /> : null}
        {failed ? (
          <MessageStrip design="Negative" hideCloseButton>
            {refusal && i18n.getText(`ASSISTANT_ERR_${refusal.code}`) !== `ASSISTANT_ERR_${refusal.code}`
              ? t(`ASSISTANT_ERR_${refusal.code}`) : t("ASSISTANT_FAILED")}
            {" "}
            {lastUser ? <Link onClick={() => send(textOf(lastUser))}>{t("ASSISTANT_RETRY")}</Link> : null}
          </MessageStrip>
        ) : null}
        {live && questions.length && !asked && !busy ? (
          <QuestionCard projectId={projectId!} view={live} questions={questions} here={formHere === projectId}
            onAnswer={(said) => answered.current.push(said)}
            skipped={skipped} onSkip={(k) => setSkipped((s) => [...s.filter((x) => x !== k), k])}
            onKeep={(k) => setKept((s) => new Set([...s, k]))} />
        ) : null}
        {live && !live.missing.length && live.candidates.rows.length ? <CandidatesCard projectId={projectId!} view={live} /> : null}
        {replies.length ? (
          <FlexBox wrap="Wrap" gap="0.5rem">
            {replies.map((r) => <AiAction key={r} text={r} onClick={() => send(r)} />)}
          </FlexBox>
        ) : null}
      </FlexBox>
      <FlexBox direction="Column" gap="0.5rem" className="cf-assistant__foot">
        {dropError ? <MessageStrip design="Negative" onClose={() => setDropError(null)}>{dropError}</MessageStrip> : null}
        {unread.length && !disabled ? (
          <div><AiAction text={t("ASSISTANT_READ_FILES", String(unread.length))} disabled={busy} onClick={() => void readUnread()} /></div>
        ) : null}
        {files.length ? (
          <Tokenizer accessibleName={t("ASSISTANT_ATTACH")} onTokenDelete={(e) => {
            const gone = new Set(e.detail.tokens.map((x) => Number((x as HTMLElement).dataset.i)));
            setFiles((fs) => fs.filter((_, j) => !gone.has(j)));
          }}>
            {files.map((f, i) => <Token key={`${f.name}${i}`} data-i={i} text={f.name} />)}
          </Tokenizer>
        ) : null}
        <FlexBox alignItems="End" gap="0.5rem" className="cf-assistant__composer">
          <input ref={picker} type="file" multiple accept={READABLE.join(",")} hidden
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
          <Button design="Transparent" icon="attachment" tooltip={t("ASSISTANT_ATTACH")} accessibleName={t("ASSISTANT_ATTACH")}
            disabled={disabled || busy} onClick={() => picker.current?.click()} />
          {/* Enter sends, Shift+Enter breaks the line: a pasted email keeps its lines. */}
          <TextArea ref={input} growing growingMaxRows={8} rows={1} value={text}
            disabled={disabled} readonly={busy} placeholder={t("ASSISTANT_PLACEHOLDER")} accessibleName={t("ASSISTANT_PLACEHOLDER")}
            onInput={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
          {/* Fiori's AI button: send turns into stop while the answer streams. A drop may come without text. */}
          <AiButton design="Emphasized" state={chat.isLoading ? "generating" : "send"}
            disabled={!chat.isLoading && (disabled || busy || (!text.trim() && !files.length))}
            aria-label={sendLabel} accessibilityAttributes={{ root: { title: sendLabel } }}
            onClick={() => (chat.isLoading ? chat.stop() : send(text))}>
            <ButtonState name="send" icon="paper-plane" />
            <ButtonState name="generating" icon="stop" />
          </AiButton>
        </FlexBox>
      </FlexBox>
    </FlexBox>
  );
}
