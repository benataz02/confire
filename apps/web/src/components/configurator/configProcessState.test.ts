import { expect, test } from "bun:test";
import { addBatch } from "./configProcessState.ts";

// The batch-quantities field stringifies StepInput's committed number, so every rejection path
// below is a value a user can actually put in front of the Add button.
test("addBatch keeps the list positive, whole, unique and ascending", () => {
  expect(addBatch([], "10")).toEqual([10]);
  expect(addBatch([10], "5")).toEqual([5, 10]);   // sorted, not appended
  expect(addBatch([10], "10")).toEqual([10]);     // de-duped
  expect(addBatch([10], "0")).toEqual([10]);      // positive only
  expect(addBatch([10], "-3")).toEqual([10]);
  expect(addBatch([10], "2.5")).toEqual([10]);    // whole numbers only
  expect(addBatch([10], "abc")).toEqual([10]);    // NaN
  expect(addBatch([10], "")).toEqual([10]);       // "" coerces to 0
  expect(addBatch([10], "  ")).toEqual([10]);
});
