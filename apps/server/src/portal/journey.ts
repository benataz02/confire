import { sql, type Column, type SQL } from "drizzle-orm";
import { PROJECT_STATUSES, type ProjectStatus, type QuoteResponse } from "@confire/db";

// The portal home's one rule (spec 2026-11-06-portal-home): where a project stands on
// sent(0) · review(1) · quoted(2) · ordered(3) · delivered(4) · invoiced(5) — 6 is all done — and
// what happens next, which says whose move it is. Pure: the server decides, the page only draws.

export type Next = "finish" | "review" | "changes" | "answer" | "awaitOrder" | "delivery" | "invoice" | "done" | "declined";
export type JourneyInput = { status: ProjectStatus; quoteResponse: QuoteResponse | null };

export function journeyOf(p: JourneyInput): { step: number; next: Next } {
  switch (p.status) {
    case "draft": return { step: 0, next: "finish" };
    case "submitted":
    case "in_review": return { step: 1, next: "review" };
    case "returned": return { step: 1, next: "changes" };
    case "declined": return { step: 1, next: "declined" };
    // A declined answer sends the project back to in_review, so here it is unanswered or accepted.
    case "quoted": return p.quoteResponse === "accepted" ? { step: 3, next: "awaitOrder" } : { step: 2, next: "answer" };
    // SAP's steps, whatever the portal's answer: an order made from a quote nobody answered here counts.
    case "ordered": return { step: 4, next: "delivery" };
    case "delivered": return { step: 5, next: "invoice" };
    case "invoiced": return { step: 6, next: "done" };
    // Not reached yet (nothing transitions to it): past the end, the supplier's to handle.
    case "claim": return { step: 6, next: "review" };
  }
}

/** Sort group: 0 the customer's move, 1 the supplier's, 2 a draft, 3 finished. */
export function rankOf(next: Next): 0 | 1 | 2 | 3 {
  switch (next) {
    case "answer": case "changes": return 0;
    case "finish": return 2;
    case "done": case "declined": return 3;
    default: return 1;
  }
}

/** Finished projects leave home (unless pinned): invoiced, or declined by the supplier. */
export const FINISHED: ProjectStatus[] = ["declined", "invoiced"];
export const isFinished = (p: Pick<JourneyInput, "status">): boolean => FINISHED.includes(p.status);

/** journeyOf's `next` in SQL, for the projects list's filter the home tiles open: one branch per
 *  (status, answer) the columns can hold, each mapped by journeyOf itself, so the list and the tile's
 *  count can never disagree. ponytail: 30 branches over a company's few projects; a stored `next`
 *  column if a list ever filters thousands. */
export function nextSql(c: Record<"status" | "quoteResponse", Column | SQL>): SQL<Next> {
  const whens = PROJECT_STATUSES.flatMap((status) => ([null, "accepted", "declined"] as const).map((quoteResponse) =>
    sql`when ${c.status} = ${status} and ${c.quoteResponse} is not distinct from ${quoteResponse}
      then ${journeyOf({ status, quoteResponse }).next}`));
  return sql<Next>`(case ${sql.join(whens, sql` `)} end)`;
}

/** The banner's three to-dos. */
export function figuresOf(nexts: Next[]): { needAnswer: number; withSupplier: number; inDelivery: number } {
  const n = (...of: Next[]) => nexts.filter((x) => of.includes(x)).length;
  return { needAnswer: n("answer", "changes"), withSupplier: n("review", "awaitOrder"), inDelivery: n("delivery", "invoice") };
}
