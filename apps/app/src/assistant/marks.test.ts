import { expect, test } from "bun:test";
import { fieldMarks, sourceTip } from "./marks.ts";

// The page's provenance marks (assistant spec §4.1): ✦ while a field still holds what the assistant
// wrote, 💬 while a question about it is open. A human edit drops the ✦ with no write of its own.

const t = (k: string, ...a: Array<string | number>) => `${k}(${a.join("|")})`;
const FILE = { file: "RFQ.pdf", page: 1, quote: "W 200" };
const tip = (s: Parameters<typeof sourceTip>[0]) => sourceTip(s, t);

test("a sourced key still holding its value is the assistant's, with its quote as the tip", () => {
  expect(fieldMarks({ width: 200 }, { width: { value: 200, source: FILE } }, [], tip))
    .toEqual({ width: { kind: "assistant", tip: "ASSISTANT_MARK_FILE(RFQ.pdf|1|W 200)" } });
});

test("an entry changed since is no longer marked", () => {
  expect(fieldMarks({ width: 250 }, { width: { value: 200, source: FILE } }, [], tip)).toEqual({});
  expect(fieldMarks({}, { width: { value: 200, source: FILE } }, [], tip)).toEqual({});
});

test("an open question marks its field, and wins over the assistant's mark", () => {
  expect(fieldMarks({ width: 200 }, { width: { value: 200, source: FILE } }, ["width", "size"], tip))
    .toEqual({ width: { kind: "question" }, size: { kind: "question" } });
});

test("lists compare by value; the user's own words and an image read the way they were said", () => {
  expect(fieldMarks({ colors: ["red", "blue"] }, { colors: { value: ["red", "blue"], source: { chat: "red and blue" } } }, [], tip))
    .toEqual({ colors: { kind: "assistant", tip: "ASSISTANT_SOURCE_CHAT(red and blue)" } });
  expect(sourceTip({ file: "photo.jpg", page: null, quote: "M8" }, t)).toBe("ASSISTANT_MARK_IMAGE(photo.jpg|M8)");
});
