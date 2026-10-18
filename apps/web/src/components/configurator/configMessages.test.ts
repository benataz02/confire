import { expect, test } from "bun:test";
import type { ModelDef, Propagation } from "@confire/config-engine";
import { configMessages } from "./configMessages.ts";

const model = {
  name: "T",
  parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
} as unknown as ModelDef;

const base = {
  model, name: "Q1", customer: true, prop: null, candidates: 0,
  capped: false, locked: false,
} as const;

test("the two Calculate blockers are messages with a field to jump to", () => {
  const msgs = configMessages({ ...base, name: " ", customer: false });
  expect(msgs.map((m) => m.id)).toEqual(["name", "customer"]);
  expect(msgs.every((m) => m.type === "Critical" && m.section === "configure")).toBe(true);
  expect(msgs.map((m) => m.anchor)).toEqual(["#cfg-name", "#cfg-customer"]);
});

test("a parameter conflict jumps to that parameter and reads by its label", () => {
  const prop = { conflicts: [{ message: "no valid values remain for 'width'", path: "parameters.width" }] } as Propagation;
  const [msg] = configMessages({ ...base, prop });
  expect(msg!.type).toBe("Negative");
  expect(msg!.detail).toBe("Width");
  expect(msg!.anchor).toBe('[data-param="width"]');
});

test("a constraint conflict has no control on this page, so only the section", () => {
  const prop = { conflicts: [{ message: "rule violated", path: "constraints[0]" }] } as Propagation;
  const [msg] = configMessages({ ...base, prop });
  expect(msg!.anchor).toBeUndefined();
  expect(msg!.section).toBe("configure");
});

test("the enumeration cap is a Candidates warning naming the widest parameter", () => {
  const [msg] = configMessages({
    ...base, capped: true, candidates: 200, widest: { key: "width", size: 40 },
  });
  expect(msg!.group).toBe("Candidates");
  expect(msg!.type).toBe("Critical");
  expect(msg!.text).toContain("200 candidates");
  expect(msg!.detail).toBe("Width is widest with 40 options");
});

test("an item costed at 0 is a Candidates warning, one per item, naming the price list", () => {
  const msgs = configMessages({
    ...base, model: { ...model, pricing: { priceList: 3 } } as ModelDef, unpriced: ["MP_1", "MP_2"],
  });
  expect(msgs.map((m) => m.id)).toEqual(["unpriced:MP_1", "unpriced:MP_2"]);
  expect(msgs.every((m) => m.type === "Critical" && m.group === "Candidates")).toBe(true);
  expect(msgs[0]!.text).toBe("No price for MP_1 in price list 3");
  expect(msgs[0]!.detail).toContain("costed at 0");
});

test("a clean configuration has nothing to say", () => {
  expect(configMessages(base)).toEqual([]);
});

test("what the quote waits on is listed, each jumping to its field", () => {
  const msgs = configMessages({ ...base, missing: [{ key: "items", message: "Items: add at least one row" }] });
  expect(msgs.map((m) => [m.type, m.text, m.anchor])).toEqual([["Critical", "Items: add at least one row", '[data-param="items"]']]);
});

test("read-only says why: quoted internally, or the request's status — the client's answer once given", () => {
  const lock = (locked: Parameters<typeof configMessages>[0]["locked"]) => configMessages({ ...base, locked })[0]?.text;
  expect(lock({ request: false, status: "quoted" })).toBe("Quoted — this configuration is read-only");
  expect(lock({ request: true, status: "submitted" })).toBe("Accept the request to edit it");
  expect(lock({ request: true, status: "quoted", quoteResponse: null })).toBe("Quoted — waiting for the client's answer");
  expect(lock({ request: true, status: "quoted", quoteResponse: "accepted" })).toBe("Quote accepted by the client");
});

test("every failed change is its own message, so an old one cannot hide a newer one", () => {
  const msgs = configMessages({ ...base, configErrors: [new Error("rename"), null, new Error("calc")] });
  expect(msgs.map((m) => m.text)).toEqual(["rename", "calc"]);
});
