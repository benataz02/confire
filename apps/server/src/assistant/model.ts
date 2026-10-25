import type { AnyTextAdapter } from "@tanstack/ai";
import { anthropicText } from "@tanstack/ai-anthropic";

// The provider seam (assistant spec §4.4, §6): one model id for every call, from env, no cascade and
// no per-tenant choice. Effort stays at the model's default until the eval says otherwise. Tests
// swap the adapter for a fake; with neither a key nor a fake the assistant is unavailable.

// `||`, not `??`: compose passes an unset variable as "".
export const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || "claude-sonnet-5-5";

let testAdapter: AnyTextAdapter | null = null;

/** Tests only: answer every call with this adapter (null restores the real one). */
export function useTestAdapter(a: AnyTextAdapter | null): void {
  testAdapter = a;
}

/** The adapter a call runs on. The key is read from ANTHROPIC_API_KEY, server env only. */
export function textAdapter(): AnyTextAdapter {
  return testAdapter ?? anthropicText(ASSISTANT_MODEL as "claude-sonnet-5-5");
}

/** Sonnet's server-side refusal fallback (the adapter adds the beta header); Haiku has none. */
export function modelOptions(): Record<string, unknown> {
  return ASSISTANT_MODEL.startsWith("claude-sonnet-") ? { fallbacks: "default" } : {};
}

export const available = (): boolean => testAdapter !== null || !!process.env.ANTHROPIC_API_KEY;
