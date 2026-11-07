import { expect, test } from "bun:test";
import { chaptersOf, mergeEntries, oneToOne, stepDates, type Entry } from "./chapters.ts";
import type { TimelineDoc, TimelineEvent } from "./ProjectTimeline.tsx";

let n = 0;
const ev = (kind: string, iso: string): TimelineEvent => ({
  id: `e${++n}`, at: new Date(iso), kind, actorSide: "internal", actorName: null, visibility: "external", note: null, payload: null,
});
const doc = (entity: string, docDate: string): TimelineDoc => ({ entity, docEntry: ++n, docNum: n, docDate, docTotal: 0, docStatus: "bost_Open" });
const docs = (quotation: TimelineDoc, ...chain: TimelineDoc[]) => ({ quotations: [{ quotation, chain, current: true }] });
const kindOf = (x: Entry) => (x.kind === "event" ? x.e.kind : x.d.entity);

/** Events one minute apart from a base time, in the order given. */
const seq = (...kinds: string[]) => kinds.map((k, i) => ev(k, new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString()));

test("milestones open their chapter, everything else stays", () => {
  const chapters = chaptersOf(mergeEntries(seq("created", "comment", "submitted", "accepted", "comment", "quoted"), undefined));
  expect(chapters.map((c) => [c.step, c.entries.map(kindOf)])).toEqual([
    [0, ["created", "comment", "submitted"]],
    [1, ["accepted", "comment"]],
    [2, ["quoted"]],
  ]);
});

test("forward only: rework, withdraw and a declined quote never repeat a chapter", () => {
  const chapters = chaptersOf(mergeEntries(seq(
    "submitted", "withdrawn", "submitted", "accepted", "returned", "resubmitted", "accepted", "quoted", "quote_declined", "comment", "quoted",
  ), undefined));
  expect(chapters.map((c) => c.step)).toEqual([0, 1, 2]);
  expect(chapters[2]!.entries.map(kindOf)).toEqual(["quoted", "quote_declined", "comment", "quoted"]);
});

// Local times: a document's date is a local day (parseIsoDate), so "the same day" is the viewer's.
const local = (h: number) => new Date(2026, 10, 4, h).toISOString();
const sameDay = () => [ev("submitted", local(9)), ev("accepted", local(10)), ev("quoted", local(11))];

test("same-day documents sort after the day's events", () => {
  const chapters = chaptersOf(mergeEntries(sameDay(), docs(doc("Quotations", "2026-11-04"), doc("Orders", "2026-11-04"))));
  expect(chapters.map((c) => c.step)).toEqual([0, 1, 2, 3]);
  expect(kindOf(chapters[3]!.entries.at(-1)!)).toBe("Orders");
});

test("SAP documents are their steps", () => {
  const entries = mergeEntries(
    [ev("quoted", "2026-11-01T10:00:00Z")],
    docs(doc("Quotations", "2026-11-01"), doc("Orders", "2026-11-02"), doc("DeliveryNotes", "2026-11-03"), doc("Invoices", "2026-11-04")),
  );
  expect(chaptersOf(entries).map((c) => c.step)).toEqual([2, 3, 4, 5]);
});

const sent = (entity: string, docEntry: number, iso: string) => ({ ...ev("document_sent", iso), payload: { entity, docEntry, docNum: docEntry, fileId: "f", to: ["a@b.c"] } });
const quotedOf = (docEntry: number, iso: string) => ({ ...ev("quoted", iso), payload: { docEntry, docNum: docEntry, value: 10 } });

test("a quotation is its quoted event: the SAP row is dropped, its document and its mail folded in", () => {
  const q = doc("Quotations", "2026-11-01");
  const quoted = quotedOf(q.docEntry, "2026-11-01T10:00:00Z");
  const mail = sent("Quotations", q.docEntry, "2026-11-01T10:00:05Z");
  const entries = mergeEntries([quoted, mail], docs(q));
  expect(entries).toEqual([{ at: quoted.at.getTime(), kind: "event", e: quoted, doc: q, sent: mail }]);
});

test("a re-quote in place: each send folds into the quoted event before it", () => {
  const [q1, s1, q2, s2] = [quotedOf(7, "2026-11-01T10:00:00Z"), sent("Quotations", 7, "2026-11-01T10:00:05Z"),
    quotedOf(7, "2026-11-02T10:00:00Z"), sent("Quotations", 7, "2026-11-02T10:00:05Z")];
  const entries = mergeEntries([q1, s1, q2, s2], undefined);
  expect(entries.map((x) => [x.kind === "event" && x.e.id, x.sent?.id])).toEqual([[q1.id, s1.id], [q2.id, s2.id]]);
});

test("a mailed order is one entry at the send's time; a send with no document of ours stays an event", () => {
  const order = doc("Orders", "2026-11-03");
  const mail = sent("Orders", order.docEntry, "2026-11-03T08:00:00Z");
  const stray = sent("Invoices", 999, "2026-11-04T08:00:00Z");
  const entries = mergeEntries([mail, stray], docs(doc("Quotations", "2026-11-01"), order));
  expect(entries.map((x) => [kindOf(x), x.at, x.sent?.id])).toEqual([
    ["Orders", mail.at.getTime(), mail.id],
    ["document_sent", stray.at.getTime(), undefined],
  ]);
});

test("a revision is not shown", () => {
  expect(mergeEntries(seq("accepted", "revised", "quoted"), undefined).map(kindOf)).toEqual(["accepted", "quoted"]);
});

test("oneToOne: one person per side and nobody reassigned", () => {
  const by = (actorSide: "internal" | "external", actorName: string | null, kind = "comment") => ({ ...ev(kind, "2026-11-01T10:00:00Z"), actorSide, actorName });
  expect(oneToOne([by("external", "Ana"), by("internal", "Jon"), by("external", "Ana"), by("internal", null)])).toBe(true);
  expect(oneToOne([by("external", "Ana"), by("internal", "Jon"), by("internal", "Mia")])).toBe(false);
  expect(oneToOne([by("external", "Ana"), by("external", "Leo")])).toBe(false);
  expect(oneToOne([by("external", "Ana"), by("internal", "Jon", "assigned")])).toBe(false);
  expect(oneToOne(undefined)).toBe(true);
});

test("a fresh draft is one chapter", () => {
  const [created] = mergeEntries(seq("created"), undefined);
  expect(chaptersOf([created!])).toEqual([{ step: 0, entries: [created!] }]);
  expect(chaptersOf(mergeEntries(undefined, undefined))).toEqual([]);
});

test("stepDates: a step's date is its milestone's, a document's its posting day, no chapter none", () => {
  const events = seq("created", "comment", "submitted", "accepted");
  const dates = stepDates(chaptersOf(mergeEntries(events, docs(doc("Quotations", "2026-11-01"), doc("Orders", "2026-11-04T00:00:00Z")))));
  expect(dates).toHaveLength(6);
  expect(dates[0]).toBe(events[2]!.at.getTime()); // submitted, not created
  expect(dates[1]).toBe(events[3]!.at.getTime());
  expect(dates[3]).toBe(new Date(2026, 10, 4).getTime()); // local day, read off the string
  expect([dates[2], ...dates.slice(4)]).toEqual([undefined, undefined, undefined]);
});

test("stepDates: a chapter without its milestone falls back to its first entry", () => {
  const events = seq("created", "comment");
  expect(stepDates(chaptersOf(mergeEntries(events, undefined)))[0]).toBe(events[0]!.at.getTime());
});
