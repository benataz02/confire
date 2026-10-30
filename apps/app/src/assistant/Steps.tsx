import { useEffect, useState, type CSSProperties } from "react";
import { BusyIndicator, Icon } from "@ui5/webcomponents-react";
import { useI18n } from "../i18n.ts";
import { CARDS, progressText, renderTool, type CardCtx } from "./cards/registry.tsx";
import { stepSummary, type Step, type ToolCall } from "./steps.ts";

// The agent's work between its words (Claude Code's tool lines): its thinking and each tool call, one
// line each with what it found, the tool's card behind the line, in the theme's small label text with a
// rule down the run's left. Open while the agent works, folded to "N steps" once it answers; a fold or
// an unfold the user makes later is theirs. Native <details>, styled inline.

/** A tool call's result, once it has one. */
export type StepResult = { output: unknown; error?: string } | undefined;

const LINE: CSSProperties = { display: "flex", alignItems: "center", gap: "0.375rem", minHeight: "1.5rem" };
const SUMMARY: CSSProperties = { ...LINE, listStyle: "none", cursor: "pointer" };
const ICON: CSSProperties = { width: "0.875rem", height: "0.875rem", flexShrink: 0, color: "var(--sapContent_IconColor)" };
const ERROR: CSSProperties = { ...ICON, color: "var(--sapNegativeTextColor)" };
const NAME: CSSProperties = { color: "var(--sapTextColor)" };

export function Steps({ steps, live, resultOf, ctx }: {
  steps: Step[];
  /** the chat is still working on this run of steps */
  live: boolean;
  resultOf: (call: ToolCall) => StepResult;
  ctx: CardCtx;
}) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  const last = steps.at(-1);
  const calls = steps.filter((s): s is ToolCall => s.type === "tool-call");
  const running = live ? calls.find((c) => !resultOf(c)) : undefined;
  const head = live
    ? running ? progressText(running.name, t) : last?.type === "thinking" ? t("ASSISTANT_THINKING") : t("ASSISTANT_WORKING")
    : !calls.length ? t("ASSISTANT_THOUGHT")
    : calls.length === 1 ? t("ASSISTANT_STEPS_1") : t("ASSISTANT_STEPS_N", String(calls.length));

  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}
      style={{ alignSelf: "stretch", fontSize: "var(--sapFontSmallSize)", color: "var(--sapContent_LabelColor)" }}>
      <summary aria-live={live ? "polite" : undefined} style={SUMMARY}>
        {live ? <BusyIndicator active size="S" /> : <Icon name={open ? "slim-arrow-down" : "slim-arrow-right"} style={ICON} />}
        <span>{head}</span>
      </summary>
      <div style={{
        display: "flex", flexDirection: "column", gap: "0.125rem", margin: "0.25rem 0 0 0.4rem",
        paddingInlineStart: "0.75rem", borderInlineStart: "1px solid var(--sapGroup_TitleBorderColor)",
      }}>
        {steps.map((s, i) => s.type === "thinking" ? (
          <details key={i} open={(live && s === last) || undefined}>
            <summary style={SUMMARY}>
              <Icon name="lightbulb" style={ICON} />
              <span style={NAME}>{t(live && s === last ? "ASSISTANT_THINKING" : "ASSISTANT_THOUGHT")}</span>
            </summary>
            <div style={{
              margin: "0.125rem 0 0.375rem 1.25rem", maxHeight: "12rem", overflowY: "auto",
              whiteSpace: "pre-wrap", fontStyle: "italic", overflowWrap: "anywhere",
            }}>{s.content}</div>
          </details>
        ) : <ToolStep key={s.id} call={s} result={resultOf(s)} live={live} ctx={ctx} t={t} />)}
      </div>
    </details>
  );
}

function ToolStep({ call, result, live, ctx, t }: {
  call: ToolCall; result: StepResult; live: boolean; ctx: CardCtx; t: (k: string, ...a: string[]) => string;
}) {
  const doneKey = `ASSISTANT_TOOL_${call.name}`;
  const done = t(doneKey) === doneKey ? call.name : t(doneKey);
  // A call with no result after the run ended was stopped (the user's Stop, or a failed run).
  const icon = result ? <Icon name={result.error ? "error" : "accept"} style={result.error ? ERROR : ICON} />
    : live ? <BusyIndicator active size="S" /> : <Icon name="stop" style={ICON} />;
  const label = result || !live ? done : progressText(call.name, t);
  const found = result?.error ?? (result ? stepSummary(call.name, call.input, result.output, t) : "");
  const line = (
    <>
      {icon}
      <span style={NAME}>{label}</span>
      {found ? (
        <span style={{
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0,
          color: result?.error ? "var(--sapNegativeTextColor)" : undefined,
        }}>· {found}</span>
      ) : null}
    </>
  );
  if (!result || result.error || !CARDS.has(call.name)) return <div style={LINE}>{line}</div>;
  return (
    <details>
      <summary style={SUMMARY}>{line}</summary>
      <div style={{ margin: "0.375rem 0 0.5rem", fontSize: "var(--sapFontSize)", color: "var(--sapTextColor)" }}>
        {renderTool({ name: call.name, input: call.input, output: result.output }, ctx)}
      </div>
    </details>
  );
}
