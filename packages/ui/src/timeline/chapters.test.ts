import { expect, test } from "bun:test";
import { chaptersOf, mergeEntries, stepDates, type Entry } from "./chapters.ts";
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

const sameDay = () => [
  ev("submitted", "2026-11-04T09:00:00Z"), ev("accepted", "2026-11-04T10:00:00Z"), ev("quoted", "2026-11-04T11:00:00Z"),
];

test("same-day documents sort after the day's events", () => {
  const chapters = chaptersOf(mergeEntries(sameDay(), docs(doc("Quotations", "2026-11-04")), { docsAfterDay: true }));
  expect(chapters.map((c) => c.step)).toEqual([0, 1, 2]);
  expect(kindOf(chapters[2]!.entries.at(-1)!)).toBe("Quotations");
});

test("without docsAfterDay a document sorts at its day's start", () => {
  const entries = mergeEntries(sameDay(), docs(doc("Quotations", "2026-11-04")));
  expect(entries.map(kindOf)).toEqual(["Quotations", "submitted", "accepted", "quoted"]);
});

test("SAP documents are their steps", () => {
  const entries = mergeEntries(
    [ev("quoted", "2026-11-01T10:00:00Z")],
    docs(doc("Quotations", "2026-11-01"), doc("Orders", "2026-11-02"), doc("DeliveryNotes", "2026-11-03"), doc("Invoices", "2026-11-04")),
    { docsAfterDay: true },
  );
  expect(chaptersOf(entries).map((c) => c.step)).toEqual([2, 3, 4, 5]);
});

test("a fresh draft is one chapter", () => {
  const [created] = mergeEntries(seq("created"), undefined);
  expect(chaptersOf([created!])).toEqual([{ step: 0, entries: [created!] }]);
  expect(chaptersOf(mergeEntries(undefined, undefined))).toEqual([]);
});

test("stepDates: a step's date is its milestone's, a document's its posting day, no chapter none", () => {
  const events = seq("created", "comment", "submitted", "accepted");
  const dates = stepDates(chaptersOf(mergeEntries(events, docs(doc("Quotations", "2026-11-04T00:00:00Z")), { docsAfterDay: true })));
  expect(dates).toHaveLength(6);
  expect(dates[0]).toBe(events[2]!.at.getTime()); // submitted, not created
  expect(dates[1]).toBe(events[3]!.at.getTime());
  expect(dates[2]).toBe(new Date(2026, 10, 4).getTime()); // local day, read off the string
  expect(dates.slice(3)).toEqual([undefined, undefined, undefined]);
});

test("stepDates: a chapter without its milestone falls back to its first entry", () => {
  const events = seq("created", "comment");
  expect(stepDates(chaptersOf(mergeEntries(events, undefined)))[0]).toBe(events[0]!.at.getTime());
});
