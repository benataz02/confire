import { expect, test } from "bun:test";
import type { UIMessage } from "@tanstack/ai-react";
import { blocks, stepSummary } from "./steps.ts";

// The chat draws decisions as cards and everything else the agent did as steps between its words.

type Part = UIMessage["parts"][number];
const text = (content: string, metadata?: object): Part => ({ type: "text", content, ...(metadata ? { metadata } : {}) }) as Part;
const think = (content: string): Part => ({ type: "thinking", content }) as Part;
const tool = (name: string): Part => ({ type: "tool-call", id: name, name, arguments: "{}", state: "input-complete" }) as Part;
const kinds = (ps: Part[]) => blocks(ps).map((b) => (b.kind === "steps" ? `steps:${b.steps.length}` : b.kind));

test("thinking and tool calls join one run of steps until a text", () => {
  expect(kinds([think("hm"), tool("configs_get"), tool("configs_calculate"), text("Done."), tool("configs_get")]))
    .toEqual(["steps:3", "text", "steps:1"]);
});

test("a decision tool is a card of its own and splits the run", () => {
  expect(kinds([tool("entities_rows"), tool("ask_user")])).toEqual(["steps:1", "card"]);
  expect(kinds([tool("read_request"), tool("extract_values"), tool("propose_quotation")])).toEqual(["card", "steps:1", "card"]);
});

test("empty texts, file labels and empty thinking draw nothing and split nothing", () => {
  expect(kinds([tool("configs_get"), text("  "), think(""), text("RFQ.pdf", { fileLabel: true }), tool("configs_calculate")]))
    .toEqual(["steps:2"]);
});

const t = (k: string, ...a: string[]) => [k, ...a].join(" ");

test("a step says what it found", () => {
  expect(stepSummary("requests_rows", {}, { rows: [1, 2], total: 7 }, t)).toBe("ASSISTANT_STEP_FOUND 7");
  expect(stepSummary("configs_get", {}, { missing: [{}, {}], candidates: { rows: [] } }, t)).toBe("ASSISTANT_STEP_MISSING 2");
  expect(stepSummary("configs_select", {}, { missing: [], candidates: { rows: [{}] } }, t)).toBe("ASSISTANT_STEP_READY");
  expect(stepSummary("configs_calculate", { set: { a: 1, b: 2 }, batches: [10] }, {}, t)).toBe("ASSISTANT_STEP_WROTE 3");
  expect(stepSummary("extract_values", {}, { applied: [{}], questions: [{}, {}] }, t)).toBe("ASSISTANT_READ_COUNTS 1 2");
  expect(stepSummary("configs_models", {}, [{}, {}, {}], t)).toBe("ASSISTANT_STEP_MODELS 3");
  expect(stepSummary("home_overview", {}, { myDrafts: 1 }, t)).toBe("");
});
