import { expect, test } from "bun:test";
import type { FormState, ModelDef } from "@confire/config-engine";
import { GENERAL_SECTION } from "@confire/ui/configurator/formHelpers.ts";
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
  CONFIG_BATCHES_MISSING: "Add at least one batch quantity",
  CONFIG_MISSING_PARAM: "{0} is required",
  CONFIG_MISSING_ROWS: "{0}: add at least one row",
  CONFIG_MISSING_CELLS: "{0}: {1} is empty in row(s) {2}",
  CONFIG_NOT_AN_OPTION: "{1} is not one of the options of {0}",
  CONFIG_NOT_AN_OPTION_DETAIL: "Kept as entered.",
  CONFIG_CALC_FAILED: "The configuration could not be calculated.",
  CONFIG_CHANGE_REFUSED: "Not saved: the form shows what is stored.",
  CONFIG_CHANGE_UNSENT: "Not saved yet: press Retry.",
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
  t, model, missing: [], issues: [], form: null, calculation: null, locked: false,
} as const;
const notice = (code: string, params: string[] = [], key?: string) => ({ code, params, key, message: `server: ${code}` });
const formOf = (conflicts: FormState["conflicts"], visible: Record<string, boolean>) =>
  ({ conflicts, fields: Object.fromEntries(Object.entries(visible).map(([k, v]) => [k, { visible: v, required: false }])) });

test("General's fields are messages with a field to jump to, in the page's words", () => {
  const msgs = configMessages({ ...base, missing: [notice("name_required", [], "__name"), notice("customer_required", [], "__customer")] });
  expect(msgs.map((m) => m.text)).toEqual(["Enter a name", "Pick a business partner"]);
  expect(msgs.every((m) => m.type === "Critical" && m.section === GENERAL_SECTION)).toBe(true);
  expect(msgs.map((m) => m.anchor)).toEqual(["#cfg-name", "#cfg-customer"]);
});

test("what the quote waits on is translated by code, each jumping to its field; an unknown code reads as sent", () => {
  const msgs = configMessages({ ...base, missing: [
    notice("param_required", ["Width"], "width"), notice("cell_required", ["Items", "Name", "1, 3"], "items"), notice("brand_new", [], "x"),
  ] });
  expect(msgs.map((m) => [m.text, m.anchor])).toEqual([
    ["Width is required", '[data-param="width"]'],
    ["Items: Name is empty in row(s) 1, 3", '[data-param="items"]'],
    ["server: brand_new", '[data-param="x"]'],
  ]);
});

test("a parameter conflict jumps to that parameter and reads by its label", () => {
  const form = formOf([{ message: "no valid values remain for 'width'", params: ["width"] }], { width: true });
  const [msg] = configMessages({ ...base, form });
  expect(msg!.type).toBe("Negative");
  expect(msg!.detail).toBe("Width");
  expect(msg!.anchor).toBe('[data-param="width"]');
});

test("a rule conflict reads by the parameters it involves and jumps to the first one drawn", () => {
  const form = formOf([{ message: "Too wide for that height", params: ["height", "width"] }], { height: false, width: true });
  const [msg] = configMessages({ ...base, form });
  expect(msg!.text).toBe("Too wide for that height");
  expect(msg!.detail).toBe("height, Width");
  expect(msg!.anchor).toBe('[data-param="width"]');
});

test("a rule over computed values only has no field, so only the section", () => {
  const [msg] = configMessages({ ...base, form: formOf([{ message: "Too heavy", params: [] }], {}) });
  expect(msg!.anchor).toBeUndefined();
  expect(msg!.section).toBe(GENERAL_SECTION);
});

test("the enumeration cap is a Candidates warning naming the widest parameter", () => {
  const [msg] = configMessages({ ...base, issues: [notice("capped", ["200", "Width", "40"])] });
  expect(msg!.group).toBe("Candidates");
  expect(msg!.type).toBe("Critical");
  expect(msg!.text).toContain("200 candidates");
  expect(msg!.detail).toBe("Width is widest with 40 options");
});

test("an item costed at 0 is a Candidates warning, one per item, naming the price list", () => {
  const msgs = configMessages({
    ...base, model: { ...model, pricing: { priceList: 3 } } as ModelDef,
    issues: [notice("unpriced", ["MP_1", "3"]), notice("unpriced", ["MP_2", "3"])],
  });
  expect(msgs.every((m) => m.type === "Critical" && m.group === "Candidates")).toBe(true);
  expect(msgs[0]!.text).toBe("No price for MP_1 in price list 3");
  expect(msgs[0]!.detail).toContain("costed at 0");
});

test("sync state: never synced is Critical, a failed sync Negative with what is still shown", () => {
  const msgs = configMessages({ ...base, issues: [notice("sync_never", ["items"]), notice("sync_failed", ["prices", "timeout", "12"])] });
  expect(msgs.map((m) => [m.type, m.text, m.detail])).toEqual([
    ["Critical", "'items' has not been synced yet", "Its options are empty until the first sync finishes. Press Sync data."],
    ["Negative", "'prices' could not be refreshed: timeout", "Showing the 12 rows from the last good sync."],
  ]);
});

test("a value outside its options jumps to the field", () => {
  const [msg] = configMessages({ ...base, issues: [notice("not_an_option", ["Width", "9"], "width")] });
  expect([msg!.text, msg!.anchor]).toEqual(["9 is not one of the options of Width", '[data-param="width"]']);
});

test("a failed calculation says why; a refused and an undelivered edit say what happened to it", () => {
  expect(configMessages({ ...base, calculation: { state: "failed", message: "No valid configuration" } })[0]!.text).toBe("No valid configuration");
  const refused = configMessages({ ...base, writeError: { refused: true, error: new Error("width: read-only") } })[0]!;
  expect([refused.text, refused.detail]).toEqual(["width: read-only", "Not saved: the form shows what is stored."]);
  expect(configMessages({ ...base, writeError: { refused: false, error: new Error("offline") } })[0]!.detail).toBe("Not saved yet: press Retry.");
});

test("a clean configuration has nothing to say", () => {
  expect(configMessages(base)).toEqual([]);
});

test("read-only says why: quoted internally, or the request's status — the client's answer once given", () => {
  const lock = (locked: Parameters<typeof configMessages>[0]["locked"]) => configMessages({ ...base, locked })[0]?.text;
  expect(lock({ request: false, status: "quoted" })).toBe("Quoted — this configuration is read-only");
  expect(lock({ request: true, status: "submitted" })).toBe("Accept the request to edit it");
  expect(lock({ request: true, status: "quoted", quoteResponse: null })).toBe("Quoted — waiting for the client's answer");
  expect(lock({ request: true, status: "quoted", quoteResponse: "accepted" })).toBe("Quote accepted by the client");
});

test("every failed change is its own message, so an old one cannot hide a newer one", () => {
  const msgs = configMessages({ ...base, configErrors: [new Error("rename"), null, new Error("delete")] });
  expect(msgs.map((m) => m.text)).toEqual(["rename", "delete"]);
});
