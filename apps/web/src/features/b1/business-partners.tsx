import { cfl } from "../../shared/cfl/cfl-configs.ts";
import type { EntityFeature } from "../../shared/types.ts";

// Business partners, declared. CardCode and CardType are requiredOnCreate but not in the write
// allowlist, so metadata makes them editable while creating and read-only after — nothing here
// has to say so.

export const businessPartners: EntityFeature = {
  entity: "BusinessPartners",
  label: "Business partners",
  icon: "customer",
  keyField: "CardCode",
  list: {
    tableId: "b1:BusinessPartners",
    title: "Business partners",
    columns: [
      { key: "CardCode", width: 140 },
      { key: "CardName" },
      { key: "CardType", width: 120, groupable: true },
      { key: "Phone1", width: 150 },
      { key: "EmailAddress" },
      { key: "City", groupable: true },
      { key: "Currency", width: 90, hidden: true },
    ],
    filterFields: [
      { key: "CardCode" },
      { key: "CardName" },
      { key: "CardType" },
    ],
  },
  detail: {
    header: {
      titleField: "CardName",
      subtitleFields: ["CardCode", "CardType"],
      createTitle: "New business partner",
    },
    sections: [
      {
        id: "general",
        label: "General",
        groups: [
          { id: "identity", label: "Business partner", fields: [{ key: "CardCode" }, { key: "CardName" }, { key: "CardType" }] },
          { id: "contact", label: "Contact", fields: [{ key: "Phone1" }, { key: "Cellular" }, { key: "EmailAddress" }] },
          {
            id: "sales",
            label: "Sales",
            fields: [
              { key: "SalesPersonCode", cfl: { dialogConfig: cfl.salesPersons() } },
              { key: "Currency", cfl: { dialogConfig: cfl.currencies() } },
            ],
          },
        ],
      },
      {
        id: "notes",
        label: "Notes",
        fields: [{ key: "Notes", controlType: "textarea" }, { key: "FreeText", controlType: "textarea" }],
      },
    ],
    createDefaults: () => ({ CardType: "cCustomer" }),
  },
};
