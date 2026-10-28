import type { FieldOption, ModelDef } from "@confire/config-engine";
import type { ConfigView } from "../components/configurator/useConfigProcess.ts";
import type { ExtractResult } from "./cards/ExtractionCard.tsx";

// The open questions of a configuration (assistant spec §4.1 step 4), pure: everything its view
// still misses, plus every question a read left that the configuration has not answered since. It
// reads the live view the page draws, so an answer typed on the page closes a question here too.

export type QuestionView = Pick<ConfigView, "missing" | "form" | "project"> & { model?: { definition: ModelDef } };

export type Q = {
  key: string;
  label: string;
  /** "missing", or the read's own reason (differs, not_an_option, out_of_range, unavailable, unsure, ambiguous) */
  why: string;
  detail?: string;
  options: FieldOption[];
  /** what the read found, and for a `differs` the value the field held */
  read?: unknown;
  current?: unknown;
  candidates?: unknown[];
  kind: "options" | "query" | "free" | "customer";
};

/** The view's key for a missing customer (config-project.ts CUSTOMER_KEY). */
export const CUSTOMER = "__customer";

const blank = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * In the model's order, the customer first. A `differs` question is open while the field still holds
 * what it held when it was read, until the user takes the read value, keeps theirs (`kept`, this
 * session) or types something else; any other question until the field has a value.
 */
export function openQuestions(view: QuestionView, extracts: ExtractResult[], kept: ReadonlySet<string> = new Set()): Q[] {
  const params = view.model?.definition.parameters ?? [];
  const byKey = new Map(params.map((p) => [p.key, p]));
  const entries = view.project.entries as Record<string, unknown>;
  // The form's value: a field a rule's default filled counts as answered, as it does for `missing`.
  const valueOf = (k: string) => (k === "batches" ? view.project.batches : view.form.fields[k]?.value ?? entries[k]);
  const out = new Map<string, Q>();

  const base = (key: string): Pick<Q, "label" | "options" | "kind"> => {
    if (key === CUSTOMER) return { label: "", options: [], kind: "customer" };
    const p = byKey.get(key);
    const query = p?.domain?.kind === "options" && p.domain.ref.source === "query";
    const options = view.form.fields[key]?.options ?? [];
    return { label: p?.label || key, options: query ? [] : options, kind: query ? "query" : options.length ? "options" : "free" };
  };

  for (const m of view.missing) {
    if (m.code === "customer_required") out.set(CUSTOMER, { key: CUSTOMER, why: "missing", ...base(CUSTOMER) });
    else if (m.code === "param_required" && m.key) out.set(m.key, { key: m.key, why: "missing", ...base(m.key) });
  }
  for (const x of extracts) {
    for (const q of x.questions) {
      if (!byKey.has(q.key) && q.key !== "batches") continue; // tables are answered in their grid
      const now = valueOf(q.key);
      const open = q.why === "differs"
        ? !kept.has(q.key) && same(now, q.candidates[0]) && !same(now, q.read)
        : blank(now);
      if (!open) { if (out.get(q.key)?.why !== "missing") out.delete(q.key); continue; }
      out.set(q.key, {
        key: q.key, why: q.why, detail: q.detail, read: q.read, candidates: q.candidates,
        ...(q.why === "differs" ? { current: now } : {}),
        ...base(q.key),
      });
    }
  }
  const order = [CUSTOMER, ...params.map((p) => p.key), "batches"];
  return [...out.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** The one question on screen: the first open one not skipped. Skipped ones come back once the rest
 *  are, in the order they were skipped, so Skip cycles through them. */
export function nextQuestion(questions: readonly Q[], skipped: readonly string[]): Q | undefined {
  return questions.find((q) => !skipped.includes(q.key))
    ?? skipped.map((k) => questions.find((q) => q.key === k)).find((q) => q !== undefined);
}
