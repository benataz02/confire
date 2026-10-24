import type { Entries, Val } from "@confire/config-engine";

// Pure helpers for ConfiguratorForm, kept UI-free so they're unit-testable without the UI5 runtime.

export function setEntry(entries: Entries, key: string, v: Val | undefined): Entries {
  if (v === undefined) {
    if (!(key in entries)) return entries;
    const next = { ...entries };
    delete next[key];
    return next;
  }
  if (key in entries && JSON.stringify(entries[key]) === JSON.stringify(v)) return entries;
  return { ...entries, [key]: v };
}

/** Display-mode string for a field: option label when the domain has one, else the raw value. */
export function displayValue(v: Val | undefined, dom: { value: Val; label: string }[]): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => displayValue(x, dom)).join(", ");
  return dom.find((o) => o.value === v)?.label ?? String(v);
}

/** Parse one typed quantity into the batch list: positive integers only, de-duped, ascending.
 *  A Number input still lets through "", "-3" and "2.5", so everything the guards reject here
 *  is reachable. */
export function addBatch(batches: number[], raw: string): number[] {
  const n = Number(raw.trim()); // "" and "  " both coerce to 0, which the n < 1 guard rejects
  if (!Number.isInteger(n) || n < 1 || batches.includes(n)) return batches;
  return [...batches, n].sort((a, b) => a - b);
}
