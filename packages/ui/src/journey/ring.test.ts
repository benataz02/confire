import { expect, test } from "bun:test";
import { ringOf, type JourneyNext, type Ring, type Side } from "./ring.ts";

// The spec's table, every cell: [next, as staff sees it, as the client sees it].
const TABLE: [JourneyNext, Ring, Ring][] = [
  ["finish", "Neutral", "Neutral"],
  ["review", "Critical", "Information"],
  ["changes", "Information", "Critical"],
  ["answer", "Information", "Critical"],
  ["awaitOrder", "Critical", "Information"],
  ["delivery", "Information", "Information"],
  ["invoice", "Information", "Information"],
  ["done", "Information", "Information"],
  ["declined", "Negative", "Negative"],
];

test("ringOf: the spec's table, 18 cells", () => {
  for (const [next, internal, external] of TABLE) {
    expect([next, "internal", ringOf(next, "internal" satisfies Side)]).toEqual([next, "internal", internal]);
    expect([next, "external", ringOf(next, "external" satisfies Side)]).toEqual([next, "external", external]);
  }
});
