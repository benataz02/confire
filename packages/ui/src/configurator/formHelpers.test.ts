import { expect, test } from "bun:test";
import { addBatch, displayValue } from "./formHelpers.ts";

const yn = [
  { value: true, label: "Yes" },
  { value: false, label: "No" },
];
const colors = [
  { value: "red", label: "Crimson" },
  { value: "blue", label: "Azure" },
];

test("displayValue: empty is blank, not a dash", () => {
  expect(displayValue(undefined, [])).toBe("");
  expect(displayValue(null, yn)).toBe("");
});

test("displayValue: domain label, else the raw string; 0 is a value", () => {
  expect(displayValue(true, yn)).toBe("Yes");
  expect(displayValue("red", colors)).toBe("Crimson");
  expect(displayValue("gone", colors)).toBe("gone");
  expect(displayValue(0, [])).toBe("0");
});

test("displayValue: multicombo joins labels", () => {
  expect(displayValue(["red", "blue"], colors)).toBe("Crimson, Azure");
});

test("addBatch: positive integers only, de-duped, ascending", () => {
  expect(addBatch([10], " 5 ")).toEqual([5, 10]);
  for (const raw of ["", "  ", "-3", "0", "2.5", "abc", "10"]) expect(addBatch([10], raw)).toEqual([10]);
});
