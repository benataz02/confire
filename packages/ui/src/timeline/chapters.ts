import type { TimelineDoc, TimelineDocuments, TimelineEvent } from "./ProjectTimeline.tsx";

// The timeline's chapters (client-project-page spec, "Chapters"): pure, so the rule is tested without
// a browser. A chapter is a journey step; entries are walked oldest first under a running step that
// only moves forward, so rework, a withdraw or a declined quote never repeats a chapter.

export type Entry =
  | { at: number; kind: "event"; e: TimelineEvent }
  | { at: number; kind: "doc"; d: TimelineDoc; superseded: boolean };

const DAY = 86_400_000;

/** The project's events and its SAP documents as one feed, oldest first. A document has a posting date,
 *  not a time: it sorts at the start of its day, or with `docsAfterDay` after the day's last event. */
export function mergeEntries(
  events: TimelineEvent[] | undefined, documents: TimelineDocuments | undefined, opts?: { docsAfterDay?: boolean },
): Entry[] {
  return [
    ...(events ?? []).map((e) => ({ at: new Date(e.at).getTime(), kind: "event" as const, e })),
    ...(documents?.quotations ?? []).flatMap((q) => [q.quotation, ...q.chain].map((d) => {
      const day = new Date(d.docDate).getTime();
      return {
        at: day ? day + (opts?.docsAfterDay ? DAY - 1 : 0) : 0, // an unparsable date stays 0, first
        kind: "doc" as const, d, superseded: !q.current && d.entity === "Quotations",
      };
    })),
  ].sort((a, b) => a.at - b.at);
}

export type Chapter = { step: number; entries: Entry[] }; // step 0..5 = sent·review·quoted·ordered·delivered·invoiced

const EVENT_STEP: Record<string, number> = { submitted: 0, accepted: 1, quoted: 2 };
const DOC_STEP: Record<string, number> = { Quotations: 2, Orders: 3, DeliveryNotes: 4, Invoices: 5 };

/** Entries oldest first in; non-empty chapters out, ascending, each step at most once. */
export function chaptersOf(entries: Entry[]): Chapter[] {
  const chapters: Chapter[] = [];
  let step = 0;
  for (const x of entries) {
    const milestone = (x.kind === "event" ? EVENT_STEP[x.e.kind] : DOC_STEP[x.d.entity]) ?? 0;
    step = Math.max(step, milestone);
    const last = chapters.at(-1);
    if (last?.step === step) last.entries.push(x);
    else chapters.push({ step, entries: [x] });
  }
  return chapters;
}
