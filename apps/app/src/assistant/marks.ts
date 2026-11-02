import type { FieldMark } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import type { Source } from "./cards/registry.tsx";

// The configuration page's provenance marks (assistant spec §4.1): ✦ the assistant wrote the value
// and the field still holds it, 💬 a question about it is open in the panel. Worked out from the
// stored sources and the live entries, so a human edit drops the ✦ with no write of its own.

export type Sources = Record<string, { value: unknown; source: Source }>;

/** Key order is not a difference (jsonb reorders keys). */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** Parameters by key; a table's cells by `<table>:<row>:<column>`, each while it still holds what
 *  the assistant wrote (a table's source is its whole rows, so one edited cell keeps the rest marked).
 *  ponytail: rows have no ids — a row deleted above shifts the rest, which then mark only where the
 *  values happen to match. Row ids would make it exact. */
export function fieldMarks(
  entries: Record<string, unknown>, sources: Sources, questionKeys: string[], tip: (s: Source) => string,
  tables: Record<string, Record<string, unknown>[]> = {},
): Record<string, FieldMark> {
  const out: Record<string, FieldMark> = {};
  for (const [k, s] of Object.entries(sources)) {
    if (k in entries && canon(entries[k]) === canon(s.value)) out[k] = { kind: "assistant", tip: tip(s.source) };
    else if (k in tables && Array.isArray(s.value))
      (s.value as Record<string, unknown>[]).forEach((row, i) => {
        for (const [col, v] of Object.entries(row ?? {}))
          if (canon(tables[k]![i]?.[col]) === canon(v)) out[`${k}:${i}:${col}`] = { kind: "assistant", tip: tip(s.source) };
      });
  }
  for (const k of questionKeys) out[k] = { kind: "question" };
  return out;
}

/** A source as the mark's tooltip: `RFQ.pdf p.1: "W 200"`, or the user's own words. */
export function sourceTip(s: Source, t: (k: string, ...a: Array<string | number>) => string): string {
  if ("chat" in s) return t("ASSISTANT_SOURCE_CHAT", s.chat);
  return s.page === null ? t("ASSISTANT_MARK_IMAGE", s.file, s.quote) : t("ASSISTANT_MARK_FILE", s.file, s.page, s.quote);
}
