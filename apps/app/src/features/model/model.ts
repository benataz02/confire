import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import type { Section } from "@confire/ui/types.ts";

// The model builder's object page, declared like a B1 record's (features/b1/documents.tsx): what is
// a plain field or grid is data here; the structure tree and the combination list are templates
// (ModelBuilderPage). Expressions, the masterdata pickers and the batch quantities are
// control kinds (controls.tsx), named by `controlType`. The record is record.ts's.

type Translate = (key: string, ...params: string[]) => string;

/** Section ids, also the issue mapping's (builderMessages' sectionOf). */
export const MODEL_SECTIONS = { settings: "settings", params: "params", rules: "rules", outputs: "outputs", history: "history" } as const;

export const modelSections = (t: Translate): Section[] => [
  {
    id: MODEL_SECTIONS.settings, label: t("MODEL_SECTION_SETTINGS"),
    subsections: [
      {
        id: "model", label: t("MODEL_GROUP_MODEL"),
        fields: [
          { key: "name", label: t("MODEL_NAME"), required: true, controlType: "text", help: t("MODEL_NAME_HINT") },
          { key: "description", label: t("MODEL_DESCRIPTION"), controlType: "text", placeholder: t("MODEL_DESCRIPTION_PH") },
          { key: "batchDefaults", label: t("MODEL_BATCHES"), required: true, controlType: "batches" },
        ],
        // A group of its own: the form's second column, the whole of it.
        groups: [{
          id: "assistant", label: t("MODEL_ASSISTANT"),
          fields: [{ key: "instructions", label: t("MODEL_INSTRUCTIONS"), controlType: "prompt", help: t("MODEL_INSTRUCTIONS_HINT"), placeholder: t("MODEL_INSTRUCTIONS_PH") }],
        }],
      },
      {
        id: "pricing", label: t("MODEL_PRICING"),
        fields: [
          // BOM lines carry no price of their own: this list is where every material's unit price is
          // read from, live, on each calculation. Label mode: its name shows, its number is stored.
          {
            key: "pricing.priceList", label: t("MODEL_PRICE_LIST"), required: true, help: t("MODEL_PRICE_LIST_ERR"),
            cfl: { dialogConfig: cfl.priceLists() },
            onChange: (v) => ({ "pricing.priceList": v === null || v === undefined || v === "" ? undefined : Number(v) }),
          },
          // Where those prices are cached: an `Items` masterdata query with no columns selected, so
          // B1 returns whole rows and the nested ItemPrices collection survives the sync.
          { key: "pricing.itemTable", label: t("MODEL_ITEM_SOURCE"), required: true, controlType: "masterdataQuery" },
          // Where the routing's Beas operations are cached, as the item source is for the BOM.
          // Optional: checkModel asks for it only once a routing line is linked to an operation.
          { key: "pricing.operationTable", label: t("MODEL_OP_SOURCE"), controlType: "masterdataQuery", help: t("MODEL_OP_SOURCE_HELP") },
          // A share of the price; each configuration may set its own in its Candidates section.
          {
            key: "pricing.margin", label: t("MODEL_MARGIN"), type: "number", required: true, help: t("MODEL_MARGIN_HELP"),
            onChange: (v) => ({ "pricing.margin": v === null || v === undefined || v === "" ? undefined : Number(v) }),
          },
          {
            key: "pricing.quoteItemCode", label: t("MODEL_QUOTE_ITEM"), required: true, help: t("MODEL_QUOTE_ITEM_ERR"),
            cfl: { dialogConfig: cfl.items() }, link: true,
            onChange: (v) => ({ "pricing.quoteItemCode": v === null || v === undefined ? "" : String(v) }),
          },
        ],
      },
      // The customer portal (spec D15, D21): columns beside the definition, saved with it.
      {
        id: "portal", label: t("MODEL_PORTAL"),
        fields: [
          { key: "portal", label: t("MODEL_PORTAL_PUBLISH"), type: "boolean", help: t("MODEL_PORTAL_HINT") },
          {
            key: "portalPricing", label: t("MODEL_PORTAL_PRICES"), required: true,
            options: [
              { value: "indicative", label: t("MODEL_PRICING_INDICATIVE") },
              { value: "request", label: t("MODEL_PRICING_REQUEST") },
            ],
          },
        ],
      },
    ],
  },
  // The structure tree (a template).
  { id: MODEL_SECTIONS.params, label: t("MODEL_SECTION_PARAMS") },
  {
    id: MODEL_SECTIONS.rules, label: t("MODEL_SECTION_RULES"),
    subsections: [
      {
        id: "exprRules", label: t("MODEL_EXPR_CONSTRAINTS"),
        table: {
          key: "constraints",
          columns: [
            { key: "when", label: t("MODEL_WHEN"), controlType: "expr" },
            { key: "assert", label: t("MODEL_MUST_HOLD"), controlType: "expr", required: true, placeholder: t("MODEL_ASSERT_PH") },
            { key: "message", label: t("MODEL_MESSAGE"), controlType: "text", required: true, placeholder: t("MODEL_MESSAGE_PH") },
          ],
          newRow: () => ({ kind: "expr", assert: "", message: "" }),
        },
      },
      // The list and its edit dialog: a template (CombinationTables).
      { id: "combinations", label: t("MODEL_COMBO_TABLES") },
    ],
  },
  {
    id: MODEL_SECTIONS.outputs, label: t("MODEL_SECTION_OUTPUTS"),
    subsections: [
      // Each a table of lines and the dialog that edits one: templates (LineTables).
      { id: "bom", label: t("MODEL_BOM") },
      { id: "routing", label: t("MODEL_ROUTING") },
    ],
  },
  // The process page's "Similar configurations": which masterdata query to rank against, which
  // parameter matches which of its columns, and what each result shows. The query is an ordinary
  // masterdata query, so its sync lives on the masterdata row.
  {
    id: MODEL_SECTIONS.history, label: t("MODEL_SECTION_HISTORY"),
    subsections: [
      {
        id: "source", label: t("MODEL_HISTORY_QUERY"),
        fields: [
          { key: "history.table", label: t("MODEL_QUERY"), controlType: "masterdataQuery" },
          { key: "history.display", label: t("MODEL_HISTORY_DISPLAY"), controlType: "historyDisplay" },
        ],
      },
      {
        id: "mappings", label: t("MODEL_MAPPINGS"),
        table: {
          key: "history.mappings",
          columns: [
            { key: "param", label: t("MODEL_PARAM"), controlType: "historyField", required: true },
            { key: "column", label: t("MODEL_COLUMN"), controlType: "historyColumn", required: true },
            {
              key: "match", label: t("MODEL_MATCH"), required: true,
              options: (["exact", "closeness", "contains"] as const).map((m) => ({ value: m, label: t(`MODEL_MATCH_${m.toUpperCase()}`) })),
            },
            { key: "weight", label: t("MODEL_WEIGHT"), width: 160, controlType: "weight", required: true },
          ],
          newRow: () => ({ param: "", column: "", match: "exact", weight: 1 }),
        },
      },
    ],
  },
];
