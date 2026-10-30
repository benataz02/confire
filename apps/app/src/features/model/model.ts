import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import type { Row, Section } from "@confire/ui/types.ts";

// The model builder's object page, declared like a B1 record's (features/b1/documents.tsx): what is
// a plain field or grid is data here; the structure tree, the preview and the combination list are
// templates (ModelBuilderPage). Expressions, the masterdata pickers and the batch quantities are
// control kinds (controls.tsx), named by `controlType`. The record is record.ts's.

type Translate = (key: string, ...params: string[]) => string;

const newId = (prefix: string, taken: unknown[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};
const ids = (rows: Row[]) => rows.map((r) => r.id);

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
          { key: "pricing.priceExpr", label: t("MODEL_PRICE_EXPR"), required: true, controlType: "priceExpr" },
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
  // The structure tree and the live preview (a template). fitContent: the section fills what the
  // title and tab bar leave, the only way the splitter's panes get a height to split and scroll.
  { id: MODEL_SECTIONS.params, label: t("MODEL_SECTION_PARAMS"), fitContent: true },
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
      {
        id: "bom", label: t("MODEL_BOM"),
        table: {
          key: "bom",
          columns: [
            // A line's id is an internal key (error messages name it); the visible counter is its place.
            { key: "VisualOrder", label: "#", width: 48, readonly: true },
            { key: "itemCode", label: t("MODEL_ITEM"), width: 240, controlType: "itemCode", required: true },
            { key: "desc", label: t("MODEL_DESC"), controlType: "text", placeholder: t("MODEL_DESC_FROM_ITEM") },
            { key: "condition", label: t("MODEL_CONDITION"), controlType: "lineExpr", placeholder: t("MODEL_COND_EMPTY") },
            { key: "qty", label: t("MODEL_QTY_PER"), width: 144, controlType: "lineExpr", required: true },
          ],
          newRow: (rows) => ({ id: newId("line", ids(rows)), itemCode: '""', qty: "1" }),
        },
      },
      {
        id: "routing", label: t("MODEL_ROUTING"),
        table: {
          key: "routing",
          columns: [
            { key: "VisualOrder", label: "#", width: 48, readonly: true },
            { key: "resource", label: t("MODEL_RESOURCE"), controlType: "text", required: true, placeholder: t("MODEL_RESOURCE_PH") },
            { key: "desc", label: t("MODEL_DESC"), controlType: "text", placeholder: t("MODEL_OP_DESC_PH") },
            { key: "condition", label: t("MODEL_CONDITION"), controlType: "lineExpr", placeholder: t("MODEL_OP_COND_EMPTY") },
            { key: "setupMin", label: t("MODEL_SETUP"), controlType: "lineExpr", required: true },
            { key: "runMinPerUnit", label: t("MODEL_RUN"), controlType: "lineExpr", required: true },
            { key: "ratePerHour", label: t("MODEL_RATE"), controlType: "lineExpr", required: true },
          ],
          newRow: (rows) => ({ id: newId("op", ids(rows)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }),
        },
      },
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
