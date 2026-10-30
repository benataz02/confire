import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { UIMessage } from "@tanstack/ai-react";
import { TextPart } from "@tanstack/ai-react/ui";
import {
  BusyIndicator, Button, FlexBox, HeroBanner, Icon, Label, Link, MessageStrip, Tag, Text, TextArea, Token, Tokenizer,
  type TextAreaDomRef,
} from "@ui5/webcomponents-react";
import { Button as AiButton, ButtonState } from "@ui5/webcomponents-ai-react";
import { useLanguage } from "@confire/ui/i18n.ts";
import { FILE_MAX_MB } from "@confire/ui/files.ts";
import { ORPCError } from "@orpc/client";
import { useI18n } from "../i18n.ts";
import { client, meQuery, orpc } from "../orpc.ts";
import { useAssistantShell } from "./AssistantProvider.tsx";
import { nextReplies } from "./replies.ts";
import { routeContext, type RouteContext } from "./routeContext.ts";
import { useAssistantChat, useAssistantInvalidate, type Thread } from "./useAssistant.ts";
import { progressText, renderTool, type CardCtx } from "./cards/registry.tsx";
import { blocks, type ToolCall } from "./steps.ts";
import { Steps, type StepResult } from "./Steps.tsx";
import { READABLE, refuseFile, sendDrop } from "./intake.ts";
import { openQuestions } from "./questions.ts";
import { assistantToggle } from "./toggle.ts";
import { QuestionCard } from "./cards/QuestionCard.tsx";
import { CandidatesCard } from "./cards/CandidatesCard.tsx";
import type { ExtractResult } from "./cards/ExtractionCard.tsx";

// The chat (assistant spec §4.2), drawn by the panel and by the AI page. Empty on the page, it is a
// welcome: a HeroBanner with the greeting and the chat box inside, which the first send turns into the
// chat — the messages, and the same box at their foot. The panel's greeting is its head's (`empty`), its
// composer one row under the chat. Text is for words, steps for the agent's work (its thinking
// and tool calls, each tool's card behind its line), and a card in the chat only where the user decides
// (steps.ts DECISION). One question on screen at a time. Every colour is a theme parameter, set inline.

export type Kind = "configure" | "general" | "model";
export const kindOf = (r: RouteContext): Kind =>
  r.projectId ? "configure" : r.routeId.startsWith("/$slug/models/") ? "model" : "general";

/** What the chat tells the head drawn above it. */
export type HeadState = { busy: boolean; projectId: string | null; empty: boolean };

const LANGS = new Set(["en", "es", "eu"]);

/** The deepest route match, as a string so the selector is stable between renders. */
export function useRoute(): RouteContext {
  const key = useRouterState({
    select: (s) => { const m = s.matches.at(-1); return m ? JSON.stringify([m.routeId, m.params]) : ""; },
  });
  return useMemo(() => {
    if (!key) return routeContext([]);
    const [routeId, params] = JSON.parse(key) as [string, Record<string, string>];
    return routeContext([{ routeId, params }]);
  }, [key]);
}

/** A refusal as the chat says it: its own text for a code it knows, else the server's words. */
export function refusalText(i18n: ReturnType<typeof useI18n>, e: unknown): string {
  const code = e instanceof ORPCError ? e.code : (e as { code?: string })?.code;
  const key = `ASSISTANT_ERR_${code}`;
  if (code && i18n.getText(key, String(FILE_MAX_MB)) !== key) return i18n.getText(key, String(FILE_MAX_MB));
  return e instanceof Error ? e.message : i18n.getText("ASSISTANT_FAILED");
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

/** Fiori's AI button with one state: the sparkle and the action's text (quick prompts, Read files). */
const AiAction = ({ text, disabled, onClick }: { text: string; disabled?: boolean; onClick: () => void }) => (
  <AiButton state="go" disabled={disabled} onClick={onClick}><ButtonState name="go" icon="ai" text={text} /></AiButton>
);

/** One line while something runs: the busy dots and what it is doing. */
const Working = ({ text }: { text: string }) => (
  <FlexBox alignItems="Center" gap="0.5rem" aria-live="polite"><BusyIndicator active size="S" /><Label>{text}</Label></FlexBox>
);

// The answer's markdown blocks: a paragraph's gap below it, which the bubble's missing bottom padding
// takes back on the last one (no stylesheet, so no :last-child).
const block = { margin: "0 0 0.5rem" };
const MARKDOWN = {
  p: (p: object) => <p {...p} style={block} />,
  ul: (p: object) => <ul {...p} style={{ ...block, paddingInlineStart: "1.25rem" }} />,
  ol: (p: object) => <ol {...p} style={{ ...block, paddingInlineStart: "1.25rem" }} />,
};

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
  return <TextPart content={content.slice(0, shown)} role="assistant" components={MARKDOWN} />;
}

