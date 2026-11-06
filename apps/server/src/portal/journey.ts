import type { ProjectStatus, QuoteResponse, SapStep } from "@confire/db";

// The portal home's one rule (spec 2026-11-06-portal-home): where a project stands on
// sent(0) · review(1) · quoted(2) · ordered(3) · delivered(4) · invoiced(5) — 6 is all done — and
// what happens next, which says whose move it is. Pure: the server decides, the page only draws.

export type Next = "finish" | "review" | "changes" | "answer" | "awaitOrder" | "delivery" | "invoice" | "done" | "declined";
export type JourneyInput = { status: ProjectStatus; quoteResponse: QuoteResponse | null; sapStep: SapStep | null };

const AFTER_SAP: Record<SapStep, { step: number; next: Next }> = {
  ordered: { step: 4, next: "delivery" },
  delivered: { step: 5, next: "invoice" },
  invoiced: { step: 6, next: "done" },
};

export function journeyOf(p: JourneyInput): { step: number; next: Next } {
  // SAP outranks the portal's answer: an order made from a quote nobody answered here still counts.
  if (p.sapStep) return AFTER_SAP[p.sapStep];
  switch (p.status) {
    case "draft": return { step: 0, next: "finish" };
    case "submitted":
    case "in_review": return { step: 1, next: "review" };
    case "returned": return { step: 1, next: "changes" };
    case "declined": return { step: 1, next: "declined" };
    // A declined answer sends the project back to in_review, so here it is unanswered or accepted.
    case "quoted": return p.quoteResponse === "accepted" ? { step: 3, next: "awaitOrder" } : { step: 2, next: "answer" };
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

/** Finished projects leave home (unless pinned): invoiced in SAP, or declined by the supplier. */
export const isFinished = (p: Pick<JourneyInput, "status" | "sapStep">): boolean =>
  p.status === "declined" || p.sapStep === "invoiced";

/** The banner's three to-dos. */
export function figuresOf(nexts: Next[]): { needAnswer: number; withSupplier: number; inDelivery: number } {
  const n = (...of: Next[]) => nexts.filter((x) => of.includes(x)).length;
  return { needAnswer: n("answer", "changes"), withSupplier: n("review", "awaitOrder"), inDelivery: n("delivery", "invoice") };
}
