import { expect, test } from "bun:test";
import { VISUALS } from "@confire/config-engine";
import { VISUAL_VIEWS } from "./registry.ts";

test("drawings and calculations name the same kinds", () => {
  expect(Object.keys(VISUAL_VIEWS).sort()).toEqual(Object.keys(VISUALS).sort());
});