const BUBBLE: CSSProperties = {
  maxWidth: "85%", padding: "0.5rem 0.75rem", borderRadius: "var(--sapElement_BorderCornerRadius)", overflowWrap: "anywhere",
};
const QUESTION: CSSProperties = {
  ...BUBBLE, whiteSpace: "pre-wrap",
  background: "var(--sapAssistant_Question_Background)", color: "var(--sapAssistant_Question_TextColor)",
  border: "1px solid var(--sapAssistant_Question_BorderColor)",
};
const ANSWER: CSSProperties = {
  ...BUBBLE, alignSelf: "flex-start", paddingBottom: 0,
  background: "var(--sapAssistant_Answer_Background)", color: "var(--sapAssistant_Answer_TextColor)",
  border: "1px solid var(--sapAssistant_Answer_BorderColor)",
};

/** The chat's emphasized buttons (send, the cards' actions) in the assistant's colour while the page's
 *  stay blue: custom properties inherit into shadow DOM, so scoping the button parameters is enough. */
const ASSISTANT_BUTTONS = {
  "--sapButton_Emphasized_Background": "var(--sapAssistant_Background)",
  "--sapButton_Emphasized_BorderColor": "var(--sapAssistant_BorderColor)",
  "--sapButton_Emphasized_TextColor": "var(--sapAssistant_TextColor)",
  "--sapButton_Emphasized_Hover_Background": "var(--sapAssistant_Hover_Background)",
  "--sapButton_Emphasized_Hover_BorderColor": "var(--sapAssistant_Hover_BorderColor)",
} as CSSProperties;

/** The welcome's banner in Joule's gradient rather than the shell's blue: its parameters are read on
 *  its own host, so setting them here is enough. Flat black in the high-contrast themes. */
const BANNER = {
  "--sapShell_HeroBanner_Background": "var(--sapAssistant_Background)",
  "--sapShell_HeroBanner_BackgroundImage": "var(--sapAssistant_BackgroundGradient)",
  "--sapShell_HeroBanner_TextColor": "var(--sapAssistant_TextColor)",
} as CSSProperties;

/** The chat box: a field-coloured box around a borderless textarea and its buttons. The textarea's own
 *  field look is switched off through its public parameters, and the box draws the focus instead. */
const BOX: CSSProperties = {
  padding: "0.25rem 0.5rem 0.5rem",
  background: "var(--sapField_Background)",
  border: "var(--sapField_BorderWidth) solid var(--sapField_BorderColor)",
  borderRadius: "var(--sapTile_BorderCornerRadius)",
  boxShadow: "var(--sapContent_Shadow1)",
  // One name in both places, so the browser moves the box from the banner to the foot (begin()).
  viewTransitionName: "cf-chat-box",
};
const FOCUS = "var(--sapContent_FocusWidth) var(--sapContent_FocusStyle) var(--sapContent_FocusColor)";
const BARE_FIELD = {
  width: "100%",
  margin: 0,
  "--sapField_Background": "transparent",
  "--sapField_Hover_Background": "transparent",
  "--sapField_Focus_Background": "transparent",
  "--sapField_ReadOnly_Background": "transparent",
  "--sapField_BackgroundStyle": "none",
  "--sapField_Hover_BackgroundStyle": "none",
  "--sapField_ReadOnly_BackgroundStyle": "none",
  "--sapField_BorderWidth": "0",
  "--sapField_Shadow": "none",
  "--sapField_Hover_Shadow": "none",
  "--sapContent_FocusWidth": "0",
} as CSSProperties;
/** The panel's composer is a row instead — attach, the field, send — with the textarea as tall as its
 *  buttons at one row (36 px cozy, 26 compact): UI5 draws it 2 px taller (line + 8/7 px padding + a 1 px
 *  wrapper edge each side). Its padding variables also size the mirror `growing` measures, so they are
 *  the one knob — private (`--_ui5_`), so recheck on a UI5 bump; at worst it is 2 px off again. The
 *  margin is UI5's block margin, which buttons do not have. */
