import { itemsTable, type ModelDef } from "@hera/config-engine";

// Minimal valid model a /models/new draft starts from; passes checkModel (unitCost is in
// pricing scope). The item grid is not optional — checkModel refuses a model without one —
// so it is seeded here, already placed in the starter group.
export function starterModel(name: string): ModelDef {
  return {
    name,
    parameters: [],
    structure: { sections: [{ key: "main", title: "General", groups: [{ key: "general", title: "General", params: ["items"] }] }] },
    computed: [],
    constraints: [],
    tables: [itemsTable()],
    bom: [],
    routing: [],
    pricing: { priceExpr: "unitCost * 1.2", quoteItemCode: "CFG" },
    batchDefaults: [1, 10, 100],
  };
}
