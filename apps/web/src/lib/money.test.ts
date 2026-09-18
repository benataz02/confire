import { expect, test } from "bun:test";
import { money } from "./money.ts";

test("no currency renders a plain number, not an invented symbol", () => {
  const out = money(1234.5);
  expect(out).not.toContain("€");
  expect(out).toContain("1");
});

test("a currency renders as one", () => {
  expect(money(1234.5, "EUR")).toMatch(/1.?234/);
  expect(money(1234.5, "EUR")).not.toBe("1234.50 EUR");
});

test("a code B1 has but ISO 4217 does not must not throw the page away", () => {
  expect(() => money(10, "NOTACODE")).not.toThrow();
  expect(money(10, "NOTACODE")).toBe("10.00 NOTACODE");
});

test("always two decimals, whatever the currency's own digit count is", () => {
  // JPY is a 0-decimal currency and KWD a 3-decimal one; both must still read as 2 here.
  expect(money(1234.5, "EUR")).toMatch(/50$/);
  expect(money(1234.5, "JPY")).toMatch(/50$/);
  expect(money(1234.5678, "KWD")).toMatch(/57$/);
  expect(money(1234.5)).toMatch(/50$/);
});
