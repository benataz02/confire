import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { UIMessage } from "@tanstack/ai-react";
import { TextPart } from "@tanstack/ai-react/ui";
import {
  BusyIndicator, Button, FlexBox, Icon, Label, Link, MessageStrip, Tag, ToggleButton, Token, Tokenizer,
  type TextAreaDomRef,
} from "@ui5/webcomponents-react";
import { Button as AiButton, ButtonState } from "@ui5/webcomponents-ai-react";
import { useLanguage } from "@confire/ui/i18n.ts";
import { FILE_MAX_MB } from "@confire/ui/files.ts";
import { formatLocale } from "@confire/ui/format.ts";
import { Composer } from "@confire/ui/Composer.tsx";
import { ORPCError } from "@orpc/client";
import { useI18n } from "../i18n.ts";
import { client, orpc } from "../orpc.ts";
import { useAssistantShell } from "./shell.ts";
import { nextReplies } from "./replies.ts";
import { REPORT_ROUTE, routeContext, type RouteContext } from "./routeContext.ts";
import { useAssistantChat, useAssistantInvalidate, type Refusal, type Thread } from "./useAssistant.ts";
import { progressText, renderTool, useOpenForm, type CardCtx } from "./cards/registry.tsx";
import { blocks, type ToolCall } from "./steps.ts";
import { Steps, type StepResult } from "./Steps.tsx";
import { ACCEPT, extractDrop, fileIcon, fileOfPart, refuseFile, uploadDrop } from "./intake.ts";
import { openQuestions, readAwaitsChat } from "./questions.ts";
import { assistantToggle } from "./toggle.ts";
import { stampText, timeOf } from "./stamp.ts";
import { QuestionCard } from "./cards/QuestionCard.tsx";
import { CandidatesCard } from "./cards/CandidatesCard.tsx";
import type { ExtractResult } from "./cards/ExtractionCard.tsx";
import { staffWritable } from "@confire/ui/timeline/projectStatus.ts";

/** The user's auto-mode switch, a ui_user_state key: the server's assistant/auto.ts AUTO_WRITE_KEY. */
const AUTO_WRITE_KEY = "assistant:autoWrite";

// The chat (assistant spec §4.2), drawn by the panel (Joule spec): its greeting is the panel's
// (`empty`), its composer one row under the chat. Text is for words, steps for the agent's work (its thinking
// and tool calls, each tool's card behind its line), and a card in the chat only where the user decides
// (steps.ts DECISION). One question on screen at a time. Every colour is the panel's `--cf-a-*`
// (palette.ts: Joule's in Horizon, the theme's elsewhere) or a theme parameter, set inline.

/** `report`: a report's chat, on its report's page (Joule spec §5.8). */
export type Kind = "configure" | "general" | "model" | "report";
export const kindOf = (r: RouteContext): Kind =>
  r.projectId ? "configure" : r.routeId === REPORT_ROUTE ? "report" : r.routeId.startsWith("/$slug/models/") ? "model" : "general";

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

/** A failed run as the chat says it: the route's coded refusal, Claude overloaded, else "failed". A
 *  stream's error carries the API's status as `code` and its body as `rawEvent` (the Anthropic adapter);
 *  overloaded is 529, or 503 with `overloaded_error`, or that type mid-stream with no status at all. */
