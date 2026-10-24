import { afterEach, expect, test } from "bun:test";
import { formatLocale } from "./format.ts";

// No DOM here, so UI5's language is its default, English.
const browser = (languages: string[]) =>
  Object.defineProperty(globalThis.navigator, "languages", { value: languages, configurable: true });
afterEach(() => browser([]));

test("formatLocale keeps the browser's region when it speaks the UI language, and only then", () => {
  browser(["en-GB"]);
  expect(formatLocale()).toBe("en-GB");
  browser(["es-ES"]);
  expect(formatLocale()).toBe("en");
});
