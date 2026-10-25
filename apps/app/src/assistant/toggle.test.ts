import { expect, test } from "bun:test";
import { assistantToggle } from "./toggle.ts";

// The ShellBar's assistant toggle: disabled while the assistant cannot run, its tooltip saying why
// (an admin's switch, or the server's missing API key) — no panel to open onto a "no".

const t = (k: string) => k;

test("on: enabled, named", () => {
  expect(assistantToggle({ enabled: true, reason: null }, t)).toEqual({ disabled: false, tooltip: "ASSISTANT_TITLE" });
});

test("off: disabled, with the reason and who can fix it", () => {
  expect(assistantToggle({ enabled: false, reason: "switch" }, t)).toEqual({ disabled: true, tooltip: "ASSISTANT_OFF. ASSISTANT_OFF_SUB" });
  expect(assistantToggle({ enabled: false, reason: "no_key" }, t)).toEqual({ disabled: true, tooltip: "ASSISTANT_NO_KEY. ASSISTANT_NO_KEY_SUB" });
});

test("not known yet: disabled, named", () => {
  expect(assistantToggle(undefined, t)).toEqual({ disabled: true, tooltip: "ASSISTANT_TITLE" });
});
