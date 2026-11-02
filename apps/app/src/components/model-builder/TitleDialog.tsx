import { useMemo, useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label } from "@ui5/webcomponents-react";
import { checkModel, type ModelDef } from "@confire/config-engine";
import { useI18n } from "../../i18n.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { setHeading, type Heading } from "./structureOps.ts";
import { W } from "./ParamForm.tsx";

// The form pads its own content column, so the dialog part's default padding is off.
if (typeof document !== "undefined") {
  let el = document.getElementById("confire-pd-style");
  if (!el) { el = document.createElement("style"); el.id = "confire-pd-style"; document.head.appendChild(el); }
  el.textContent = `.confire-pd::part(content){padding:0;}`;
}

/** A section's or group's heading and visibility rule. Buffer-and-commit like the parameter page,
 *  and checked as it will be once saved, like FormulaDialog. */
export function TitleDialog({ draft, tables, at, initial, onCancel, onOk }: {
  draft: ModelDef;
  tables: TableCols[];
  /** the section, or its group `g`; a section past the last is one not added yet */
  at: { s: number; g?: number };
  initial: Heading;
  onCancel: () => void;
  onOk: (h: Heading) => void;
}) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const [h, setH] = useState(initial);
  const heading = at.g === undefined ? t("MODEL_SECTION") : t("MODEL_GROUP");
  const path = at.g === undefined
    ? `structure.sections[${at.s}].visibleWhen`
    : `structure.sections[${at.s}].groups[${at.g}].visibleWhen`;
  // The model with this heading in its place: what the suggestions offer and the check reads.
  const scope = useMemo(() => {
    const sections = draft.structure.sections;
    const base = at.s < sections.length ? draft
      : { ...draft, structure: { sections: [...sections, { key: "section", title: "", groups: [] }] } };
    return setHeading(base, at, h);
  }, [draft, at, h]);
  const issue = useMemo(() => checkModel(scope, tables).find((x) => x.path === path), [scope, tables, path]);
  const save = () => { if (!issue) onOk(h); };

  return (
    <Dialog open onClose={onCancel} className="confire-pd" headerText={heading}
      style={{ width: "min(40rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!!issue} onClick={save}>{t("MODEL_SAVE")}</Button>
            <Button onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }
    >
      {/* One column, as in FormulaDialog: the rule needs the dialog's whole width. */}
      <Form layout="S1 M1 L1 XL1" style={{ padding: "1rem" }}>
        <FormGroup accessibleName={heading}>
          <FormItem labelContent={<Label showColon>{t("MODEL_TITLE")}</Label>}>
            <Input value={h.title} style={W} autoFocus
              onInput={(e) => { const title = e.target.value; setH((x) => ({ ...x, title })); }}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
          </FormItem>
          <FormItem labelContent={<Label showColon>{t("MODEL_VISIBLE_WHEN")}</Label>}>
            <ExprInput value={h.visibleWhen} model={scope} tables={tables} rows={3} optional
              placeholder={t("MODEL_VISIBLE_PH")} issue={issue}
              onChange={(visibleWhen) => setH((x) => ({ ...x, visibleWhen }))} />
          </FormItem>
        </FormGroup>
      </Form>
    </Dialog>
  );
}
