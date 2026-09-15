import {
  Button, Form, FormGroup, IllustratedMessage, Input, ObjectPageSubSection, StepInput,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { Issue, ModelDef } from "@confire/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type Props = { draft: ModelDef; update: Update; issues: Issue[]; tables?: TableCols[] };

const TABLE_FORM = { accessibleMode: "Edit", layout: "S1 M1 L1 XL1", headerLevel: "H5" } as const;
const titled = (label: string, n: number) => (n ? `${label} (${n})` : label);

const newId = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// 150% BOM: every line is an expression over params (+ qty); condition filters per configuration.
export function BomTab({ draft, update, issues, tables }: Props) {
  const set = (i: number, patch: Partial<ModelDef["bom"][number]>) =>
    update((d) => ({ ...d, bom: d.bom.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const cell = (i: number, field: "itemCode" | "desc" | "condition" | "qty" | "price", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.bom[i]![field]} model={draft} extraVars={["qty"]} tables={tables}
      placeholder={placeholder} fieldId={`expr-bom[${i}].${field}`} issue={issueFor(issues, `bom[${i}].${field}`)}
      onChange={(v) => set(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["bom"][number]>)} />
  );

  return (
    <ObjectPageSubSection id="bom-lines" titleText={titled("150% bill of materials", draft.bom.length)}
      actions={
        <Button icon="add" design="Transparent"
          onClick={() => update((d) => ({
            ...d,
            bom: [...d.bom, { id: newId("line", d.bom.map((l) => l.id)), itemCode: '""', qty: "1", price: "0", scrapPct: 0 }],
          }))}>
          Add line
        </Button>
      }>
      <Form {...TABLE_FORM}>
        <FormGroup accessibleName="150% bill of materials">
          <Table accessibleName="150% bill of materials" overflowMode="Popin" rowActionCount={1}
            noData={<IllustratedMessage name="NoData" design="Dot" titleText="No BOM lines"
              subtitleText="Item, quantity and price are expressions; parameters and qty (batch size) are in scope. Condition decides whether the line applies." />}
            onRowActionClick={(e) => {
              const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
              update((d) => ({ ...d, bom: d.bom.filter((_, j) => j !== i) }));
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell width="6rem" minWidth="6rem">Id</TableHeaderCell>
                <TableHeaderCell minWidth="11rem">Item code</TableHeaderCell>
                <TableHeaderCell minWidth="11rem">Description</TableHeaderCell>
                <TableHeaderCell minWidth="11rem">Condition</TableHeaderCell>
                <TableHeaderCell minWidth="9rem">Qty per unit</TableHeaderCell>
                <TableHeaderCell minWidth="9rem">Unit price</TableHeaderCell>
                <TableHeaderCell width="7rem" minWidth="7rem">Scrap %</TableHeaderCell>
              </TableHeaderRow>
            }>
            {draft.bom.map((l, i) => (
              <TableRow key={i} rowKey={`bom-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
                <TableCell><Input value={l.id} onInput={(e) => set(i, { id: e.target.value })} /></TableCell>
                <TableCell>{cell(i, "itemCode", false, '"CBL-STL" or a ternary')}</TableCell>
                <TableCell>{cell(i, "desc", true)}</TableCell>
                <TableCell>{cell(i, "condition", true, "always applies when empty")}</TableCell>
                <TableCell>{cell(i, "qty")}</TableCell>
                <TableCell>{cell(i, "price", false, "number or LOOKUP(...)")}</TableCell>
                <TableCell><StepInput value={l.scrapPct} min={0} step={0.5} onChange={(e) => set(i, { scrapPct: e.target.value ?? 0 })} /></TableCell>
              </TableRow>
            ))}
          </Table>
        </FormGroup>
      </Form>
    </ObjectPageSubSection>
  );
}

export function RoutingTab({ draft, update, issues, tables }: Props) {
  const set = (i: number, patch: Partial<ModelDef["routing"][number]>) =>
    update((d) => ({ ...d, routing: d.routing.map((o, j) => (j === i ? { ...o, ...patch } : o)) }));
  const cell = (i: number, field: "condition" | "setupMin" | "runMinPerUnit" | "ratePerHour", optional = false, placeholder?: string) => (
    <ExprInput optional={optional} value={draft.routing[i]![field]} model={draft} extraVars={["qty"]} tables={tables}
      placeholder={placeholder} fieldId={`expr-routing[${i}].${field}`} issue={issueFor(issues, `routing[${i}].${field}`)}
      onChange={(v) => set(i, { [field]: optional ? v : (v ?? "") } as Partial<ModelDef["routing"][number]>)} />
  );

  return (
    <ObjectPageSubSection id="routing-ops" titleText={titled("150% routing", draft.routing.length)}
      actions={
        <Button icon="add" design="Transparent"
          onClick={() => update((d) => ({
            ...d,
            routing: [...d.routing, { id: newId("op", d.routing.map((o) => o.id)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }],
          }))}>
          Add operation
        </Button>
      }>
      <Form {...TABLE_FORM}>
        <FormGroup accessibleName="150% routing">
          <Table accessibleName="150% routing" overflowMode="Popin" rowActionCount={1}
            noData={<IllustratedMessage name="NoData" design="Dot" titleText="No operations"
              subtitleText="Times are minutes, rate is cost per hour; all are expressions with qty in scope. Setup is amortized over the batch by the engine." />}
            onRowActionClick={(e) => {
              const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
              update((d) => ({ ...d, routing: d.routing.filter((_, j) => j !== i) }));
            }}
            headerRow={
              <TableHeaderRow>
                <TableHeaderCell width="6rem" minWidth="6rem">Id</TableHeaderCell>
                <TableHeaderCell minWidth="10rem">Resource</TableHeaderCell>
                <TableHeaderCell minWidth="11rem">Condition</TableHeaderCell>
                <TableHeaderCell minWidth="9rem">Setup (min)</TableHeaderCell>
                <TableHeaderCell minWidth="9rem">Run / unit (min)</TableHeaderCell>
                <TableHeaderCell minWidth="9rem">Rate / hour</TableHeaderCell>
              </TableHeaderRow>
            }>
            {draft.routing.map((o, i) => (
              <TableRow key={i} rowKey={`op-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
                <TableCell><Input value={o.id} onInput={(e) => set(i, { id: e.target.value })} /></TableCell>
                <TableCell><Input value={o.resource} placeholder="e.g. SAW-01" onInput={(e) => set(i, { resource: e.target.value })} /></TableCell>
                <TableCell>{cell(i, "condition", true, "always runs when empty")}</TableCell>
                <TableCell>{cell(i, "setupMin")}</TableCell>
                <TableCell>{cell(i, "runMinPerUnit")}</TableCell>
                <TableCell>{cell(i, "ratePerHour")}</TableCell>
              </TableRow>
            ))}
          </Table>
        </FormGroup>
      </Form>
    </ObjectPageSubSection>
  );
}