function failureKey(i18n: ReturnType<typeof useI18n>, refusal: Refusal, error: unknown): string {
  if (refusal && i18n.getText(`ASSISTANT_ERR_${refusal.code}`) !== `ASSISTANT_ERR_${refusal.code}`) return `ASSISTANT_ERR_${refusal.code}`;
  const e = error as { code?: string; rawEvent?: { error?: { type?: string } } } | undefined;
  if (e?.code === "529" || e?.code === "503" || e?.rawEvent?.error?.type === "overloaded_error") return "ASSISTANT_ERR_OVERLOADED";
  return "ASSISTANT_FAILED";
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

// The answer's markdown blocks: a paragraph's gap below it.
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

/** The user's message: Joule's bubble, its square bottom-right corner the tail. The answer has none. */
const QUESTION: CSSProperties = {
  maxWidth: "85%", padding: "0.5rem 1rem", borderRadius: "8px 8px 0 8px", background: "var(--cf-a-question)",
  whiteSpace: "pre-wrap", overflowWrap: "anywhere",
};
const ANSWER: CSSProperties = { alignSelf: "flex-start", overflowWrap: "anywhere" };

/** The chat's emphasized buttons (send, the cards' actions) in Joule's colour while the page's stay
 *  blue: custom properties inherit into shadow DOM, so scoping the button parameters is enough. */
const ASSISTANT_BUTTONS = {
  "--sapButton_Emphasized_Background": "var(--cf-a-send)",
  "--sapButton_Emphasized_BorderColor": "var(--cf-a-send)",
  "--sapButton_Emphasized_TextColor": "var(--cf-a-send-text)",
  "--sapButton_Emphasized_Hover_Background": "var(--cf-a-send)",
  "--sapButton_Emphasized_Hover_BorderColor": "var(--cf-a-send)",
} as CSSProperties;

/** A wide chat's reading column, centred by padding so the scrollbar stays at the edge. */
const READING = "max(1rem, (100% - 48rem) / 2)";

/** The chat: its messages, steps and cards, the question and candidates cards, the chat box. `head`
 *  draws above it with what the chat is doing; `welcome`, centred while the chat is empty. */
export function ChatView({ thread, route, kind, head, welcome, wide = false, onTool, prefill }: {
  thread: Thread; route: RouteContext; kind: Kind;
  welcome?: ReactNode;
  /** maximized: the conversation and the composer in a centred reading column */
  wide?: boolean;
  head?: (s: HeadState) => ReactNode;
  /** Once per tool call, when its result first arrives (not for the history it opened with). */
  onTool?: (name: string) => void;
  /** Put this text in the box and focus it, each time `at` changes (a report's chip). */
  prefill?: { text: string; at: number };
}) {
  const shell = useAssistantShell();
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const navigate = useNavigate({ from: "/$slug" });
  const { language } = useLanguage();
  const status = useQuery(orpc.assistant.status.queryOptions());
  const { chat, refusal, declined, clearRefusal } = useAssistantChat(thread);
  const invalidate = useAssistantInvalidate();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dropError, setDropError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [begun, setBegun] = useState(false);
  const [threadProjectId, setThreadProjectId] = useState(thread.projectId);
  // What the chat works on: the page's configuration, else its own — the tools reach it from any page.
  const projectId = route.projectId ?? threadProjectId;
  const view = useQuery({ ...orpc.configs.get.queryOptions({ input: { id: projectId ?? "" } }), enabled: !!projectId });
  // The form on screen, if any: elsewhere a card's "show me the field" leaves for the configuration's page.
  // A client's request's `/configs/$id` is its project page, which draws no form.
  const formHere = route.routeId === "/$slug/configs/$id" && view.data?.request ? null : route.projectId;
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

  /** Runs the first step out of the welcome: the panel's greeting gives way to the chat. */
  const begin = (step: () => void) => { setBegun(true); step(); };

  const addFiles = (list: FileList | File[]) => {
    const picked = [...list];
    const refused = picked.map(refuseFile).find(Boolean);
    setDropError(refused ? errorText(refused) : null);
    setFiles((fs) => [...fs, ...picked.filter((f) => !refuseFile(f))]);
  };

  /** What every chat turn carries besides the user's words: the page, and files dropped with it. */
  const body = (refs?: { kind: "assistant" | "project"; id: string; name: string; mime: string }[]) => ({
    route: { routeId: route.routeId, params: route.params }, dirty: shell.dirty, language: LANGS.has(language) ? language : "en",
    ...(refs?.length ? { refs } : {}),
  });

  /** A drop: on a configuration's chat read into it at once; anywhere else one chat turn with the
   *  user's words, which the chat reads to decide what the files are for. */
  const drop = async (msg: string) => {
    setDropError(null);
    stick.current = true;
    if (projectId) {
      setPending(t("ASSISTANT_READING", files.map((f) => f.name).join(", ")));
      try {
        append(await extractDrop({ projectId, threadId: thread.id, files, text: msg }));
        setFiles([]);
        setText("");
      } catch (e) {
        setDropError(errorText(e));
      } finally {
        setPending(null);
      }
      return;
    }
    setPending(t("ASSISTANT_UPLOADING", files.map((f) => f.name).join(", ")));
    let refs;
    try {
      refs = await uploadDrop(thread.id, files);
    } catch (e) {
      setDropError(errorText(e));
      return;
    } finally {
      setPending(null);
    }
    setFiles([]);
    setText("");
    clearRefusal();
    // The bubble shows the files as the stored turn will; the server takes only the words and `refs`.
    void chat.sendMessage({
      content: [
        ...refs.map((r) => ({ type: "document" as const, source: { type: "data" as const, value: "", mimeType: r.mime }, metadata: { title: r.name, file: r } })),
        ...(msg ? [{ type: "text" as const, content: msg }] : []),
      ],
    }, { body: body(refs) });
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
      void chat.sendMessage(msg, { body: body() });
    });
  };

  // Focus the box on open; follow new parts unless the user scrolled up to read.
  useEffect(() => { if (shell.open) setTimeout(() => input.current?.focus(), 0); }, [shell.open]);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  const results = useMemo(() => toolParts(chat.messages), [chat.messages]);
  // The history it opened with is not news: only results arriving from here on reach onTool.
  const toolsSeen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const done = chat.messages.flatMap((m) => m.parts.flatMap((p) =>
      p.type === "tool-call" && (p.output !== undefined || results.has(p.id)) ? [{ id: p.id, name: p.name }] : []));
    if (!toolsSeen.current) { toolsSeen.current = new Set(done.map((d) => d.id)); return; }
    for (const d of done) if (!toolsSeen.current.has(d.id)) { toolsSeen.current.add(d.id); onTool?.(d.name); }
  }, [chat.messages, results]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    setTimeout(() => input.current?.focus(), 0);
  }, [prefill?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  // One answer per run: its model turns are consecutive assistant messages, drawn as one so its steps
  // fold together. Keyed by the first, so a run that grows never remounts what it already drew; the
  // first also dates the turn. The merged `m` keeps the last message's id, which the live checks compare.
  const turns = useMemo(() => chat.messages.reduce<{ key: string; m: UIMessage; first: UIMessage }[]>((out, m) => {
    const prev = out.at(-1);
    if (prev?.m.role === "assistant" && m.role === "assistant") prev.m = { ...m, parts: [...prev.m.parts, ...m.parts] };
    else out.push({ key: m.id, m, first: m });
    return out;
  }, []), [chat.messages]);
  const last = chat.messages.at(-1);
  // The model's question stays open until the user's next message: while it is, it is the one question
  // on screen — no question card, no quick replies.
  // A SAP write's proposal is the same: it waits for the user's Post or Discard (b1-tools spec §5.6).
  const asked = last?.role === "assistant" && last.parts.some((p) => p.type === "tool-call" && (p.name === "ask_user"
    || ((p.name === "b1_write" || p.name === "b1_copy") && !!(p.output ?? parse(results.get(p.id)?.content) as { proposal?: unknown } | undefined)?.proposal)));
  const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
  // Not only a turn with no answer: a stream error opens an (empty) assistant message first, and a run
  // can fail after steps that ran. The next send clears both.
  const failed = !busy && (!!chat.error || !!refusal);

  // The files on this configuration the chat has not read yet (a client's request comes with its
  // drawing on the timeline): offered as one "Read files" step.
  // By id, and by name: starting a configuration copies the drop to new ids on its timeline.
  const readRefs = new Set(chat.messages.flatMap((m) => m.parts.flatMap((p) => {
    const f = fileOfPart(p);
    return f ? [f.file?.id, f.file?.name ?? f.title] : [];
  })));
  const unread = projectId ? (timeline.data?.events ?? []).flatMap((e) => {
    const f = e.kind === "file" ? e.payload as { fileId: string; name: string } | null : null;
    const mime = f && (/\.pdf$/i.test(f.name) ? "application/pdf" : /\.png$/i.test(f.name) ? "image/png" : /\.jpe?g$/i.test(f.name) ? "image/jpeg"
      : /\.(xlsx|xls|ods|csv)$/i.test(f.name) ? "text/csv" : null);
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
  // Open configuration is a next action, unless its form is what the page shows (a client's request's
  // form is its own page).
  const openForm = useOpenForm();
  const formRoute = view.data?.request ? "/$slug/configs/$id_/configuration" : "/$slug/configs/$id";
  const offerForm = kind === "configure" && !!projectId && !(route.projectId === projectId && route.routeId === formRoute);
  const questionKeys = questions.map((q) => q.key);
  const { setQuestionKeys } = shell;
  const projectKey = projectId;
  useEffect(() => { if (projectKey) setQuestionKeys(projectKey, questionKeys); }, [projectKey, questionKeys.join("\u0000"), setQuestionKeys]);
  // The question card writes without the model. Once the user has been through every question (none
  // is left but what they skipped), the chat takes over: with the answers as the user's message, so the
  // model knows they are the user's, or — a read that left the card nothing to ask, or answers given on
  // the page — once per read with nothing to report. Either way it goes on with what the card does not
  // ask (a table's cells, a broken rule, the candidates, what was skipped) instead of standing still.
  const answered = useRef<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const awaits = readAwaitsChat(chat.messages);
  useEffect(() => {
    if (!live || !questions.every((q) => skipped.includes(q.key)) || busy || disabled) return;
    if (!answered.current.length && !awaits) return;
    const said = answered.current.join(" · ");
    answered.current = [];
    send(said ? t("ASSISTANT_ANSWERED", said) : t("ASSISTANT_GO_ON"));
  }, [live, questionKeys.join("\u0000"), skipped, busy, awaits]); // eslint-disable-line react-hooks/exhaustive-deps

  // A started configuration's chat is this thread: the chat works on it from here, and the panel on the
  // configuration's page opens this same chat.
  const link = (id: string) => {
    setThreadProjectId(id);
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: { projectId: id } }), { id: thread.id, projectId: id, reportId: null, messages: [...latest.current] });
    qc.setQueryData(orpc.assistant.thread.queryKey({ input: {} }), (t: Thread | undefined) => (t?.id === thread.id ? { ...t, projectId: id } : t));
  };
  // The proposal card's Create opens the configuration's form.
  const onStarted = async (id: string) => {
    link(id);
    await navigate({ to: "/$slug/configs/$id", params: { id } });
  };
  // A typed request has no proposal card: the chat creates the configuration itself (configs_create)
  // and goes on with it where the user is.
  const typedStart = !threadProjectId ? chat.messages.flatMap((m) => m.parts.flatMap((p) => {
    if (p.type !== "tool-call" || p.name !== "configs_create") return [];
    const out = (p.output ?? parse(results.get(p.id)?.content)) as { id?: unknown } | undefined;
    return typeof out?.id === "string" ? [out.id] : [];
  })).at(-1) : undefined;
  useEffect(() => { if (typedStart) link(typedStart); }, [typedStart]); // eslint-disable-line react-hooks/exhaustive-deps

  // One thread has a cached copy per way the panel opens it (by id, by configuration, the general one):
  // each run's end is written into every copy, because a chat mounts from its copy and reads it once
  // (useChat's initialMessages) — a chat opened another way must not start an answer behind.
  useEffect(() => {
    if (chat.isLoading) return;
    for (const [key, d] of qc.getQueriesData<Thread>({ queryKey: orpc.assistant.thread.key() }))
      if (d?.id === thread.id && d.messages !== chat.messages) qc.setQueryData(key, { ...d, projectId: threadProjectId, messages: chat.messages });
  }, [chat.messages, chat.isLoading, threadProjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lastDropMsg = [...chat.messages].reverse().find((m) => m.role === "user" && m.parts.some((p) => !!fileOfPart(p)));
  const cardCtx: CardCtx = {
    projectId: formHere, threadId: thread.id, threadProjectId, onStarted,
    append, setPending,
    lastFiles: (lastDropMsg?.parts ?? []).flatMap((p) => { const f = fileOfPart(p); return f ? [f.title] : []; }),
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
    const f = fileOfPart(p);
    if (!f) return [];
    const mime = f.file?.mime ?? (p.type === "image" ? "image/png" : "application/pdf");
    return [<Tag key={i} design="Neutral" wrappingType="None" icon={<Icon name={fileIcon(mime)} />}>{f.title}</Tag>];
  });

  const notices = (
    <>
      {limited ? <MessageStrip design="Critical" hideCloseButton>{t("ASSISTANT_LIMIT")}</MessageStrip> : null}
      {/* The panel never opens while off; one already open when it goes off says why. */}
      {off ? <MessageStrip design="Critical" hideCloseButton>{assistantToggle(status.data, (k) => t(k)).tooltip}</MessageStrip> : null}
    </>
  );
  const dropStrip = dropError ? <MessageStrip design="Negative" onClose={() => setDropError(null)}>{dropError}</MessageStrip> : null;
  // Offered only while extract can write (assertWritable's internal side): a configuration past draft,
  // or a request not in review, would only answer with its lock.
  const project = view.data?.project;
  const writable = !!project && staffWritable(project);
  const readFiles = unread.length && !disabled && writable
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
      <input ref={picker} type="file" multiple accept={ACCEPT} hidden
        onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
      <Button design="Transparent" icon="attachment" tooltip={t("ASSISTANT_ATTACH")} accessibleName={t("ASSISTANT_ATTACH")}
        disabled={disabled || busy} onClick={() => picker.current?.click()} />
    </>
  );
  // Fiori's AI button: send turns into stop while the answer streams. A drop may come without text.
  // UI5's own shape and size, in Joule's colour; with nothing to send it is Joule's pale send colour
  // rather than UI5's faded one.
  const nothing = !chat.isLoading && (disabled || busy || (!text.trim() && !files.length));
  const sendButton = (
    <AiButton design="Emphasized" state={chat.isLoading ? "generating" : "send"} disabled={nothing}
      style={{
        "--sapContent_DisabledOpacity": "1",
        "--sapButton_Emphasized_Background": nothing ? "var(--cf-a-send-empty)" : "var(--cf-a-send)",
        "--sapButton_Emphasized_BorderColor": nothing ? "var(--cf-a-send-empty)" : "var(--cf-a-send)",
      } as CSSProperties}
      aria-label={sendLabel} accessibilityAttributes={{ root: { title: sendLabel } }}
      onClick={() => (chat.isLoading ? chat.stop() : send(text))}>
      <ButtonState name="send" icon="paper-plane" />
      <ButtonState name="generating" icon="stop" />
    </AiButton>
  );
  // Auto mode, the user's own half (b1-tools spec §5.3): drawn only while the workspace allows it. The
  // server reads the stored switch on every write; nothing here rides along with one.
  const auto = status.data?.autoWrite;
  const autoToggle = auto?.allowed ? (
    <ToggleButton design="Transparent" icon="process" pressed={auto.on}
      tooltip={t(auto.on ? "ASSISTANT_AUTO_ON" : "ASSISTANT_AUTO_OFF")} accessibleName={t("ASSISTANT_AUTO_TOGGLE")}
      onClick={() => {
        const on = !auto.on;
        qc.setQueryData(orpc.assistant.status.queryKey(), (d: typeof status.data) => (d ? { ...d, autoWrite: { ...d.autoWrite, on } } : d));
        void client.views.setState({ key: AUTO_WRITE_KEY, value: on ? true : null })
          .finally(() => void qc.invalidateQueries({ queryKey: orpc.assistant.status.key() }));
      }}>
    </ToggleButton>
  ) : null;
  // The composer: Joule's colours, the files above it. Enter sends, Shift+Enter breaks the line: a pasted
  // email keeps its lines.
  const composer = (
    <>
      {tokens}
      <Composer inputRef={input} value={text} onInput={setText} onSend={() => send(text)} disabled={disabled} readonly={busy}
        placeholder={t(kind === "report" ? "REPORT_PLACEHOLDER" : "ASSISTANT_PLACEHOLDER")}
        look={{ background: "var(--cf-a-page)", border: "var(--cf-a-accent)", focus: "var(--cf-a-focus)", hoverShadow: "var(--cf-a-hover-shadow)" }}
        leading={<>{attach}{autoToggle}</>}
        trailing={<>
          {text ? <Button design="Transparent" icon="decline" tooltip={t("ASSISTANT_CLEAR")} accessibleName={t("ASSISTANT_CLEAR")}
            onClick={() => { setText(""); input.current?.focus(); }} /> : null}
          {sendButton}
        </>} />
    </>
  );

  // Quoting starts from a drop, which the welcome says. In the chat, under the welcome, as Joule's.
  const prompts = kind === "configure" ? ["ASSISTANT_PROMPT_MISSING", "ASSISTANT_PROMPT_UNAVAILABLE"]
    : kind === "report" ? [] : ["ASSISTANT_PROMPT_WAITING", "ASSISTANT_PROMPT_MONTH"];
  const quick = empty && !off && prompts.length ? (
    <FlexBox wrap="Wrap" gap="0.5rem" justifyContent="Center" style={{ marginTop: "1.5rem" }}>
      {prompts.map((k) => <AiAction key={k} text={t(k)} disabled={disabled} onClick={() => send(t(k))} />)}
    </FlexBox>
  ) : null;
  const inline = wide ? READING : "1rem";

  return (
    <FlexBox direction="Column"
      style={{
        ...ASSISTANT_BUTTONS, flex: 1, minHeight: 0, position: "relative", isolation: "isolate",
        // The bubbles and steps are plain elements: the theme's font reaches them from here, not from a component.
        fontFamily: "var(--sapFontFamily)", fontSize: "var(--sapFontSize)",
        // Empty, the welcome's colour fills the chat, as Joule's.
        background: empty ? "var(--cf-a-head)" : "var(--cf-a-page)", color: empty ? "var(--cf-a-head-text)" : "var(--cf-a-text)",
        outline: dragging ? "2px dashed var(--sapContent_FocusColor)" : "none", outlineOffset: "-0.5rem",
      }}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) addFiles(e.dataTransfer.files); }}>
      {head?.({ busy, projectId, empty })}
      <>
          {/* 1 rem from the edge, 1.5 rem between groupings, 0.5 rem inside one. */}
          <FlexBox ref={scroller} direction="Column" gap="1.5rem"
            style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBlock: "1rem", paddingInline: inline }}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 40; }}>
            {notices}
            {empty && (welcome || quick) ? <div style={{ marginBlock: "auto", textAlign: "center" }}>{welcome}{quick}</div> : null}
            {turns.map(({ key, m, first }, at) => {
              const parts = renderMessage(m, at).filter(Boolean);
              const attached = m.role === "user" ? attachedOf(m) : [];
              if (!parts.length && !attached.length) return null;
              const when = timeOf(first);
              return (
                <FlexBox key={key} direction="Column" gap="0.5rem" alignItems={m.role === "user" ? "End" : undefined}>
                  {when ? (
                    <div style={{ alignSelf: "center", fontSize: "0.75rem", color: "var(--cf-a-muted)" }}>
                      {stampText(when, new Date(), formatLocale(), t)}
                    </div>
                  ) : null}
                  {attached.length ? <FlexBox wrap="Wrap" gap="0.25rem" justifyContent="End">{attached}</FlexBox> : null}
                  {parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}
                </FlexBox>
              );
            })}
            {pending ? <Working text={pending} />
              : chat.isLoading && last?.role === "user" ? <Working text={t("ASSISTANT_WORKING")} /> : null}
            {declined && !busy && !failed ? (
              <MessageStrip design="Information" hideCloseButton>{t("ASSISTANT_DECLINED")}</MessageStrip>
            ) : null}
            {failed ? (
              <MessageStrip design="Negative" hideCloseButton>
                {t(failureKey(i18n, refusal, chat.error))}
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
                {offerForm ? <AiAction text={t("ASSISTANT_OPEN_CONFIG")} onClick={() => void openForm(projectId!)} /> : null}
                {replies.map((r) => <AiAction key={r} text={r} onClick={() => send(r)} />)}
              </FlexBox>
            ) : null}
          </FlexBox>
          <FlexBox direction="Column" gap="0.5rem" style={{ paddingBlock: "0.5rem 0.625rem", paddingInline: inline }}>
            {dropStrip}
            {readFiles ? <div>{readFiles}</div> : null}
            {composer}
            {/* Joule's faint disclaimer colour is too faint to read: the muted one instead. */}
            <div style={{ textAlign: "center", fontSize: "0.6875rem", color: empty ? "var(--cf-a-head-text)" : "var(--cf-a-muted)" }}>
              {t("ASSISTANT_DISCLAIMER")}
            </div>
          </FlexBox>
      </>
    </FlexBox>
  );
}
