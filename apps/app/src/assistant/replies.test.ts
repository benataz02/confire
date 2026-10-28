import { expect, test } from "bun:test";
import { nextReplies, type ReplyView } from "./replies.ts";

// Quick replies are worked out from the page's own state, so they never suggest what it contradicts.

const t = (k: string) => k;
const view = (p: Partial<{ missing: unknown[]; rows: unknown[]; picks: unknown[]; status: string }> = {}): ReplyView => ({
  missing: (p.missing ?? []) as ReplyView["missing"],
  candidates: { rows: (p.rows ?? []) as ReplyView["candidates"]["rows"] },
  selection: { picks: (p.picks ?? []) as ReplyView["selection"]["picks"] },
  project: { status: (p.status ?? "draft") as ReplyView["project"]["status"] },
});

test("what is missing is the question card's while it asks; past it, a reply asks the model", () => {
  expect(nextReplies({ kind: "configure", view: view({ missing: [{ code: "x" }] }), asking: true }, t)).not.toContain("ASSISTANT_REPLY_MISSING");
  expect(nextReplies({ kind: "configure", view: view({ missing: [{ code: "table_empty" }] }) }, t)[0]).toBe("ASSISTANT_REPLY_MISSING");
});

test("candidates with no selection offer to show them; picks offer the quotation", () => {
  expect(nextReplies({ kind: "configure", view: view({ rows: [{}] }) }, t)).toContain("ASSISTANT_REPLY_CANDIDATES");
  const picked = nextReplies({ kind: "configure", view: view({ rows: [{}], picks: [{}] }) }, t);
  expect(picked).toContain("ASSISTANT_REPLY_QUOTE");
  expect(picked).not.toContain("ASSISTANT_REPLY_CANDIDATES");
});

test("a quoted configuration never offers 'Prepare the quotation'", () => {
  expect(nextReplies({ kind: "configure", view: view({ rows: [{}], picks: [{}], status: "quoted" }) }, t)).not.toContain("ASSISTANT_REPLY_QUOTE");
});

test("never more than 4; general pages have their own; no view yet, nothing page-specific", () => {
  expect(nextReplies({ kind: "configure", view: view({ missing: [{}], rows: [{}], picks: [{}] }) }, t).length).toBeLessThanOrEqual(4);
  expect(nextReplies({ kind: "general" }, t)).toEqual(["ASSISTANT_REPLY_WAITING", "ASSISTANT_REPLY_DRAFTS"]);
  expect(nextReplies({ kind: "configure" }, t)).toEqual(["ASSISTANT_REPLY_SIMILAR"]);
  expect(nextReplies({ kind: "model" }, t)).toEqual([]);
});
