import type { ReactNode } from "react";
import { Form, FormGroup, FormItem, Input, Label, Option, Select, Text } from "@ui5/webcomponents-react";
import { BatchField } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { EntityLink } from "@confire/ui/EntityLink.tsx";
import { useI18n } from "../../i18n.ts";
import { useIsAdmin } from "../../orpc.ts";

/** The customer value help: customers only, with a link to the BP for whoever may open /b1. */
const CUSTOMER = { dialogConfig: cfl.customers() };

type Customer = { cardCode: string; cardName: string } | null;

/** Beside an input, the value needs the input's box (see `.confire-form-value`). In a fully
 *  read-only form every value is text, and the extra box would drop this one below the others. */
function fieldText(besideInput: boolean, node: ReactNode) {
  return besideInput ? <div className="confire-form-value">{node}</div> : node;
}

// The configuration's own attributes. No draft state: each control commits on change (UI5 fires
// that on blur/Enter), and `required` + a negative valueState on the empty case is the Fiori way to
// say the same thing the message popover does — once there is a model, so an untouched new form is
// not an error yet. Display mode is text, or a link when the value names a record the user may
// open — the object page's read-only field. accessibleMode only announces it. The page's General
// ObjectPageSection titles it, as each ConfiguratorForm section titles its own.
export function GeneralForm({ locked, request, head, batches, modelName, models, saving, modelLocked, onSave, onModel, onBatches }: {
  locked: boolean;
  /** a client's request: its model was the client's pick, and its customer is the company */
  request: boolean;
  head: { name: string; modelId: string; customer: Customer };
  /** absent on /configs/new: a new configuration takes its model's defaults */
  batches?: number[];
  modelName?: string;
  models: { id: string; name: string }[];
  saving: boolean;
  /** anything a model switch would throw away is entered: the field stops being editable */
  modelLocked: boolean;
  onSave: (patch: { name?: string; customer?: Customer }) => void;
  onModel: (modelId: string) => void;
  onBatches: (batches: number[]) => void;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  // The model builder is admin-only. The link is hidden for everyone else; adminProcedure is
  // the boundary, same as the side nav.
  const isAdmin = useIsAdmin();
  const modelReadOnly = locked || request || modelLocked;
  const modelLabel = modelName || models.find((m) => m.id === head.modelId)?.name || "";
  const modelValue = isAdmin && head.modelId && modelLabel
    ? <EntityLink route="/models" target={head.modelId}>{modelLabel}</EntityLink>
    : <Text>{modelLabel}</Text>;
  return (
    <Form accessibleName={t("CONFIG_GENERAL")} labelSpan="S12 M12 L12 XL12" layout="S1 M2 L4 XL4"
      accessibleMode={locked ? "Display" : "Edit"} itemSpacing={locked ? "Large" : "Normal"}>
      <FormGroup>
        <FormItem labelContent={<Label for={locked ? undefined : "cfg-name"} required>{t("CONFIG_NAME")}</Label>}>
          {locked ? <Text>{head.name}</Text> : (
          <Input id="cfg-name" value={head.name} style={{ width: "100%" }}
            disabled={saving}
            valueState={head.name.trim() || !head.modelId ? "None" : "Negative"}
            valueStateMessage={<div>{t("CONFIG_NAME_HINT")}</div>}
            onChange={(e) => {
              const v = (e.target.value ?? "").trim();
              if (v && v !== head.name) onSave({ name: v });
            }} />
          )}
        </FormItem>
        <FormItem labelContent={<Label required>{t("CONFIG_MODEL")}</Label>}>
          {modelReadOnly ? (
            /* Switching the model wipes every entry, batch and table row, because a param key
               only means something inside its own model. Once there is anything to lose the
               field is read-only text, and a link for whoever may open the model. */
            fieldText(!locked, modelValue)
          ) : (
          <Select value={head.modelId} style={{ width: "100%" }}
            disabled={saving}
            onChange={(e) => {
              const v = e.detail.selectedOption.value ?? "";
              if (v && v !== head.modelId) onModel(v);
            }}>
            {/* A new configuration starts with none: picking one is the decision, not a default. */}
            {head.modelId ? null : <Option value="" />}
            {models.map((m) => (
              <Option key={m.id} value={m.id}>{m.name}</Option>
            ))}
          </Select>
          )}
        </FormItem>
        <FormItem labelContent={<Label required>{t("CONFIG_CUSTOMER")}</Label>}>
          {locked || request ? fieldText(!locked, <Text>{head.customer?.cardName ?? ""}</Text>) : (
          /* Wrapper, not a prop: the id is only a jump target for the message popover. */
          <div id="cfg-customer" style={{ width: "100%" }}>
          {/* Only a customer SAP knows is saved: the row select — a pick, or a typed code the
              existence check found — writes the pair. A keystroke writes nothing; clearing
              the field clears the customer. */}
          <CflField config={CUSTOMER} value={head.customer?.cardCode ?? null} link
            disabled={saving}
            error={head.customer?.cardCode || !head.modelId ? null : t("CONFIG_CUSTOMER_ERROR")}
            onValueChange={(v) => {
              if ((v === null || v === "") && head.customer) onSave({ customer: null });
            }}
            onRowSelect={(row) => onSave({
              customer: { cardCode: String(row.CardCode ?? ""), cardName: String(row.CardName ?? "") },
            })} />
          </div>
          )}
        </FormItem>
        {batches ? <BatchField batches={batches} onChange={locked ? undefined : onBatches} /> : null}
      </FormGroup>
    </Form>
  );
}
