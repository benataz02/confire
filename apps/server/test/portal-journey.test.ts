import { expect, test } from "bun:test";
import type { ProjectStatus, QuoteResponse, SapStep } from "@confire/db";
import { figuresOf, isFinished, journeyOf, rankOf, type Next } from "../src/portal/journey.ts";

// The portal home's one rule (spec 2026-11-06-portal-home §"Journey and next"): a project's step on
// sent · review · quoted · ordered · delivered · invoiced, whose move it is, and the banner's figures.

const j = (status: ProjectStatus, quoteResponse: QuoteResponse | null = null, sapStep: SapStep | null = null) =>
  journeyOf({ status, quoteResponse, sapStep });

test("journeyOf: every state of the spec's table", () => {
  expect(j("draft")).toEqual({ step: 0, next: "finish" });
  expect(j("submitted")).toEqual({ step: 1, next: "review" });
  expect(j("in_review")).toEqual({ step: 1, next: "review" });
  expect(j("returned")).toEqual({ step: 1, next: "changes" });
  expect(j("declined")).toEqual({ step: 1, next: "declined" });
  expect(j("quoted")).toEqual({ step: 2, next: "answer" });
  expect(j("quoted", "accepted")).toEqual({ step: 3, next: "awaitOrder" });
  expect(j("quoted", null, "ordered")).toEqual({ step: 4, next: "delivery" }); // SAP outranks an unanswered quote
  expect(j("quoted", "accepted", "delivered")).toEqual({ step: 5, next: "invoice" });
  expect(j("quoted", "accepted", "invoiced")).toEqual({ step: 6, next: "done" });
});

test("rank, finished and figures", () => {
  const all: Next[] = ["answer", "changes", "review", "awaitOrder", "delivery", "invoice", "finish", "done", "declined"];
  expect(all.map(rankOf)).toEqual([0, 0, 1, 1, 1, 1, 2, 3, 3]);
  expect(isFinished({ status: "declined", sapStep: null })).toBe(true);
  expect(isFinished({ status: "quoted", sapStep: "invoiced" })).toBe(true);
  expect(isFinished({ status: "quoted", sapStep: "delivered" })).toBe(false);
  expect(figuresOf(["answer", "changes", "review", "awaitOrder", "delivery", "invoice", "finish"]))
    .toEqual({ needAnswer: 2, withSupplier: 2, inDelivery: 2 });
});
