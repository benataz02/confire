import type { TimelineDoc, TimelineDocuments, TimelineEvent } from "./ProjectTimeline.tsx";
import { parseIsoDate } from "../format.ts";

// The timeline's entries and chapters (client-project-page spec, "Chapters"): pure, so the rules are
// tested without a browser. A chapter is a journey step; entries are walked oldest first under a running
// step that only moves forward, so rework, a withdraw or a declined quote never repeats a chapter.

/** One line of the feed. A quotation is its `quoted` event, with the SAP document when the fenced read
 *  found it (`doc`, for Open and Preview); a later SAP document is its own entry. Either carries the
 *  `document_sent` that mailed it (`sent`), so a document is one entry, from the person who sent it. */
export type Entry =
  | { at: number; kind: "event"; e: TimelineEvent; sent?: TimelineEvent; doc?: TimelineDoc }
  | { at: number; kind: "doc"; d: TimelineDoc; sent?: TimelineEvent };

const DAY = 86_400_000;

const ref = (e: TimelineEvent) => (e.payload ?? {}) as { entity?: string; docEntry?: number };

/** The project's events and its SAP documents as one feed, oldest first, one entry per document: the SAP
 *  row of a quotation would repeat its `quoted` event, and a mailed document folds its `document_sent` in
 *  (a quotation's into the latest `quoted` at or before the send, as a re-quote in place sends again). A
 *  revision is not shown: the configuration page has the inputs, the conversation is what was said. A
 *  document nobody mailed has a posting date, not a time: it sorts after its day's events. */
export function mergeEntries(events: TimelineEvent[] | undefined, documents: TimelineDocuments | undefined): Entry[] {
  const quotations = new Map((documents?.quotations ?? []).map((q) => [q.quotation.docEntry, q.quotation]));
  // By entity and DocEntry: an order two of the project's quotations went into is one entry.
  const docs = new Map<string, Entry & { kind: "doc" }>();
  for (const d of (documents?.quotations ?? []).flatMap((q) => q.chain)) {
    const day = parseIsoDate(d.docDate)?.getTime() ?? 0; // local midnight, as the page shows it
    docs.set(`${d.entity}:${d.docEntry}`, { at: day ? day + DAY - 1 : 0, kind: "doc", d }); // unparsable: first
  }
  const quoted = new Map<number | undefined, Entry & { kind: "event" }>();
  const out: Entry[] = [];
  for (const e of [...(events ?? [])].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())) {
    const at = new Date(e.at).getTime();
    if (e.kind === "revised") continue;
    if (e.kind === "quoted") {
      const x = { at, kind: "event" as const, e, doc: quotations.get(ref(e).docEntry!) };
      quoted.set(ref(e).docEntry, x);
      out.push(x);
      continue;
    }
    if (e.kind === "document_sent") {
      const { entity, docEntry } = ref(e);
      const host = entity === "Quotations" ? quoted.get(docEntry) : docs.get(`${entity}:${docEntry}`);
      if (host && !host.sent) {
        host.sent = e;
        if (host.kind === "doc") host.at = at; // a send has a time; the posting date does not
        continue;
      }
    }
    out.push({ at, kind: "event", e });
  }
  return [...out, ...docs.values()].sort((a, b) => a.at - b.at);
}

/** One person on each side and nobody reassigned: a name on every entry would only repeat itself. */
export function oneToOne(events: TimelineEvent[] | undefined): boolean {
  const all = events ?? [];
  return !all.some((e) => e.kind === "assigned") && (["internal", "external"] as const)
    .every((side) => new Set(all.filter((e) => e.actorSide === side && e.actorName).map((e) => e.actorName)).size <= 1);
}

export type Chapter = { step: number; entries: Entry[] }; // step 0..5 = sent·review·quoted·ordered·delivered·invoiced

const EVENT_STEP: Record<string, number> = { submitted: 0, accepted: 1, quoted: 2 };
const DOC_STEP: Record<string, number> = { Orders: 3, DeliveryNotes: 4, Invoices: 5 };

/** The step an entry is a milestone of; undefined for everything that stays in the running chapter. */
const milestoneOf = (x: Entry): number | undefined => (x.kind === "event" ? EVENT_STEP[x.e.kind] : DOC_STEP[x.d.entity]);

/** Entries oldest first in; non-empty chapters out, ascending, each step at most once. */
export function chaptersOf(entries: Entry[]): Chapter[] {
  const chapters: Chapter[] = [];
  let step = 0;
  for (const x of entries) {
    step = Math.max(step, milestoneOf(x) ?? 0);
    const last = chapters.at(-1);
    if (last?.step === step) last.entries.push(x);
    else chapters.push({ step, entries: [x] });
  }
  return chapters;
}

/** The bar's date per step (epoch ms, six of them): its chapter's first milestone of that step, else the
 *  chapter's first entry; undefined for a step with no chapter. So "Sent" is the day it was sent, not the
 *  draft's creation. A document's is its posting day, read off the string (not its sort key). */
export function stepDates(chapters: Chapter[]): (number | undefined)[] {
  const out: (number | undefined)[] = Array(6).fill(undefined);
  for (const c of chapters) {
    const x = c.entries.find((e) => milestoneOf(e) === c.step) ?? c.entries[0]!;
    out[c.step] = x.kind === "doc" ? parseIsoDate(x.d.docDate)?.getTime() : x.at;
  }
  return out;
}
