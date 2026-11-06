import { expect, test } from "bun:test";
import { stampText, timeOf } from "./stamp.ts";

// The time above each turn, as Joule stamps its messages.

const t = (k: string, ...a: string[]) => `${k} ${a.join(",")}`;
const short = (d: Date) => new Intl.DateTimeFormat("es", { timeStyle: "short" }).format(d);
test("today and yesterday by the calendar day, then the date", () => {
  const now = new Date(2026, 10, 6, 18, 0);
  expect(stampText(new Date(2026, 10, 6, 13, 34), now, "es", t)).toBe("ASSISTANT_TODAY 13:34");
  expect(stampText(new Date(2026, 10, 5, 23, 59), now, "es", t)).toBe("ASSISTANT_YESTERDAY 23:59");
  const boundary = new Date(2026, 9, 31, 9, 5);
  expect(stampText(boundary, new Date(2026, 10, 1, 8, 0), "es", t)).toBe(`ASSISTANT_YESTERDAY ${short(boundary)}`);
  const old = new Date(2026, 10, 4, 9, 5);
  expect(stampText(old, now, "es", t)).toBe(new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(old));
});
test("the server's stamp first, a live turn's own time next, else none", () => {
  expect(timeOf({ metadata: { at: "2026-11-06T13:34:00.000Z" }, createdAt: new Date(0) })?.toISOString()).toBe("2026-11-06T13:34:00.000Z");
  expect(timeOf({ createdAt: 1_700_000_000_000 })?.getTime()).toBe(1_700_000_000_000);
  expect(timeOf({})).toBeNull();
  expect(timeOf({ metadata: { at: "garbage" } })).toBeNull();
});
