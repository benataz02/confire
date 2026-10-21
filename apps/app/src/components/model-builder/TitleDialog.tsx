import { useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label, Option, Select } from "@ui5/webcomponents-react";
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
  const [v, setV] = useState(initial);
  return (
    <Dialog open onClose={onCancel} className="confire-pd" headerText={withIcon ? "Section" : "Group"}
      style={{ width: "min(28rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" onClick={() => onOk(v)}>Save</Button>
            <Button onClick={onCancel}>Cancel</Button>
          </>
        } />
      }
    >
      <Form labelSpan="S12 M12 L12 XL12" style={{ padding: "1rem" }}>
        <FormGroup accessibleName={withIcon ? "Section" : "Group"}>
          <FormItem labelContent={<Label>Title</Label>}>
            <Input value={v.title} style={W} autoFocus
              onInput={(e) => setV((x) => ({ ...x, title: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") onOk(v); }} />
          </FormItem>
          {withIcon ? (
            <FormItem labelContent={<Label>Icon</Label>}>
              <Select value={v.icon ?? NONE} style={W}
                onChange={(e) => { const i = optValue(e); setV((x) => ({ ...x, icon: i === NONE ? undefined : i })); }}>
                <Option value={NONE}>None</Option>
                {ICONS.map((i) => <Option key={i} value={i} icon={i}>{i}</Option>)}
              </Select>
            </FormItem>
          ) : null}
        </FormGroup>
      </Form>
    </Dialog>
  );
}