const ROW_FIELD = {
  flex: 1,
  margin: 0,
  "--_ui5_textarea_padding_top": "var(--_ui5-compact-size, .125rem) var(--_ui5-cozy-size, .4375rem)",
  "--_ui5_textarea_padding_bottom": "var(--_ui5-compact-size, .0625rem) var(--_ui5-cozy-size, .375rem)",
} as CSSProperties;

/** On the AI page the reading column is centred by padding, so the scrollbar stays at the page's edge. */
const READING = "max(1rem, (100% - 48rem) / 2)";

/** The chat: its messages, steps and cards, the question and candidates cards, the chat box. `page` is
 *  the AI page (no form beside it); `head` draws above it with what the chat is doing. */
export function ChatView({ thread, route, kind, page = false, head }: {
  thread: Thread; route: RouteContext; kind: Kind; page?: boolean;
  head?: (s: HeadState) => ReactNode;
}) {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const navigate = useNavigate({ from: "/$slug" });
  // The form on screen, if any: elsewhere a card's "show me the field" leaves for the configuration's page.
  const formHere = route.projectId;
  const { language } = useLanguage();
  const me = useQuery(meQuery);
  const status = useQuery(orpc.assistant.status.queryOptions());
  const { chat, refusal, clearRefusal } = useAssistantChat(thread);
  const invalidate = useAssistantInvalidate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dropError, setDropError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const [begun, setBegun] = useState(false);
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
  const empty = !chat.messages.length && !begun;
  const off = status.data && !status.data.enabled;
  const limited = !!status.data?.limitReached;
  const disabled = !!off || limited;
  const sendLabel = t(chat.isLoading ? "ASSISTANT_STOP" : "ASSISTANT_SEND");

  const errorText = (e: unknown) => refusalText(i18n, e);
  const append = (ms: UIMessage[]) => { chat.setMessages([...latest.current, ...ms]); invalidate(); };

  /** Runs the first step out of the welcome. On the page the banner gives way to the chat, the box
   *  gliding to the foot: the step runs inside the transition, so its first render lands in the new
   *  picture. The panel's greeting collapses on its own (its head's `empty`). */
  const begin = (step: () => void) => {
    if (!page || !empty || !document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setBegun(true);
      step();
      return;
    }
    document.startViewTransition(() => { flushSync(() => setBegun(true)); step(); });
  };

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
    if (files.length) { begin(() => void drop(msg)); return; }
    if (!msg) return;
    begin(() => {
      clearRefusal();
      setText("");
      stick.current = true;
      void chat.sendMessage(msg, {
        body: { route: { routeId: route.routeId, params: route.params }, dirty: shell.dirty, language: LANGS.has(language) ? language : "en" },
      });
    });
  };

  // Focus the box on open and once it moved to the foot; follow new parts unless the user scrolled up to read.
  useEffect(() => { if (shell.open || page) setTimeout(() => input.current?.focus(), 0); }, [shell.open, page, empty]);
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

  // A started configuration's chat is this thread: the chat works on it from here, and the panel on the
  // configuration's page opens this same chat.
  const link = (id: string) => {
    setThreadProjectId(id);
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: { projectId: id } }), { id: thread.id, projectId: id, messages: [...latest.current] });
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: {} }), (t: Thread | undefined) => (t?.id === thread.id ? { ...t, projectId: id } : t));
  };
  // The proposal card's Create opens the configuration's form; the AI page stays where it is, and
  // offers "Open configuration" in its head.
  const onStarted = async (id: string) => {
    link(id);
    if (!page) await navigate({ to: "/$slug/configs/$id", params: { id } });
  };
  // A typed request has no proposal card: the chat creates the configuration itself (configs_create)
  // and goes on with it where the user is.
  const typedStart = !threadProjectId ? chat.messages.flatMap((m) => m.parts.flatMap((p) => {
    if (p.type !== "tool-call" || p.name !== "configs_create") return [];
    const out = (p.output ?? parse(results.get(p.id)?.content)) as { id?: unknown } | undefined;
    return typeof out?.id === "string" ? [out.id] : [];
  })).at(-1) : undefined;
  useEffect(() => { if (typedStart) link(typedStart); }, [typedStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // One thread has a cached copy per place it opens (the AI page by id, the panel by configuration):
  // each run's end is written into every copy, because a chat mounts from its copy and reads it once
  // (useChat's initialMessages) — the panel opened from the AI page must not start an answer behind.
  useEffect(() => {
    if (chat.isLoading) return;
    for (const [key, d] of qc.getQueriesData<Thread>({ queryKey: orpc.assistant.thread.key() }))
      if (d?.id === thread.id && d.messages !== chat.messages) qc.setQueryData(key, { ...d, projectId: threadProjectId, messages: chat.messages });
  }, [chat.messages, chat.isLoading, threadProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
          ? <div key={i} style={QUESTION}>{b.part.content}</div>
          : <div key={i} style={ANSWER}><AnswerText content={b.part.content} live={chat.isLoading && m.id === last?.id} /></div>;
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

  const notices = (
    <>
      {limited ? <MessageStrip design="Critical" hideCloseButton>{t("ASSISTANT_LIMIT")}</MessageStrip> : null}
      {/* The panel never opens while off; the AI page does, so it says why. */}
      {off ? <MessageStrip design="Critical" hideCloseButton>{assistantToggle(status.data, (k) => t(k)).tooltip}</MessageStrip> : null}
    </>
  );
  const dropStrip = dropError ? <MessageStrip design="Negative" onClose={() => setDropError(null)}>{dropError}</MessageStrip> : null;
  const readFiles = unread.length && !disabled
    ? <AiAction text={t("ASSISTANT_READ_FILES", String(unread.length))} disabled={busy} onClick={() => begin(() => void readUnread())} />
    : null;

  const tokens = files.length ? (
    <Tokenizer accessibleName={t("ASSISTANT_ATTACH")} onTokenDelete={(e) => {
      const gone = new Set(e.detail.tokens.map((x) => Number((x as HTMLElement).dataset.i)));
      setFiles((fs) => fs.filter((_, j) => !gone.has(j)));
    }}>
      {files.map((f, i) => <Token key={`${f.name}${i}`} data-i={i} text={f.name} />)}
    </Tokenizer>
  ) : null;
  const attach = (
    <>
      <input ref={picker} type="file" multiple accept={READABLE.join(",")} hidden
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
      <Button design="Transparent" icon="attachment" tooltip={t("ASSISTANT_ATTACH")} accessibleName={t("ASSISTANT_ATTACH")}
        disabled={disabled || busy} onClick={() => picker.current?.click()} />
    </>
  );
  // Enter sends, Shift+Enter breaks the line: a pasted email keeps its lines.
  const field = (
    <TextArea ref={input} growing growingMaxRows={8} rows={page && empty ? 3 : 1} value={text} style={page ? BARE_FIELD : ROW_FIELD}
      disabled={disabled} readonly={busy} placeholder={t("ASSISTANT_PLACEHOLDER")} accessibleName={t("ASSISTANT_PLACEHOLDER")}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onInput={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
  );
  // Fiori's AI button: send turns into stop while the answer streams. A drop may come without text.
  const sendButton = (
    <AiButton design="Emphasized" state={chat.isLoading ? "generating" : "send"}
      disabled={!chat.isLoading && (disabled || busy || (!text.trim() && !files.length))}
      aria-label={sendLabel} accessibilityAttributes={{ root: { title: sendLabel } }}
      onClick={() => (chat.isLoading ? chat.stop() : send(text))}>
      <ButtonState name="send" icon="paper-plane" />
      <ButtonState name="generating" icon="stop" />
    </AiButton>
  );
  // The page's chat box, its buttons under the field; the panel's composer, one row.
  const composer = page ? (
    <FlexBox direction="Column" gap="0.25rem" style={{ ...BOX, outline: focused ? FOCUS : "none" }}>
      {tokens}
      {field}
      <FlexBox alignItems="Center" justifyContent="SpaceBetween">{attach}{sendButton}</FlexBox>
    </FlexBox>
  ) : (
    <>
      {tokens}
      <FlexBox alignItems="End" gap="0.5rem">{attach}{field}{sendButton}</FlexBox>
    </>
  );

  const prompts = kind === "configure" ? ["ASSISTANT_PROMPT_MISSING", "ASSISTANT_PROMPT_UNAVAILABLE"]
    : page ? [] : ["ASSISTANT_PROMPT_WAITING", "ASSISTANT_PROMPT_MONTH"];
  const firstName = (me.data?.user?.name || me.data?.user?.email || "").split(/[ @]/)[0] ?? "";
  const inline = page ? READING : "1rem";

  return (
    <FlexBox direction="Column"
      style={{
        ...ASSISTANT_BUTTONS, flex: 1, minHeight: 0,
        // The bubbles and steps are plain elements: the theme's font reaches them from here, not from a component.
        fontFamily: "var(--sapFontFamily)", fontSize: "var(--sapFontSize)", color: "var(--sapTextColor)",
        outline: dragging ? "2px dashed var(--sapContent_FocusColor)" : "none", outlineOffset: "-0.5rem",
      }}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) addFiles(e.dataTransfer.files); }}>
      {head?.({ busy, projectId, empty })}
      {page && empty ? (
        <FlexBox direction="Column" justifyContent="Center"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBlock: "1.5rem", paddingInline: inline }}>
          <HeroBanner style={BANNER} headerText={t("ASSISTANT_HELLO", firstName)} overlineText={t("ASSISTANT_PAGE_TITLE")}>
            <FlexBox direction="Column" gap="1rem">
              <Text style={{ color: "inherit" }}>{t(kind === "configure" ? "ASSISTANT_WELCOME_CONFIGURE" : "ASSISTANT_WELCOME_START")}</Text>
              {notices}
              {dropStrip}
              {composer}
              {readFiles || prompts.length ? (
                <FlexBox wrap="Wrap" gap="0.5rem">
                  {readFiles}
                  {prompts.map((k) => <AiAction key={k} text={t(k)} disabled={disabled} onClick={() => send(t(k))} />)}
                </FlexBox>
              ) : null}
            </FlexBox>
          </HeroBanner>
        </FlexBox>
      ) : (
        <>
          {/* 1 rem from the edge, 1.5 rem between groupings, 0.5 rem inside one. */}
          <FlexBox ref={scroller} direction="Column" gap="1.5rem"
            style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBlock: "1rem", paddingInline: inline }}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }}>
            {notices}
            {/* The panel's empty chat: its greeting is the head's (`empty`), the quick prompts are here. */}
            {empty && !off && prompts.length ? (
              <FlexBox wrap="Wrap" gap="0.5rem" justifyContent="Center">
                {prompts.map((k) => <AiAction key={k} text={t(k)} disabled={disabled} onClick={() => send(t(k))} />)}
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
          <FlexBox direction="Column" gap="0.5rem" style={page
            ? { paddingBlock: "0.5rem 1rem", paddingInline: READING }
            : { padding: "0.5rem 1rem 0.75rem", borderTop: "1px solid var(--sapGroup_TitleBorderColor)" }}>
            {dropStrip}
            {readFiles ? <div>{readFiles}</div> : null}
            {composer}
          </FlexBox>
        </>
      )}
    </FlexBox>
  );
}
