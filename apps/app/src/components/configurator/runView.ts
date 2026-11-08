import type { Entries } from "@confire/config-engine";
import type { GridState } from "@confire/ui/list-report/Grid.tsx";
import type { Row } from "@confire/ui/types.ts";
import { formatLocale } from "@confire/ui/format.ts";

// What the process page does with the view beyond drawing it: formatting, and the sort, filter and
// grouping the user drives. Every figure and flag here is the server's (config-view.ts).
export type Sel = { candidateIdx: number; batchQty: number };

export const fmt = (n: number): string => n.toLocaleString(formatLocale(), { maximumFractionDigits: 2 });

/** `(key, ...params)` — the caller's `i18n.getText`, so this stays pure and testable. */
export type TextFn = (key: string, ...params: string[]) => string;

export const candidateLabel = (t: TextFn, keys: string[], assignment: Entries): string =>
  keys.length ? keys.map((k) => String(assignment[k] ?? "—")).join(" · ") : t("CONFIG_CANDIDATE");

/** A boolean parameter as the caller's yes/no. `"true"`/`"false"` are `String(boolean)` from a
 *  filter token; anything else is not a boolean and the caller keeps its own text. */
export function boolText(v: unknown, yes: string, no: string): string | undefined {
  if (v === true || v === "true") return yes;
  if (v === false || v === "false") return no;
  return undefined;
}

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

/** One decimal. An em dash where there is no share to show. */
export function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

// @confire/db's SAP_STEPS: the app does not depend on the db package.
const SAP_STEPS = ["ordered", "delivered", "invoiced"];

/** The title's Open button, per document it opens. */
export const OPEN_DOCUMENT: Record<string, string> = {
  Quotations: "CONFIG_OPEN_QUOTE", Orders: "CONFIG_OPEN_ORDER", DeliveryNotes: "CONFIG_OPEN_DELIVERY", Invoices: "CONFIG_OPEN_INVOICE",
};

/** What the title's Open button opens: the project's latest SAP document — the newest SAP step's
 *  (each `ordered`/`delivered`/`invoiced` event records the document that moved the status there;
 *  events come oldest first), else the quotation (a status migration 0021 set has no event). Null
 *  past "Quoted" while the events load, so the label never flips. A step's document lives in its
 *  quotation's company (advanceSapSteps walks only those): the caller's check on the quotation covers it. */
export function latestDocument(
  p: { status: string; b1DocEntry: number },
  events: { kind: string; payload: unknown }[] | undefined,
): { entity: string; docEntry: number } | null {
  if (!events && SAP_STEPS.includes(p.status)) return null;
  const step = events?.findLast((e) => SAP_STEPS.includes(e.kind))?.payload as { entity: string; docEntry: number } | undefined;
  return step ? { entity: step.entity, docEntry: step.docEntry } : { entity: "Quotations", docEntry: p.b1DocEntry };
}
