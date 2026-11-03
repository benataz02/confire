import type { AnyTextAdapter } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

// The provider seam (assistant spec §4.4, §6): the chat and the extraction run on ASSISTANT_MODEL, the
// intake (a classification of the drop: which model, which customer, a name) on the cheaper
// ASSISTANT_INTAKE_MODEL. No per-tenant choice. Tests swap the adapter for a fake; with neither a key
// nor a fake the assistant is unavailable.

// `||`, not `??`: compose passes an unset variable as "".
export const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";
export const INTAKE_MODEL = process.env.ASSISTANT_INTAKE_MODEL || "claude-haiku-5-5";

/** The chat's effort. Sonnet 5.5's own default is `high`; `scripts/assistant-eval.ts --chat
 *  --effort` measures the others before this moves. */
export const CHAT_EFFORT = (process.env.ASSISTANT_EFFORT || "high") as "low" | "medium" | "high" | "xhigh" | "max";

let testAdapter: AnyTextAdapter | null = null;

/** Tests only: answer every call with this adapter (null restores the real one). */
export function useTestAdapter(a: AnyTextAdapter | null): void {
  testAdapter = a;
}

/** The adapter a call runs on. The key is read from ANTHROPIC_API_KEY, server env only. */
export function textAdapter(model: string = ASSISTANT_MODEL): AnyTextAdapter {
  return testAdapter ?? anthropicText(model as "claude-sonnet-5-5");
}

/** The server-side refusal fallback (`fallbacks: "default"`; the adapter adds the beta header) where
 *  the model has one: Sonnet 5.5 and Opus 5.5 on the Claude API. Haiku 5.5 has none. */
export function modelOptions(model: string = ASSISTANT_MODEL): Record<string, unknown> {
  return /^claude-(sonnet|opus)-5-5$/.test(model) ? { fallbacks: "default" } : {};
}

export const available = (): boolean => testAdapter !== null || !!process.env.ANTHROPIC_API_KEY;
