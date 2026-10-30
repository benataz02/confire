import { expect, test } from "bun:test";
import { diffModel, type ModelDef } from "@confire/config-engine";
import { starterModel } from "../../components/model-builder/starterModel.ts";
import { fromRecord, toRecord, withDef, type ModelRow } from "./record.ts";

const model: ModelDef = {
  ...starterModel("Cable"),
  description: "A cable",
  pricing: { priceExpr: "unitCost * 1.2", quoteItemCode: "CAB", priceList: 3, itemTable: "items" },
  constraints: [
    { kind: "expr", assert: "a > 0", message: "positive" },
    { kind: "table", params: ["a", "b"], rows: [[1, 2]], mode: "allow" },
  ],
  history: { table: "quotes", mappings: [], display: ["DocNum"] },
};
const row: ModelRow = { definition: model, portal: true, portalPricing: "indicative" };

test("a round trip is the identity", () => {
  expect(fromRecord(toRecord(row))).toEqual(row);
  const bare: ModelRow = { definition: starterModel("X"), portal: false, portalPricing: "request" };
  expect(fromRecord(toRecord(bare))).toEqual(bare);
});

test("pricing lands on keys equal to checkModel's issue paths", () => {
  const r = toRecord(row);
  expect(r["pricing.priceList"]).toBe(3);
  expect(r["history.display"]).toEqual(["DocNum"]);
});

test("a change through the record diffs to the same patch as the change on the definition", () => {
  const renamed: ModelDef = { ...model, name: "Wire", pricing: { ...model.pricing, priceList: 4 } };
  const viaRecord = { ...toRecord(row), name: "Wire", "pricing.priceList": 4 };
  expect(diffModel(model, fromRecord(viaRecord).definition)).toEqual(diffModel(model, renamed));

  const added = withDef((d) => ({ ...d, computed: [...d.computed, { key: "v", expr: "1" }] }))(toRecord(row));
  expect(diffModel(model, fromRecord(added).definition)).toEqual(diffModel(model, { ...model, computed: [{ key: "v", expr: "1" }] }));
  // The portal columns ride beside the definition and never into its patch.
  expect(fromRecord({ ...toRecord(row), portal: false }).definition).toEqual(model);
});
