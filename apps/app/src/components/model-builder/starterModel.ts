import { ITEM_COL, ITEM_NAME_COL, QTY_COL, itemsTable, type ModelDef } from "@confire/config-engine";
import { copy, type Translate } from "./builderMessages.ts";

// Minimal valid model a /models/new draft starts from; passes checkModel (unitCost is in
// pricing scope). The item grid is not optional — checkModel refuses a model without one — so it
// is seeded here as a group of its own. No field group is seeded alongside it: an empty "General"
// group was only ever somewhere to put the item grid, and the item grid is not a field any more.
export function localizeItems<T extends { title: string; columns: { key: string; label: string }[] }>(items: T, t: Translate): T {
  items.title = copy(t, "MODEL_ITEMS_TITLE", items.title);
  items.columns = items.columns.map((c) => ({
    ...c,
    label: c.key === ITEM_COL ? copy(t, "MODEL_ITEM_CODE", c.label)
      : c.key === ITEM_NAME_COL ? copy(t, "MODEL_ITEM_NAME", c.label)
      : c.key === QTY_COL ? copy(t, "MODEL_ITEM_QTY", c.label)
      : c.label,
  }));
  return items;
}

export function starterModel(name: string, t?: Translate): ModelDef {
  const items = t ? localizeItems(itemsTable(), t) : itemsTable();
  return {
    name,
    parameters: [],
    structure: { sections: [{ key: "main", title: t ? copy(t, "MODEL_STARTER_SECTION", "General") : "General", groups: [{ table: "items" }] }] },
    computed: [],
    constraints: [],
    tables: [items],
    bom: [],
    routing: [],
    pricing: { margin: 20, quoteItemCode: "" },
    batchDefaults: [1, 10, 100],
  };
}
