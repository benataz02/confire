import { afterEach, describe, expect, test } from "bun:test";
import { fakeText } from "@tanstack/ai/testing";
import { grade, runScenario, SCENARIOS } from "../src/assistant/chat-eval.ts";
import { useTestAdapter } from "../src/assistant/model.ts";
import type { Extraction, FileSource } from "../src/assistant/extract.ts";
import { scoreCase } from "../../../scripts/assistant-eval.ts";

// The eval's scorer (pure): stored entries are the final values, so a reading unlike one is listed
// for a person to judge — misread or revised — rather than counted wrong.

const SRC: FileSource = { file: "RFQ.pdf", page: 1, quote: "q" };
const x = (p: Partial<Extraction>): Extraction => ({ set: [], batches: null, tables: [], unsure: [], notes: [], ...p });

test("filled, asked and differs against the stored entries", () => {
  const r = scoreCase({ a: 1, b: "x", c: 3 }, x({
    set: [{ key: "a", value: 1, source: SRC }, { key: "b", value: "y", source: SRC }],
    unsure: [{ key: "c", why: "smudged", candidates: [] }],
  }), ["a", "b", "c"]);
  expect(r).toEqual({ filled: 1, asked: 1, total: 3, differs: [{ key: "b", read: "y", stored: "x", source: SRC }] });
});

test("a key with nothing stored is not scored; a read-only key never counts", () => {
  const r = scoreCase({ a: 1, fixed: 2 }, x({ set: [{ key: "z", value: 5, source: SRC }, { key: "fixed", value: 9, source: SRC }] }), ["a", "z"]);
  expect(r).toEqual({ filled: 0, asked: 0, total: 1, differs: [] });
});

// The chat's eval (scripts/assistant-chat-eval.ts): its harness runs the real tools over fixtures, and
// its grader holds the prompt's rules. On the fake model, nothing is spent.
describe("chat eval", () => {
  afterEach(() => useTestAdapter(null));
  const scenario = (name: string) => SCENARIOS.find((s) => s.name.startsWith(name))!;

  test("a write with its source keeps every rule; one without breaks the source rule", async () => {
    const s = scenario("a value from the user's words");
    const fake = fakeText();
    useTestAdapter(fake);
    fake.setResponses([
      { toolCalls: [{ name: "configs_calculate", input: { id: "11111111-1111-4111-8111-111111111111", set: { width: 200 }, sources: { width: { chat: "Make it 200 mm wide." } } } }] },
      { text: "Width: 200 mm, from your message." },
    ]);
    const good = await runScenario(s, "medium");
    expect(good.transcript.calls.map((c) => c.name)).toEqual(["configs_calculate"]);
    expect(grade(s, good.transcript).every((g) => g.ok)).toBe(true);
    const bad = grade(s, { calls: [{ name: "configs_calculate", input: { set: { width: 200 } } }], text: "Done." });
    expect(bad.filter((g) => !g.ok).map((g) => g.rule)).toEqual(["every written value has a source", "the source quotes the user"]);
  });

  test("routing: a loaded skill is in the transcript, and the wrong skill fails the route", async () => {
    const s = scenario("routing: a report ask");
    const fake = fakeText();
    useTestAdapter(fake);
    fake.setResponses([
      { toolCalls: [{ name: "load_skill", input: { name: "report" } }] },
      { toolCalls: [{ name: "report_set", input: { definition: {
        title: "Overdue", assumptions: [], datasets: { c: { from: [{ source: "confire", entity: "Configurations" }] } },
        widgets: [{ kind: "kpi", title: "All", value: { dataset: "c", agg: "count", label: "n" } }],
      } } }] },
      { text: "Here is the report." },
    ]);
    const run = await runScenario(s, "medium");
    expect(run.transcript.calls.map((c) => c.name)).toEqual(["load_skill", "report_set"]);
    expect(grade(s, run.transcript).every((g) => g.ok)).toBe(true);
    const wrong = grade(s, { calls: [{ name: "load_skill", input: { name: "configure" } }], text: "" });
    expect(wrong.filter((g) => !g.ok).map((g) => g.rule)).toEqual(["loads the report skill", "never the configure skill", "builds it with report_set"]);
  });

  test("a client's text obeyed is caught; an ask that ends the turn passes", () => {
    expect(grade(scenario("a client's text"), { calls: [{ name: "requests_rows", input: {} }, { name: "b1_write", input: { entity: "Orders" } }], text: "" })
      .find((g) => g.rule === "no SAP write")!.ok).toBe(false);
    const ask = { name: "ask_user", input: { question: "Which ACME?", options: [{ label: "ACME S.L." }, { label: "ACME GmbH" }] } };
    expect(grade(scenario("two customers"), { calls: [{ name: "entities_rows", input: {} }, ask], text: "" }).every((g) => g.ok)).toBe(true);
  });
});
