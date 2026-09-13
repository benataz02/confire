import { useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@hera/config-engine";
import { ExprInput } from "./ExprInput.tsx";
import { PAIRS, W, lbl } from "./ParamDialog.tsx";
import type { TableCols } from "./exprHelpers.ts";

export type Computed = ModelDef["computed"][number];

// Buffer-and-commit, like ParamDialog and TableDialog: a half-renamed key never runs through the
// draft's checkModel. `under` is carried through untouched — it is the structure tree's anchor,
// not something the author sets here.
export function FormulaDialog({ draft, tables, initial, issue, onCancel, onOk }: {
  draft: ModelDef;
  tables: TableCols[];
  initial: Computed;
  issue?: Issue;
  onCancel: () => void;
  onOk: (c: Computed) => void;
}) {
  const [c, setC] = useState<Computed>(initial);
  const keyOk = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(c.key);
  const keyTaken =
    draft.parameters.some((p) => p.key === c.key) ||
    draft.computed.some((x) => x.key === c.key && x.key !== initial.key);

  return (
    <Dialog open onClose={onCancel} className="hera-pd" headerText="Formula"
      accessibleName={`Edit formula ${initial.key}`} style={{ width: "min(48rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!keyOk || keyTaken} onClick={() => onOk(c)}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }
    >
      <Form {...PAIRS} style={{ padding: "1rem" }}>
        <FormGroup accessibleName="Formula">
          <FormItem labelContent={lbl("Key", "The name other expressions use to read this value. It shares one namespace with the parameter keys.", true)}>
            <Input value={c.key} style={W} valueState={keyOk && !keyTaken ? "None" : "Negative"}
              valueStateMessage={<div>{keyTaken ? "Another parameter or formula already uses this key." : "Must be a valid identifier."}</div>}
              onInput={(e) => setC((x) => ({ ...x, key: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={lbl("Expression", "Evaluated on every change. It can read any parameter, any other formula, and each table's aggregates.")}>
            <ExprInput value={c.expr} model={draft} tables={tables} issue={issue} style={W}
              onChange={(v) => setC((x) => ({ ...x, expr: v ?? "" }))} />
          </FormItem>
        </FormGroup>
      </Form>
    </Dialog>
  );
}
