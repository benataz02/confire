import { itemsTable, type ModelDef, type Visual } from "@confire/config-engine";

// The engine's test model (packages/config-engine/test/fixture.ts `withSheet`), for the builder's
// tests: hera's sheet visual `hoja` in a group with one parameter, the items grid in its own group.
export const SHEET_INPUTS = { sheetLength: "1000", sheetWidth: "500", pieceLength: "120", pieceWidth: "70", gapX: "3", gapY: "3", marginX: "10", marginY: "10" };
export const withSheet = (over: Partial<Visual> = {}, extra: Partial<ModelDef> = {}): ModelDef => ({
  name: "Sheet",
  parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
  structure: { sections: [{ key: "s", title: "S", groups: [
    { key: "g", title: "G", params: ["width", "hoja"] },
    { key: "it", title: "Items", params: ["items"] },
  ] }] },
  computed: [{ key: "perSheet", expr: "hoja_piezas" }],
  tables: [itemsTable()], constraints: [], bom: [], routing: [],
  pricing: { margin: 20, quoteItemCode: "Q", priceList: 1 },
  batchDefaults: [1],
  visuals: [{ key: "hoja", kind: "hera.sheetLayout", inputs: SHEET_INPUTS, ...over }],
  ...extra,
});
