import { BusyIndicator, Icon } from "@ui5/webcomponents-react";
import { useI18n } from "../i18n.ts";
import { CARDS, progressText, renderTool, type CardCtx } from "./cards/registry.tsx";
import { stepSummary, type Step, type ToolCall } from "./steps.ts";

// The agent's work between its words (Claude Code's tool lines): its thinking and each tool call, one
// line each with what it found, the tool's card behind the line. Open while the agent works, folded to
// "N steps" once it answers. Native <details>: `open` set while live and dropped after, so a fold or an
// unfold the user makes later is theirs.

/** A tool call's result, once it has one. */
export type StepResult = { output: unknown; error?: string } | undefined;

export function Steps({ steps, live, resultOf, ctx }: {
  steps: Step[];
  /** the chat is still working on this run of steps */
  live: boolean;
  resultOf: (call: ToolCall) => StepResult;
  ctx: CardCtx;
}) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const last = steps.at(-1);
  const calls = steps.filter((s): s is ToolCall => s.type === "tool-call");
  const running = live ? calls.find((c) => !resultOf(c)) : undefined;
  const head = live
    ? running ? progressText(running.name, t) : last?.type === "thinking" ? t("ASSISTANT_THINKING") : t("ASSISTANT_WORKING")
    : !calls.length ? t("ASSISTANT_THOUGHT")
    : calls.length === 1 ? t("ASSISTANT_STEPS_1") : t("ASSISTANT_STEPS_N", String(calls.length));

  return (
    <details className="cf-steps" open={live || undefined}>
      <summary aria-live={live ? "polite" : undefined}>
        {live ? <BusyIndicator active size="S" /> : <Icon name="slim-arrow-right" className="cf-steps__chev" />}
        <span>{head}</span>
      </summary>
      <div className="cf-steps__list">
        {steps.map((s, i) => s.type === "thinking" ? (
          <details key={i} className="cf-step" open={(live && s === last) || undefined}>
            <summary><Icon name="lightbulb" /><span>{t(live && s === last ? "ASSISTANT_THINKING" : "ASSISTANT_THOUGHT")}</span></summary>
            <div className="cf-step__thought">{s.content}</div>
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
  const icon = result ? <Icon name={result.error ? "error" : "accept"} className={result.error ? "cf-step__error" : undefined} />
    : live ? <BusyIndicator active size="S" /> : <Icon name="stop" />;
  const label = result || !live ? done : progressText(call.name, t);
  const found = result?.error ?? (result ? stepSummary(call.name, call.input, result.output, t) : "");
  const line = (
    <>
      {icon}
      <span>{label}</span>
      {found ? <span className={result?.error ? "cf-step__found cf-step__error" : "cf-step__found"}>{found}</span> : null}
    </>
  );
  if (!result || result.error || !CARDS.has(call.name)) return <div className="cf-step"><div className="cf-step__line">{line}</div></div>;
  return (
    <details className="cf-step">
      <summary>{line}</summary>
      <div className="cf-step__body">{renderTool({ name: call.name, input: call.input, output: result.output }, ctx)}</div>
    </details>
  );
}
