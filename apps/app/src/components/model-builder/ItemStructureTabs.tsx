import { useMemo } from "react";
import { Button, Input } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { Grid, GridForm } from "@confire/ui/list-report/Grid.tsx";
import type { ListColumn } from "@confire/ui/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { DeleteRows, useEditGrid } from "./useEditGrid.tsx";
import { useI18n } from "../../i18n.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type Props = { draft: ModelDef; update: Update; issues: Issue[]; tables?: TableCols[] };

const ITEM = { dialogConfig: cfl.items() };

const newId = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// A line's id is not shown any more: it is an internal key (error messages name it), not something
// a modeller names. The visible counter is the row's position, so deleting a row renumbers the
// column without touching the id.

// An item code is still an expression — the value help just writes the common case, a quoted
// literal. `asCode` reads that case back out so the picker can show what was picked; anything
// else (a ternary, a parameter) has no single code and is shown as the expression it is.
const LITERAL = /^\s*"([^"\\]*)"\s*$/;
const asCode = (expr: string): string | undefined => LITERAL.exec(expr)?.[1];

// Each table in a Form of its own (GridForm): the Form titles it, the Grid toolbar repeats the
// name with its row count.
export function ItemStructureTab({ draft, update, issues, tables }: Props) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const bomColumns = useMemo<ListColumn[]>(() => [
    { key: "n", label: "#", width: 48 },
    { key: "itemCode", label: t("MODEL_ITEM"), width: 240 },
    { key: "desc", label: t("MODEL_DESC") },
    { key: "condition", label: t("MODEL_CONDITION") },
    { key: "qty", label: t("MODEL_QTY_PER"), width: 144 },
  ], [i18n]);
  const routingColumns = useMemo<ListColumn[]>(() => [
    { key: "n", label: "#", width: 48 },
    { key: "resource", label: t("MODEL_RESOURCE") },
    { key: "desc", label: t("MODEL_DESC") },
    { key: "condition", label: t("MODEL_CONDITION") },
    { key: "setupMin", label: t("MODEL_SETUP") },
    { key: "runMinPerUnit", label: t("MODEL_RUN") },
    { key: "ratePerHour", label: t("MODEL_RATE") },
  ], [i18n]);
  const setBom = (i: number, patch: Partial<ModelDef["bom"][number]>) =>
    update((d) => ({ ...d, bom: d.bom.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const bomCell = (i: number, field: "condition" | "qty", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.bom[i]![field]} model={draft} extraVars={["qty"]} tables={tables}
      placeholder={placeholder} fieldId={`expr-bom[${i}].${field}`} issue={issueFor(issues, `bom[${i}].${field}`)}
      onChange={(v) => setBom(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["bom"][number]>)} />
  );

  const setOp = (i: number, patch: Partial<ModelDef["routing"][number]>) =>
    update((d) => ({ ...d, routing: d.routing.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const opCell = (i: number, field: "condition" | "setupMin" | "runMinPerUnit" | "ratePerHour", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.routing[i]![field]} model={draft} extraVars={["qty"]} tables={tables}
      placeholder={placeholder} fieldId={`expr-routing[${i}].${field}`} issue={issueFor(issues, `routing[${i}].${field}`)}
      onChange={(v) => setOp(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["routing"][number]>)} />
  );

  const bom = useEditGrid(draft.bom, bomColumns, {
    n: (_, i) => i + 1,
    itemCode: (l, i) => (
      // Picking fills the description too, and both stay editable afterwards.
      <CflField config={ITEM} accessibleName={t("MODEL_ITEM")}
        value={asCode(l.itemCode) ?? (l.itemCode.trim() || null)}
        error={l.itemCode.trim() ? null : t("MODEL_ITEM_ERR")}
        onValueChange={(v) => setBom(i, { itemCode: v === null || v === "" ? "" : JSON.stringify(String(v)) })}
        onRowSelect={(row) => { if (row.ItemName != null) setBom(i, { desc: String(row.ItemName) }); }} />
    ),
    // Plain text, not an expression: the item's name as B1 spells it, editable.
    desc: (l, i) => (
      <Input style={{ width: "100%" }} value={l.desc ?? ""} placeholder={t("MODEL_DESC_FROM_ITEM")}
        onInput={(e) => setBom(i, { desc: e.target.value || undefined })} />
    ),
    condition: (_, i) => bomCell(i, "condition", true, t("MODEL_COND_EMPTY")),
    qty: (_, i) => bomCell(i, "qty"),
  });

  const routing = useEditGrid(draft.routing, routingColumns, {
    n: (_, i) => i + 1,
    resource: (o, i) => (
      <Input style={{ width: "100%" }} value={o.resource} placeholder={t("MODEL_RESOURCE_PH")}
        onInput={(e) => setOp(i, { resource: e.target.value })} />
    ),
    // Plain text, like the BOM's: what the salesperson reads next to the operation.
    desc: (o, i) => (
      <Input style={{ width: "100%" }} value={o.desc ?? ""} placeholder={t("MODEL_OP_DESC_PH")}
        onInput={(e) => setOp(i, { desc: e.target.value || undefined })} />
    ),
    condition: (_, i) => opCell(i, "condition", true, t("MODEL_OP_COND_EMPTY")),
    setupMin: (_, i) => opCell(i, "setupMin"),
    runMinPerUnit: (_, i) => opCell(i, "runMinPerUnit"),
    ratePerHour: (_, i) => opCell(i, "ratePerHour"),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <GridForm headerText={t("MODEL_BOM")}>
        <Grid {...bom} title={t("MODEL_BOM")} fill={false} selectionMode="Multiple"
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => update((d) => ({
                  ...d,
                  bom: [...d.bom, { id: newId("line", d.bom.map((l) => l.id)), itemCode: '""', qty: "1" }],
                }))}>
                {t("MODEL_ADD_LINE")}
              </Button>
              <DeleteRows sel={sel} onDelete={(gone) => update((d) => ({ ...d, bom: d.bom.filter((_, j) => !gone.has(j)) }))} />
            </>
          )} />
      </GridForm>
      <GridForm headerText={t("MODEL_ROUTING")}>
        <Grid {...routing} title={t("MODEL_ROUTING")} fill={false} selectionMode="Multiple"
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => update((d) => ({
                  ...d,
                  routing: [...d.routing, { id: newId("op", d.routing.map((o) => o.id)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }],
                }))}>
                {t("MODEL_ADD_OP")}
              </Button>
              <DeleteRows sel={sel} onDelete={(gone) => update((d) => ({ ...d, routing: d.routing.filter((_, j) => !gone.has(j)) }))} />
            </>
          )} />
      </GridForm>
    </div>
  );
}
