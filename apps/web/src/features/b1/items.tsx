import type { EntityFeature } from "../../shared/types.ts";

// Items, declared. ItemCode is requiredOnCreate and not in the write allowlist: editable while
// creating, read-only after.

export const items: EntityFeature = {
  entity: "Items",
  label: "Items",
  icon: "product",
  keyField: "ItemCode",
  list: {
    tableId: "b1:Items",
    title: "Items",
    columns: [
      { key: "ItemCode", width: 160 },
      { key: "ItemName" },
      { key: "ItemsGroupCode", width: 120, groupable: true },
      { key: "BarCode", width: 150 },
      { key: "ForeignName", hidden: true },
      { key: "SalesUnit", width: 110 },
      { key: "InventoryUOM", width: 110 },
    ],
    filterFields: [
      { key: "ItemCode" },
      { key: "ItemName" },
      { key: "ItemsGroupCode" },
    ],
  },
  detail: {
    header: {
      titleField: "ItemName",
      subtitleFields: ["ItemCode", "ItemsGroupCode"],
      createTitle: "New item",
    },
    sections: [
      {
        id: "general",
        label: "General",
        groups: [
          {
            id: "item",
            label: "Item",
            fields: [{ key: "ItemCode" }, { key: "ItemName" }, { key: "ForeignName" }, { key: "ItemsGroupCode", readonly: true }, { key: "BarCode" }],
          },
          { id: "units", label: "Units of measure", fields: [{ key: "SalesUnit" }, { key: "InventoryUOM" }, { key: "PurchaseUnit" }] },
        ],
      },
      { id: "notes", label: "Notes", fields: [{ key: "User_Text", controlType: "textarea" }] },
    ],
  },
};
