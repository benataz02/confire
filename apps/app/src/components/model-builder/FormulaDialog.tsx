import { useMemo, useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label } from "@ui5/webcomponents-react";
import { checkModel, type ModelDef } from "@confire/config-engine";
import { useI18n } from "../../i18n.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { W } from "./ParamForm.tsx";

type Formula = ModelDef["computed"][number];

/** A formula's key and expression. Buffer-and-commit like TitleDialog: a new one (no `at`) exists
 *  only once saved. Checked as it will be once saved, so a Save that would break the model waits. */
export function FormulaDialog({ draft, tables, at, initial, onCancel, onOk }: {
  draft: ModelDef;
  tables: TableCols[];
  /** its index in `draft.computed`; absent while new */
  at?: number;
  initial: Formula;
  onCancel: () => void;
  onOk: (f: Formula) => void;
}) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const [f, setF] = useState(initial);
  const i = at ?? draft.computed.length;
  // The model with this formula in its place: what the suggestions offer and the check reads.
  const scope = useMemo(
    () => ({ ...draft, computed: [...draft.computed.slice(0, i), f, ...draft.computed.slice(i + 1)] }),
    [draft, f, i],
  );
  const exprIssue = useMemo(() => checkModel(scope, tables).find((x) => x.path === `computed[${i}].expr`), [scope, tables, i]);
  const taken = [
    ...draft.parameters.map((p) => p.key), ...(draft.tables ?? []).map((tb) => tb.key),
    ...draft.computed.filter((_, j) => j !== at).map((c) => c.key),
  ];
  const keyIssue = !f.key ? t("MODEL_KEY_EMPTY")
    : !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(f.key) ? t("MODEL_KEY_CHARS")
    : taken.includes(f.key) ? t("MODEL_KEY_IN_USE")
    : undefined;
  const ok = !keyIssue && !!f.expr.trim() && !exprIssue;
  const save = () => { if (ok) onOk(f); };

  return (
    <Dialog open onClose={onCancel} className="confire-pd" headerText={t("MODEL_FORMULA")}
      style={{ width: "min(40rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!ok} onClick={save}>{t("MODEL_SAVE")}</Button>
            <Button design="Transparent" onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }
    >
      {/* One column, not FORM_LAYOUT: the dialog is M-sized, which would set the key beside the
          expression and leave the expression half the width it needs. */}
      <Form layout="S1 M1 L1 XL1" style={{ padding: "1rem" }}>
        <FormGroup accessibleName={t("MODEL_FORMULA")}>
          <FormItem labelContent={<Label showColon required>{t("MODEL_KEY")}</Label>}>
            <Input value={f.key} style={W} autoFocus accessibleName={t("MODEL_FORMULA_KEY")}
              valueState={keyIssue ? "Negative" : "None"}
              valueStateMessage={<div>{keyIssue}</div>}
              onInput={(e) => { const key = e.target.value; setF((x) => ({ ...x, key })); }}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          </FormItem>
          <FormItem labelContent={<Label showColon required>{t("MODEL_FORMULA_EXPR")}</Label>}>
            {/* An empty box is not an error yet: Save waits for it either way. */}
            <ExprInput value={f.expr} model={scope} tables={tables} rows={3}
              issue={f.expr.trim() ? exprIssue : undefined}
              onChange={(v) => setF((x) => ({ ...x, expr: v ?? "" }))} />
          </FormItem>
        </FormGroup>
      </Form>
    </Dialog>
  );
}
