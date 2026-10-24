import type { Entries } from "@confire/config-engine";
import type { GridState } from "@confire/ui/list-report/Grid.tsx";
import type { Row } from "@confire/ui/types.ts";
import { formatLocale } from "@confire/ui/format.ts";

// What the process page does with the view beyond drawing it: formatting, and the sort, filter and
// grouping the user drives. Every figure and flag here is the server's (config-view.ts).
export type Sel = { candidateIdx: number; batchQty: number };
/** A candidate row as the view carries it: the open parameters' values, and per batch quantity. */
type ChartCandidate = { perBatch: { unitPrice: number; lowest: boolean }[] };

export const fmt = (n: number): string => n.toLocaleString(formatLocale(), { maximumFractionDigits: 2 });

/** `(key, ...params)` — the caller's `i18n.getText`, so this stays pure and testable. */
export type TextFn = (key: string, ...params: string[]) => string;

const STATUS_TEXT: Record<string, string> = {
  draft: "CONFIG_STATUS_DRAFT",
  submitted: "CONFIG_STATUS_SUBMITTED",
  in_review: "CONFIG_STATUS_IN_REVIEW",
  returned: "CONFIG_STATUS_RETURNED",
  declined: "CONFIG_STATUS_DECLINED",
  quoted: "CONFIG_STATUS_QUOTED",
};

/** The list's two statuses, colour included. A request's wider set is `projectStatusText`. */
export function statusUi(t: TextFn) {
  return {
    draft: { state: "None" as const, text: t(STATUS_TEXT.draft!) },
    quoted: { state: "Positive" as const, text: t(STATUS_TEXT.quoted!) },
  };
}

/** Tag text for a project status. An unknown status stays as stored — it is a code, not a sentence. */
export function projectStatusText(t: TextFn, status: string): string {
  const key = STATUS_TEXT[status];
  return key ? t(key) : status;
}

export const candidateLabel = (t: TextFn, keys: string[], assignment: Entries): string =>
  keys.length ? keys.map((k) => String(assignment[k] ?? "—")).join(" · ") : t("CONFIG_CANDIDATE");

/** A price line's grid row id: the pair a Sel names. */
export const lineKey = (s: Sel): string => `${s.candidateIdx}:${s.batchQty}`;

/** The selection after a grid change. The grid only knows the lines on screen, so a pick a filter
 *  hides is kept and the rest follow the grid. Pick order holds: kept picks first, new ones after. */
export function mergeSelection(selection: Sel[], shown: Set<string>, picked: Sel[]): Sel[] {
  const on = new Set(picked.map(lineKey));
  const had = new Set(selection.map(lineKey));
  return [
    ...selection.filter((s) => !shown.has(lineKey(s)) || on.has(lineKey(s))),
    ...picked.filter((p) => !had.has(lineKey(p))),
  ];
}

const compare = (a: unknown, b: unknown): number =>
  typeof a === "number" || typeof b === "number"
    ? Number(a ?? -Infinity) - Number(b ?? -Infinity)
    : String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });

/** Grid's sort is a server's job; every candidate is already here, so this is that server.
 *  Numbers numerically (an empty one lowest), text with its digits compared as numbers. */
export const sortRows = (rows: Row[], sortBy: GridState["sortBy"]): Row[] =>
  [...rows].sort((x, y) => {
    for (const s of sortBy) {
      const d = compare(x[s.field], y[s.field]);
      if (d) return s.direction === "desc" ? -d : d;
    }
    return 0;
  });

// Rows the price chart draws: every configuration with a picked cell, in pick order — or, before
// anything is picked, the cheapest one at the first quantity, so the chart is never empty.
export function chartRows(candidates: ChartCandidate[], selection: Sel[]): number[] {
  if (selection.length) return [...new Set(selection.map((s) => s.candidateIdx))];
  const i = candidates.findIndex((c) => c.perBatch[0]?.lowest);
  return i < 0 ? [] : [i];
}

/** One decimal. An em dash where there is no share to show. */
export function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}
