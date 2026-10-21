import { expect, test } from "bun:test";
import { checkModel } from "@confire/config-engine";
import { starterModel } from "./starterModel.ts";

test("the starter is complete but for the two things only the admin can answer", () => {
  // The price list is the other one; the quote item code is caught by ModelDefZ on save.
  expect(checkModel(starterModel(""), []).map((i) => i.path)).toEqual(["pricing.priceList"]);
  expect(starterModel("Cable").name).toBe("Cable");
});
