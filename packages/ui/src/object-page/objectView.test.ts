import { expect, test } from "bun:test";
import { applyObjectView, defaultObjectState, resolveObjectState, withTableColumns } from "./objectView.ts";
import type { Section } from "../types.ts";

const lines: Section = {
  id: "lines", label: "Lines",
  table: { key: "DocumentLines", columns: [{ key: "ItemCode" }, { key: "Quantity" }, { key: "ShipDate", hidden: true }] },
};
const cols = (s: Section[]) => s[0]!.table!.columns.map((c) => `${c.key}${c.hidden ? "-" : ""}`);

test("a declared hidden column is Standard's default, and the grid's gear can show it", () => {
  const std = defaultObjectState([lines]);
  expect(cols(applyObjectView([lines], std, () => false))).toEqual(["ItemCode", "Quantity", "ShipDate-"]);

  const next = withTableColumns(std, "lines", ["ShipDate", "ItemCode", "__selection"]);
  expect(next.sections[0]!.fields).toEqual([
    { key: "ShipDate", visible: true }, { key: "ItemCode", visible: true }, { key: "Quantity", visible: false },
  ]);
  const shown = applyObjectView([lines], resolveObjectState(next, [lines]), () => false);
  expect(cols(shown)).toEqual(["ShipDate", "ItemCode", "Quantity-"]);
  // unchanged columns stay the declared objects (EditGrid keeps its cells mounted on them)
  expect(shown[0]!.table!.columns[1]).toBe(lines.table!.columns[0]!);
});
