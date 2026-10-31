import { expect, test } from "bun:test";
import { plan } from "../src/lib/consent.ts";

// No third-party script before consent; Reject loads nothing; an unconfigured pixel never asks (spec §10).
const both = { meta: "1", linkedin: "2" }, none = { meta: "", linkedin: "" };

test("no choice yet: ask, load nothing", () => expect(plan(null, both)).toEqual({ showCard: true, load: [] }));
test("granted: load what is configured", () => {
  expect(plan("granted", { meta: "1", linkedin: "" })).toEqual({ showCard: false, load: ["meta"] });
  expect(plan("granted", both)).toEqual({ showCard: false, load: ["meta", "linkedin"] });
});
test("denied: load nothing", () => expect(plan("denied", both)).toEqual({ showCard: false, load: [] }));
test("no pixel configured: never ask", () => expect(plan(null, none)).toEqual({ showCard: false, load: [] }));
