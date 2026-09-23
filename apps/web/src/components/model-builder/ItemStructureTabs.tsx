import {
  Button, IllustratedMessage, Input, ObjectPageSubSection,
  Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, TableRowAction,
} from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import type { Issue, ModelDef } from "@confire/config-engine";
import { EntityValueHelp } from "../ValueHelp.tsx";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

type Update = (fn: (d: ModelDef) => ModelDef) => void;
type Props = { draft: ModelDef; update: Update; issues: Issue[]; tables?: TableCols[] };

const titled = (label: string, n: number) => (n ? `${label} (${n})` : label);

// ObjectPageSubSection lays its children out flush with the section title; these tables read
// better inset, like the forms on the other sections.
const PAD = { padding: "0 1rem 1rem" } as const;

const newId = (prefix: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
};

// A line's id is not shown any more: it is the key overrides are stored under, not something a
// modeller names. The visible counter is the row's position, so deleting a row renumbers the
// column without touching an id an override may already point at.
const counter = (i: number) => <span>{i + 1}</span>;

// An item code is still an expression — the value help just writes the common case, a quoted
// literal. `asCode` reads that case back out so the picker can show what was picked; anything
// else (a ternary, a parameter) has no single code and is shown as the expression it is.
const LITERAL = /^\s*"([^"\\]*)"\s*$/;
const asCode = (expr: string): string | undefined => LITERAL.exec(expr)?.[1];

// A hook, not a component: ObjectPage builds the anchor bar's sub-tabs by scanning
// section.props.children for ObjectPageSubSection *elements*, so a component in between hides
// them. ModelBuilderPage calls this and drops the result straight into its ObjectPageSection.
export function useItemStructureTab({ draft, update, issues, tables }: Props) {
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

  return [
    <ObjectPageSubSection key="bom" id="bom" titleText={titled("BOM", draft.bom.length)}
      actions={
        <Button icon="add" design="Transparent"
          onClick={() => update((d) => ({
            ...d,
            bom: [...d.bom, { id: newId("line", d.bom.map((l) => l.id)), itemCode: '""', qty: "1" }],
          }))}>
          Add line
        </Button>
      }>
      <div style={PAD}>
        <Table accessibleName="150% bill of materials" overflowMode="Popin" rowActionCount={1}
          noData={<IllustratedMessage name="NoData" design="Dot" titleText="No BOM lines"
            subtitleText="Pick the item; its unit price is read from the model's price list on every calculation. Quantity is an expression with parameters and qty (batch size) in scope, and condition decides whether the line applies." />}
          onRowActionClick={(e) => {
            const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
            update((d) => ({ ...d, bom: d.bom.filter((_, j) => j !== i) }));
          }}
          headerRow={
            <TableHeaderRow>
              {/* Description and Condition carry no `width`, which is what makes them absorb
                  everything the fixed ones leave — UI5 splits the slack evenly among the unset
                  columns, so these two share it. `minWidth` only counts on an unset column;
                  on a fixed one it is ignored. */}
              <TableHeaderCell width="3rem">#</TableHeaderCell>
              <TableHeaderCell width="15rem">Item</TableHeaderCell>
              <TableHeaderCell minWidth="14rem">Description</TableHeaderCell>
              <TableHeaderCell minWidth="12rem">Condition</TableHeaderCell>
              <TableHeaderCell width="9rem">Qty per unit</TableHeaderCell>
            </TableHeaderRow>
          }>
          {draft.bom.map((l, i) => (
            <TableRow key={i} rowKey={`bom-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
              <TableCell>{counter(i)}</TableCell>
              <TableCell>
                {/* Picking fills the description too, and both stay editable afterwards. */}
                <EntityValueHelp entitySet="Items" keyField="ItemCode" select={["ItemCode", "ItemName"]}
                  showValue headerText="Select an item"
                  value={asCode(l.itemCode) ?? (l.itemCode.trim() || undefined)}
                  valueState={l.itemCode.trim() ? "None" : "Negative"}
                  valueStateMessage="Pick the item this line consumes — its unit price comes from the model's price list."
                  onChange={(v, row) => setBom(i, {
                    itemCode: v == null ? '' : JSON.stringify(String(v)),
                    ...(row?.[1] == null ? {} : { desc: String(row[1]) }),
                  })} />
              </TableCell>
              <TableCell>
                {/* Plain text, not an expression: the item's name as B1 spells it, editable. */}
                <Input value={l.desc ?? ""} placeholder="from the picked item"
                  onInput={(e) => setBom(i, { desc: e.target.value || undefined })} />
              </TableCell>
              <TableCell>{bomCell(i, "condition", true, "always applies when empty")}</TableCell>
              <TableCell>{bomCell(i, "qty")}</TableCell>
            </TableRow>
          ))}
        </Table>
      </div>
    </ObjectPageSubSection>,

    <ObjectPageSubSection key="routing" id="routing" titleText={titled("Routing", draft.routing.length)}
      actions={
        <Button icon="add" design="Transparent"
          onClick={() => update((d) => ({
            ...d,
            routing: [...d.routing, { id: newId("op", d.routing.map((o) => o.id)), resource: "", setupMin: "0", runMinPerUnit: "0", ratePerHour: "60" }],
          }))}>
          Add operation
        </Button>
      }>
      <div style={PAD}>
        <Table accessibleName="150% routing" overflowMode="Popin" rowActionCount={1}
          noData={<IllustratedMessage name="NoData" design="Dot" titleText="No operations"
            subtitleText="Times are minutes, rate is cost per hour; all are expressions with qty in scope. Setup is amortized over the batch by the engine." />}
          onRowActionClick={(e) => {
            const i = Number(((e.detail.row as unknown) as HTMLElement).dataset.idx);
            update((d) => ({ ...d, routing: d.routing.filter((_, j) => j !== i) }));
          }}
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell width="3rem" minWidth="3rem">#</TableHeaderCell>
              <TableHeaderCell>Resource</TableHeaderCell>
              <TableHeaderCell>Condition</TableHeaderCell>
              <TableHeaderCell>Setup (min)</TableHeaderCell>
              <TableHeaderCell>Run / unit (min)</TableHeaderCell>
              <TableHeaderCell>Rate / hour</TableHeaderCell>
            </TableHeaderRow>
          }>
          {draft.routing.map((o, i) => (
            <TableRow key={i} rowKey={`op-${i}`} data-idx={String(i)} actions={<TableRowAction icon="delete" text="Delete" />}>
              <TableCell>{counter(i)}</TableCell>
              <TableCell><Input value={o.resource} placeholder="e.g. SAW-01" onInput={(e) => setOp(i, { resource: e.target.value })} /></TableCell>
              <TableCell>{opCell(i, "condition", true, "always runs when empty")}</TableCell>
              <TableCell>{opCell(i, "setupMin")}</TableCell>
              <TableCell>{opCell(i, "runMinPerUnit")}</TableCell>
              <TableCell>{opCell(i, "ratePerHour")}</TableCell>
            </TableRow>
          ))}
        </Table>
      </div>
    </ObjectPageSubSection>,
  ];
}
