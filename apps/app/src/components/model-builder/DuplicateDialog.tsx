import { useState } from "react";
import { Bar, Button, Dialog, Form, FormGroup, FormItem, Input, Label, Text } from "@ui5/webcomponents-react";
import type { ModelDef } from "@confire/config-engine";
import { FORM_LAYOUT } from "@confire/ui/formLayout.ts";
import { useI18n } from "../../i18n.ts";
import { W } from "./ParamForm.tsx";
import { copyKeyIssues, type CopyKey } from "./structureOps.ts";

const KIND = {
  section: "MODEL_SECTION", group: "MODEL_GROUP", param: "MODEL_PARAM", table: "MODEL_CALC_TABLE", formula: "MODEL_FORMULA",
} as const;

/** The keys a duplicate creates, each proposed unique and open to change before the copy is made.
 *  Titles and labels are copied as they are; only a key has to differ. */
export function DuplicateDialog({ draft, keys: initial, onCancel, onOk }: {
  draft: ModelDef;
  keys: CopyKey[];
  onCancel: () => void;
  onOk: (keys: CopyKey[]) => void;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const [keys, setKeys] = useState(initial);
  const issues = copyKeyIssues(draft, keys);
  const ok = Object.keys(issues).length === 0;
  return (
    <Dialog open onClose={onCancel} className="confire-pd" headerText={t("MODEL_DUPLICATE")}
      style={{ width: "min(32rem, 96vw)" }}
      footer={
        <Bar design="Footer" endContent={
          <>
            <Button design="Emphasized" disabled={!ok} onClick={() => onOk(keys)}>{t("MODEL_DUPLICATE")}</Button>
            <Button design="Transparent" onClick={onCancel}>{t("MODEL_CANCEL")}</Button>
          </>
        } />
      }
    >
      <Form layout={FORM_LAYOUT} style={{ padding: "1rem" }}>
        <FormGroup accessibleName={t("MODEL_DUPLICATE")}>
          <FormItem><Text>{t("MODEL_DUPLICATE_KEYS")}</Text></FormItem>
          {keys.map((k, i) => (
            <FormItem key={k.id} labelContent={<Label showColon required>{`${t(KIND[k.kind])} ${k.from}`}</Label>}>
              <Input value={k.key} style={W} autoFocus={i === 0}
                accessibleName={`${t(KIND[k.kind])} ${k.from}`}
                valueState={issues[k.id] ? "Negative" : "None"}
                valueStateMessage={issues[k.id] ? (
                  <div>{t(issues[k.id] === "invalid" ? "MODEL_KEY_CHARS" : "MODEL_KEY_IN_USE")}</div>
                ) : undefined}
                onInput={(e) => { const v = e.target.value; setKeys((ks) => ks.map((x) => (x.id === k.id ? { ...x, key: v } : x))); }}
                onKeyDown={(e) => { if (e.key === "Enter" && ok) onOk(keys); }} />
            </FormItem>
          ))}
        </FormGroup>
      </Form>
    </Dialog>
  );
}
