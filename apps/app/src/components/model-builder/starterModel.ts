import { itemsTable, type ModelDef } from "@confire/config-engine";

// Minimal valid model a /models/new draft starts from; passes checkModel (unitCost is in
// pricing scope). The item grid is not optional — checkModel refuses a model without one — so it
// is seeded here as a group of its own. No field group is seeded alongside it: an empty "General"
// group was only ever somewhere to put the item grid, and the item grid is not a field any more.
export function starterModel(name: string): ModelDef {
  return {
    name,
    parameters: [],
    structure: { sections: [{ key: "main", title: "General", groups: [{ table: "items" }] }] },
    computed: [],
    constraints: [],
    tables: [itemsTable()],
    bom: [],
    routing: [],
    pricing: { priceExpr: "unitCost * 1.2", quoteItemCode: "" },
    batchDefaults: [1, 10, 100],
  };
}
