import { Button, Input } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { CflField } from "../../shared/cfl/CflField.tsx";
import { cfl } from "../../shared/cfl/cfl-configs.ts";
import { Grid } from "../../shared/list-report/Grid.tsx";
import type { ListColumn } from "../../shared/types.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { GridForm, positions, useEditGrid } from "./useEditGrid.tsx";

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
const BOM_COLUMNS: ListColumn[] = [
  { key: "n", label: "#", width: 48 },
  { key: "itemCode", label: "Item", width: 240 },
  { key: "desc", label: "Description" },
  { key: "condition", label: "Condition" },
  { key: "qty", label: "Qty per unit", width: 144 },
];
const ROUTING_COLUMNS: ListColumn[] = [
  { key: "n", label: "#", width: 48 },
  { key: "resource", label: "Resource" },
  { key: "desc", label: "Description" },
  { key: "condition", label: "Condition" },
  { key: "setupMin", label: "Setup (min)" },
  { key: "runMinPerUnit", label: "Run / unit (min)" },
  { key: "ratePerHour", label: "Rate / hour" },
];

// An item code is still an expression — the value help just writes the common case, a quoted
// literal. `asCode` reads that case back out so the picker can show what was picked; anything
// else (a ternary, a parameter) has no single code and is shown as the expression it is.
const LITERAL = /^\s*"([^"\\]*)"\s*$/;
const asCode = (expr: string): string | undefined => LITERAL.exec(expr)?.[1];

// Each table in a Form of its own (GridForm); the Grid toolbar names it, with its row count.
export function ItemStructureTab({ draft, update, issues, tables }: Props) {
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

  const bom = useEditGrid(draft.bom, BOM_COLUMNS, {
    n: (_, i) => i + 1,
    itemCode: (l, i) => (
      // Picking fills the description too, and both stay editable afterwards.
      <CflField config={ITEM} accessibleName="Item"
        value={asCode(l.itemCode) ?? (l.itemCode.trim() || null)}
        error={l.itemCode.trim() ? null : "Pick the item this line consumes — its unit price comes from the model's price list."}
        onValueChange={(v) => setBom(i, { itemCode: v === null || v === "" ? "" : JSON.stringify(String(v)) })}
        onRowSelect={(row) => { if (row.ItemName != null) setBom(i, { desc: String(row.ItemName) }); }} />
    ),
    // Plain text, not an expression: the item's name as B1 spells it, editable.
    desc: (l, i) => (
      <Input style={{ width: "100%" }} value={l.desc ?? ""} placeholder="from the picked item"
        onInput={(e) => setBom(i, { desc: e.target.value || undefined })} />
    ),
    condition: (_, i) => bomCell(i, "condition", true, "always applies when empty"),
    qty: (_, i) => bomCell(i, "qty"),
  });

  const routing = useEditGrid(draft.routing, ROUTING_COLUMNS, {
    n: (_, i) => i + 1,
    resource: (o, i) => (
      <Input style={{ width: "100%" }} value={o.resource} placeholder="e.g. SAW-01"
        onInput={(e) => setOp(i, { resource: e.target.value })} />
    ),
    // Plain text, like the BOM's: what the salesperson reads next to the operation.
    desc: (o, i) => (
      <Input style={{ width: "100%" }} value={o.desc ?? ""} placeholder="what this operation does"
        onInput={(e) => setOp(i, { desc: e.target.value || undefined })} />
    ),
    condition: (_, i) => opCell(i, "condition", true, "always runs when empty"),
    setupMin: (_, i) => opCell(i, "setupMin"),
    runMinPerUnit: (_, i) => opCell(i, "runMinPerUnit"),
    ratePerHour: (_, i) => opCell(i, "ratePerHour"),
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <GridForm name="BOM">
        <Grid {...bom} title="BOM" fill={false} selectionMode="Multiple"
          noDataText="No BOM lines. Pick the item; its unit price is read from the model's price list on every calculation."
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => update((d) => ({
                  ...d,
                  bom: [...d.bom, { id: newId("line", d.bom.map((l) => l.id)), itemCode: '""', qty: "1" }],
                }))}>
                Add line
              </Button>
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={() => {
                  const gone = positions(sel.rows);
                  sel.clear();
                  update((d) => ({ ...d, bom: d.bom.filter((_, j) => !gone.has(j)) }));
                }}>
                Delete
              </Button>
            </>
          )} />
      </GridForm>
      <GridForm name="Routing">
        <Grid {...routing} title="Routing" fill={false} selectionMode="Multiple"
          noDataText="No operations. Times are minutes, rate is cost per hour; setup is amortized over the batch."
          toolbarActions={(sel) => (
            <>
              <Button icon="add" design="Transparent"
                onClick={() => update((d) => ({
                  ...d,
                  routing: [...d.routing, { id: newId("op", d.routing.map((o) => o.id)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }],
                }))}>
                Add operation
              </Button>
              <Button icon="delete" design="Transparent" disabled={!sel.rows.length}
                onClick={() => {
                  const gone = positions(sel.rows);
                  sel.clear();
                  update((d) => ({ ...d, routing: d.routing.filter((_, j) => !gone.has(j)) }));
                }}>
                Delete
              </Button>
            </>
          )} />
      </GridForm>
    </div>
  );
}
