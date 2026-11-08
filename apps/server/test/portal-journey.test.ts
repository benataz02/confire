import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db, PROJECT_STATUSES, type ProjectStatus, type QuoteResponse } from "@confire/db";
import { figuresOf, isFinished, journeyOf, nextSql, rankOf, type Next } from "../src/portal/journey.ts";

// The portal home's one rule (spec 2026-11-06-portal-home §"Journey and next"): a project's step on
// sent · review · quoted · ordered · delivered · invoiced, whose move it is, and the banner's figures.

const j = (status: ProjectStatus, quoteResponse: QuoteResponse | null = null) => journeyOf({ status, quoteResponse });

test("journeyOf: every state of the spec's table", () => {
  expect(j("draft")).toEqual({ step: 0, next: "finish" });
  expect(j("submitted")).toEqual({ step: 1, next: "review" });
  expect(j("in_review")).toEqual({ step: 1, next: "review" });
  expect(j("returned")).toEqual({ step: 1, next: "changes" });
  expect(j("declined")).toEqual({ step: 1, next: "declined" });
  expect(j("quoted")).toEqual({ step: 2, next: "answer" });
  expect(j("quoted", "accepted")).toEqual({ step: 3, next: "awaitOrder" });
  // SAP's steps, whatever the portal's answer: an order off an unanswered quote counts.
  expect(j("ordered")).toEqual({ step: 4, next: "delivery" });
  expect(j("delivered", "accepted")).toEqual({ step: 5, next: "invoice" });
  expect(j("invoiced", "accepted")).toEqual({ step: 6, next: "done" });
  // Not reached yet: a claim past the end, with the supplier.
  expect(j("claim")).toEqual({ step: 6, next: "review" });
});

test("rank, finished and figures", () => {
  const all: Next[] = ["answer", "changes", "review", "awaitOrder", "delivery", "invoice", "finish", "done", "declined"];
  expect(all.map(rankOf)).toEqual([0, 0, 1, 1, 1, 1, 2, 3, 3]);
  expect(isFinished({ status: "declined" })).toBe(true);
  expect(isFinished({ status: "invoiced" })).toBe(true);
  expect(isFinished({ status: "delivered" })).toBe(false);
  expect(figuresOf(["answer", "changes", "review", "awaitOrder", "delivery", "invoice", "finish"]))
    .toEqual({ needAnswer: 2, withSupplier: 2, inDelivery: 2 });
});

test("nextSql: journeyOf in Postgres, for every state the columns can hold (the home tiles' list filter)", async () => {
  const all = PROJECT_STATUSES.flatMap((status) => ([null, "accepted", "declined"] as const).map((quoteResponse) => ({ status, quoteResponse })));
  const values = sql.join(all.map((r, i) => sql`(${i}::int, ${r.status}::text, ${r.quoteResponse}::text)`), sql`, `);
  const next = nextSql({ status: sql.identifier("status"), quoteResponse: sql.identifier("qr") });
  const { rows } = await db.execute<{ next: string }>(sql`select ${next} as next from (values ${values}) v(i, status, qr) order by i`);
  expect(rows.map((r) => r.next)).toEqual(all.map((r) => journeyOf(r).next));
});
