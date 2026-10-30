import { useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import { W } from "./ParamForm.tsx";

// The form pads its own content column, so the dialog part's default padding is off.
if (typeof document !== "undefined") {
  let el = document.getElementById("confire-pd-style");
  if (!el) { el = document.createElement("style"); el.id = "confire-pd-style"; document.head.appendChild(el); }
  el.textContent = `.confire-pd::part(content){padding:0;}`;
}

/** A section's or group's heading. Buffer-and-commit like the parameter page. */
export function TitleDialog({ initial, section, onCancel, onOk }: {
  initial: string;
  /** a section's heading, else a group's — only the dialog's own title differs */
  section: boolean;
  onCancel: () => void;
  onOk: (title: string) => void;
}) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const [v, setV] = useState(initial);
  const heading = section ? t("MODEL_SECTION") : t("MODEL_GROUP");
  return (
    <Dialog open onClose={onCancel} className="confire-pd" headerText={heading}
      style={{ width: "min(28rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" onClick={() => onOk(v)}>{t("MODEL_SAVE")}</Button>
            <Button onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }
    >
      <Form labelSpan="S12 M12 L12 XL12" style={{ padding: "1rem" }}>
        <FormGroup accessibleName={heading}>
          <FormItem labelContent={<Label>{t("MODEL_TITLE")}</Label>}>
            <Input value={v} style={W} autoFocus
              onInput={(e) => setV(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onOk(v); }} />
          </FormItem>
        </FormGroup>
      </Form>
    </Dialog>
  );
}
