import { expect, test } from "bun:test";
import type { ModelDef, Propagation } from "@confire/config-engine";
import { configMessages } from "./configMessages.ts";

/** English sentences, not the properties file — `{n}` is filled in order. */
const EN: Record<string, string> = {
  CONFIG_SECTION_CONFIGURE: "Configure",
  CONFIG_SECTION_CANDIDATES: "Candidates",
  CONFIG_LOCK_QUOTED: "Quoted — this configuration is read-only",
  CONFIG_LOCK_QUOTED_DETAIL: "The quotation it produced is what SAP holds now.",
  CONFIG_LOCK_SUBMITTED: "Accept the request to edit it",
  CONFIG_LOCK_SUBMITTED_DETAIL: "It stays exactly as the client submitted it until someone takes it into review.",
  CONFIG_LOCK_RETURNED: "With the client for changes",
  CONFIG_LOCK_RETURNED_DETAIL: "The client edits it now; it comes back when they resubmit.",
  CONFIG_LOCK_DECLINED: "Declined — this request is closed",
  CONFIG_LOCK_DECLINED_DETAIL: "Nothing can change on it any more.",
  CONFIG_LOCK_AWAITING: "Quoted — waiting for the client's answer",
  CONFIG_LOCK_AWAITING_DETAIL: "A decline reopens the request in review.",
  CONFIG_LOCK_ACCEPTED: "Quote accepted by the client",
  CONFIG_LOCK_ACCEPTED_DETAIL: "Create the sales order in SAP from the quotation.",
  CONFIG_ENTER_NAME: "Enter a name",
  CONFIG_REQUIRED_OPEN: "Required before the configurator opens.",
  CONFIG_PICK_BP: "Pick a business partner",
  CONFIG_REQUIRED_QUOTE: "Required before the configuration can be quoted.",
  CONFIG_LOOKUPS_FAILED: "Option lists could not be loaded",
  CONFIG_CHANGE_FAILED: "The last change did not go through",
  CONFIG_SYNC_FAILED_TABLE: "'{0}' could not be refreshed: {1}",
  CONFIG_SYNC_SHOWING: "Showing the {0} rows from the last good sync.",
  CONFIG_SYNC_NONE: "No data has been cached yet.",
  CONFIG_SYNC_NEVER: "'{0}' has not been synced yet",
  CONFIG_SYNC_NEVER_DETAIL: "Its options are empty until the first sync finishes. Press Sync data.",
  CONFIG_SYNC_ERROR: "Sync failed",
  CONFIG_CAPPED: "Stopped at {0} candidates — set more parameters",
  CONFIG_WIDEST: "{0} is widest with {1} options",
  CONFIG_UNPRICED_LIST: "No price for {0} in price list {1}",
  CONFIG_UNPRICED: "No price for {0} in the price list",
  CONFIG_UNPRICED_DETAIL: "Its material is costed at 0 until the item has a price and the data is synced.",
  CONFIG_SELECT_FAILED: "Selection not saved",
};

const t = (key: string, ...params: string[]) => {
  const template = EN[key];
  if (template === undefined) throw new Error(`missing English text for ${key}`);
  return template.replace(/\{(\d+)\}/g, (_, i: string) => params[Number(i)] ?? "");
};

const model = {
  name: "T",
  parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
} as unknown as ModelDef;

const base = {
  t, model, name: "Q1", customer: true, prop: null, candidates: 0,
  capped: false, locked: false,
} as const;

test("the two Calculate blockers are messages with a field to jump to", () => {
  const msgs = configMessages({ ...base, name: " ", customer: false });
  expect(msgs.map((m) => m.id)).toEqual(["name", "customer"]);
  expect(msgs.every((m) => m.type === "Critical" && m.section === "configure")).toBe(true);
  expect(msgs.map((m) => m.anchor)).toEqual(["#cfg-name", "#cfg-customer"]);
});

test("a parameter conflict jumps to that parameter and reads by its label", () => {
  const prop = {
    conflicts: [{ message: "no valid values remain for 'width'", path: "parameters.width", params: ["width"] }],
    visible: { width: true },
  } as unknown as Propagation;
  const [msg] = configMessages({ ...base, prop });
  expect(msg!.type).toBe("Negative");
  expect(msg!.detail).toBe("Width");
  expect(msg!.anchor).toBe('[data-param="width"]');
});

test("a rule conflict reads by the parameters it involves and jumps to the first one drawn", () => {
  const prop = {
    conflicts: [{ message: "Too wide for that height", path: "constraints[0]", params: ["height", "width"] }],
    visible: { height: false, width: true },
  } as unknown as Propagation;
  const [msg] = configMessages({ ...base, prop });
  expect(msg!.text).toBe("Too wide for that height");
  expect(msg!.detail).toBe("height, Width");
  expect(msg!.anchor).toBe('[data-param="width"]');
});

test("a rule over computed values only has no field, so only the section", () => {
  const prop = { conflicts: [{ message: "Too heavy", path: "constraints[0]", params: [] }], visible: {} } as unknown as Propagation;
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
