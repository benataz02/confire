// The progress bar's one rule: the current step's ring says whose move it is, seen from the reader's
// side. `JourneyNext` is the server's `Next` (apps/server/src/portal/journey.ts) written out: ui does not
// import the server at runtime, and the pages pass the payload's `next` straight in, so a drift is a
// type error there.

export type JourneyNext = "finish" | "review" | "changes" | "answer" | "awaitOrder" | "delivery" | "invoice" | "done" | "declined";
export type Side = "internal" | "external";
export type Ring = "Critical" | "Negative" | "Neutral" | "Information";

/** Critical = the reader's own move, Information = someone else is at work, Neutral = a draft nobody
 *  sent, Negative = declined. [staff's view, client's view]. */
const RINGS: Record<JourneyNext, [Ring, Ring]> = {
  finish: ["Neutral", "Neutral"],
  review: ["Critical", "Information"],
  changes: ["Information", "Critical"],
  answer: ["Information", "Critical"],
  awaitOrder: ["Critical", "Information"],
  delivery: ["Information", "Information"],
  invoice: ["Information", "Information"],
  done: ["Information", "Information"],
  declined: ["Negative", "Negative"],
};

export const ringOf = (next: JourneyNext, side: Side): Ring => RINGS[next][side === "internal" ? 0 : 1];
