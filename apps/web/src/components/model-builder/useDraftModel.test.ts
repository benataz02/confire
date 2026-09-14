import { expect, test } from "bun:test";
import { checkModel } from "@confire/config-engine";
import { starterModel } from "./starterModel.ts";

test("the unsaved starter is valid so Save is not blocked by checkModel", () => {
  expect(checkModel(starterModel(""), [])).toEqual([]);
  expect(starterModel("Cable").name).toBe("Cable");
});
