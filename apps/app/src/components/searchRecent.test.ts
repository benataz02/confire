import { expect, test } from "bun:test";
import { parseRecent } from "./searchRecent.ts";

// The search's recent hits, kept in localStorage: what was stored before a scope went must not lead
// to a dead page.

test("recent hits from the removed Chats scope are dropped", () => {
  const raw = JSON.stringify([
    { text: "Cabinet", icon: "ai", to: "/assistant/t1", scope: "chats" },
    { text: "Sales", icon: "business-objects-experience", to: "/reports/r1#chat", scope: "chats" },
    { text: "Quotations", icon: "sales-quote", to: "/b1/Quotations", scope: "pages" },
  ]);
  expect(parseRecent(raw).map((r) => r.to)).toEqual(["/b1/Quotations"]);
});
test("broken JSON or a broken entry reads as nothing", () => {
  expect(parseRecent("{")).toEqual([]);
  expect(parseRecent(JSON.stringify([{ text: 1 }]))).toEqual([]);
  expect(parseRecent(null)).toEqual([]);
});
