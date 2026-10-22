import { useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label, Option, Select } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import { NONE, W, optValue } from "./ParamDialog.tsx";

// ponytail: curated icons, so a Select can show each one and there is no name to mistype. Swap in a
// free-text name with a live preview if authors need icons beyond these.
const ICONS = [
  "product", "factory", "machine", "wrench", "technical-object", "measure", "dimension", "resize",
  "palette", "color-fill", "temperature", "chain-link", "puzzle", "settings", "inspection",
  "shipping-status", "supplier", "customer", "money-bills", "document",
];

export type TitleIcon = { title: string; icon?: string };

/** A section's or group's heading. Buffer-and-commit like ParamDialog; only a section has an icon,
 *  because only a section's Form header draws one. */
export function TitleDialog({ initial, withIcon, onCancel, onOk }: {
  initial: TitleIcon;
  withIcon: boolean;
  onCancel: () => void;
  onOk: (v: TitleIcon) => void;
}) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const [v, setV] = useState(initial);
  const heading = withIcon ? t("MODEL_SECTION") : t("MODEL_GROUP");
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
            <Input value={v.title} style={W} autoFocus
              onInput={(e) => setV((x) => ({ ...x, title: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") onOk(v); }} />
          </FormItem>
          {withIcon ? (
            <FormItem labelContent={<Label>{t("MODEL_ICON")}</Label>}>
              <Select value={v.icon ?? NONE} style={W}
                onChange={(e) => { const i = optValue(e); setV((x) => ({ ...x, icon: i === NONE ? undefined : i })); }}>
                <Option value={NONE}>{t("MODEL_ICON_NONE")}</Option>
                {ICONS.map((i) => <Option key={i} value={i} icon={i}>{i}</Option>)}
              </Select>
            </FormItem>
          ) : null}
        </FormGroup>
      </Form>
    </Dialog>
  );
}
