import { checkModel, isTableGroup, REQUIRED_ITEM_COLS, type ModelDef, type TableColumn, type TableDef } from "@confire/config-engine";
import type { RecordIssues, RecordMessage } from "@confire/ui/object-page/useObjectRecord.ts";
import type { Row, Section } from "@confire/ui/types.ts";
import { copy } from "../../components/model-builder/builderMessages.ts";
import { issueText, modelWithTable, type TableCols } from "../../components/model-builder/exprHelpers.ts";

// One table of the open model, as a record of its own: the TableDef's fields. Definition is
// declared; Fields stays a template (TableFields) — a grid whose cells change with the column's kind.
// Placement is not here: that is the structure tree's job.

type Translate = (key: string, ...params: string[]) => string;

/** What is wrong with a table or field key, in the author's words — formulas read both by key. */
export const keyProblem = (key: string, t: Translate) =>
  !key ? t("MODEL_KEY_EMPTY")
  : !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? t("MODEL_KEY_CHARS")
  : undefined;

/** Columns the table's own definition leans on: renaming or deleting one would break the price
 *  split, silently stop writing a mapped SAP field, or leave the document history with nothing to
 *  match on. Mapped columns are derived, not hardcoded, so the set follows the author if they remap. */
export const lockedColumns = (t: TableDef): Set<string> =>
  t.role === "items" ? new Set([...REQUIRED_ITEM_COLS, ...Object.keys(t.map ?? {})]) : new Set<string>();

/** The role is fixed (the items grid is seeded and undeletable), so the page's declaration is too. */
export const tableSections = (t: Translate, role: TableDef["role"]): Section[] => [
  {
    id: "definition", label: t("MODEL_DEFINITION"),
    fields: [
      { key: "key", label: t("MODEL_KEY"), help: t("MODEL_KEY_HELP"), required: true, controlType: "text" },
      { key: "title", label: t("MODEL_TITLE"), help: t("MODEL_TITLE_HELP"), controlType: "text" },
      ...(role === "calc" ? [
        { key: "minRows", label: t("MODEL_MIN_ROWS"), help: t("MODEL_MIN_ROWS_HELP"), controlType: "count" },
        { key: "maxRows", label: t("MODEL_MAX_ROWS"), help: t("MODEL_MAX_ROWS_HELP"), controlType: "count" },
      ] : [
        // How the configuration's price is divided between the rows — not a field of the grid.
        { key: "basisExpr", label: t("MODEL_COST_BASIS"), help: t("MODEL_COST_BASIS_HELP"), required: true, controlType: "rowExpr" },
      ]),
    ],
  },
  { id: "fields", label: t("MODEL_FIELDS") },
];

/** The table spliced into the model and checked — so a cell formula reading another of the table's
 *  own aggregates resolves before the table is committed. `at` is its index there. */
export function checkTable(draft: ModelDef, tables: TableCols[], tb: TableDef) {
  const scope = modelWithTable(draft, tb);
  const at = (scope.tables ?? []).findIndex((x) => x.key === tb.key);
  const mine = checkModel(scope, tables).filter((x) => x.path.startsWith(`tables[${at}]`));
  return { scope, at, mine };
}

/** A grid cell's problems, `<row>:<column>` as EditGrid keys them: a column's key, its formula or
 *  source (the `value` cell), its SAP field (`map`). */
export function columnErrors(tb: TableDef, mine: ReturnType<typeof checkTable>["mine"], at: number, t: Translate) {
  const out: Record<string, string> = {};
  tb.columns.forEach((c, j) => {
    const k = keyProblem(c.key, t);
    if (k) out[`${j}:key`] = k;
  });
  for (const issue of mine) {
    const sub = issue.path.slice(`tables[${at}]`.length);
    const col = /^\.columns\[(\d+)\](\.key)?$/.exec(sub);
    if (col) out[`${col[1]}:key`] ??= issue.message;
    const cell = /^\.columns\[(\d+)\]\.cell$/.exec(sub);
    if (cell) out[`${cell[1]}:value`] ??= issueText(issue, String((tb.columns[Number(cell[1])]?.cell as { expr?: string }).expr ?? ""), t);
    const map = /^\.map\.(\w+)$/.exec(sub);
    const j = map ? tb.columns.findIndex((c) => c.key === map[1]) : -1;
    if (map && j >= 0) out[`${j}:map`] ??= issue.message;
  }
  return out;
}

/** The table page's `validate`. The grid is a template, so its problems are listed under Fields
 *  (the grid paints its own cells from `columnErrors`). A mapping to a column the grid no longer has
 *  is not here: nothing on this page could fix it, so it stays the model's message. */
export function tableIssues(r: Row, draft: ModelDef, tables: TableCols[], openedAs: string, t: Translate): RecordIssues {
  const tb = r as TableDef;
  const fields: Record<string, string> = {};
  const other: RecordMessage[] = [];
  const { at, mine } = checkTable(draft, tables, tb);
  // An issue on the table as a whole (its key colliding with a parameter, say) belongs to its key.
  const keyed = keyProblem(tb.key, t)
    ?? ((draft.tables ?? []).some((x) => x.key === tb.key && x.key !== openedAs) ? t("MODEL_TABLE_KEY_TAKEN", tb.key) : undefined)
    ?? mine.find((x) => x.path === `tables[${at}]`)?.message;
  if (keyed) fields.key = keyed;
  const basis = mine.find((x) => x.path === `tables[${at}].basisExpr`);
  if (basis) fields.basisExpr = issueText(basis, String((tb as { basisExpr?: string }).basisExpr ?? ""), t);
  if (!tb.columns.length) other.push({ id: "empty", text: t("MODEL_FIELDS_EMPTY"), section: "fields" });
  for (const [cell, text] of Object.entries(columnErrors(tb, mine, at, t))) {
    const [j = "0", col = ""] = cell.split(":");
    other.push({ id: cell, text, detail: `${tb.columns[Number(j)]?.key || `#${Number(j) + 1}`} · ${col}`, section: "fields", anchor: '[data-field="columns"]' });
  }
  return { fields, other };
}

/** The table written back over the one the page opened; a rename follows into placement, or the
 *  group points at a table that is gone. */
export function commitTable(d: ModelDef, openedAs: string, tb: TableDef): ModelDef {
  return {
    ...d,
    tables: (d.tables ?? []).map((x) => (x.key === openedAs ? tb : x)),
    structure: openedAs === tb.key ? d.structure : {
      sections: d.structure.sections.map((sec) => ({
        ...sec,
        groups: sec.groups.map((g) => (isTableGroup(g) && g.table === openedAs ? { table: tb.key } : g)),
      })),
    },
  };
}

/** A new calculation table. The role is not a choice: a model has exactly one items table, seeded
 *  by starterModel and undeletable, and every table added in the builder is a calc table. */
export function newCalcTable(taken: string[], t: Translate): TableDef {
  let n = taken.length + 1;
  while (taken.includes(`table${n}`)) n++;
  return {
    key: `table${n}`,
    title: copy(t, "MODEL_DEFAULT_TABLE", "Table"),
    role: "calc",
    columns: [{ key: "value", label: copy(t, "MODEL_COL_VALUE", "Value"), type: "number", cell: { kind: "input" } }],
  };
}

/** A new column for the Fields grid. */
export const newColumn = (taken: string[], label: string): TableColumn => {
  let n = taken.length + 1;
  while (taken.includes(`col${n}`)) n++;
  return { key: `col${n}`, label, type: "number", cell: { kind: "input" } };
};
