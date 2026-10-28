import type { UIMessage } from "@tanstack/ai-react";

// A message's parts as the panel draws them (pure): the answer's text, a card where the user has to
// decide, and between them the agent's work as steps — its thinking and every other tool call, one
// line each, the tool's old card behind the line's expander.

type Part = UIMessage["parts"][number];
export type ToolCall = Extract<Part, { type: "tool-call" }>;
export type Thinking = Extract<Part, { type: "thinking" }>;
export type Step = ToolCall | Thinking;
export type Block =
  | { kind: "text"; part: Extract<Part, { type: "text" }> }
  | { kind: "card"; part: ToolCall }
  | { kind: "steps"; steps: Step[] };

/** The tools whose result asks the user for a decision: their card is drawn in the chat. */
export const DECISION: ReadonlySet<string> = new Set(["read_request", "ask_user", "propose_quotation"]);

// A drop's file label rides on the text part's metadata, which the client type does not declare.
const shown = (p: Extract<Part, { type: "text" }>) =>
  !!p.content.trim() && !(p as { metadata?: { fileLabel?: boolean } }).metadata?.fileLabel;

/** Consecutive steps join one block; a text or a decision card ends it. Empty parts draw nothing. */
export function blocks(parts: readonly Part[]): Block[] {
  const out: Block[] = [];
  for (const p of parts) {
    if (p.type === "text") { if (shown(p)) out.push({ kind: "text", part: p }); continue; }
    if (p.type === "tool-call" && DECISION.has(p.name)) { out.push({ kind: "card", part: p }); continue; }
    if (p.type !== "tool-call" && (p.type !== "thinking" || !p.content.trim())) continue;
    const last = out.at(-1);
    if (last?.kind === "steps") last.steps.push(p);
    else out.push({ kind: "steps", steps: [p] });
  }
  return out;
}

const count = (v: unknown) => String(Array.isArray(v) ? v.length : 0);

/** What a finished step found, in a few words after its label ("12 found", "3 missing"). */
export function stepSummary(name: string, input: unknown, output: unknown, t: (key: string, ...a: string[]) => string): string {
  const o = (output ?? {}) as Record<string, any>;
  const i = (input ?? {}) as Record<string, any>;
  switch (name) {
    case "configs_rows":
    case "requests_rows":
    case "entities_rows":
      return t("ASSISTANT_STEP_FOUND", String(o.total ?? o.rows?.length ?? 0));
    case "configs_get":
    case "configs_select":
      return o.missing?.length ? t("ASSISTANT_STEP_MISSING", count(o.missing))
        : o.candidates?.rows?.length ? t("ASSISTANT_STEP_READY") : "";
    case "configs_calculate": {
      const n = Object.keys(i.set ?? {}).length + Object.keys(i.tables ?? {}).length + (i.batches ? 1 : 0) + (i.customer !== undefined ? 1 : 0);
      return n ? t("ASSISTANT_STEP_WROTE", String(n)) : "";
    }
    case "extract_values":
      return Array.isArray(o.applied) ? t("ASSISTANT_READ_COUNTS", count(o.applied), count(o.questions)) : "";
    case "configs_queryPage": return t("ASSISTANT_STEP_OPTIONS", count(o.rows));
    case "configs_similar": return t("ASSISTANT_STEP_SIMILAR", count(o.results));
    case "configs_models": return t("ASSISTANT_STEP_MODELS", count(output));
    case "timeline_list": return t("ASSISTANT_STEP_EVENTS", count(o.events));
    case "configs_create": return typeof i.name === "string" ? i.name : "";
    default: return "";
  }
}
