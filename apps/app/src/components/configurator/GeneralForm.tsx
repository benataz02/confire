import { Form, FormGroup, FormItem, Input, Label, MultiInput, Option, Panel, Select, Text, Token } from "@ui5/webcomponents-react";
import { addBatch } from "@confire/ui/configurator/formHelpers.ts";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { useI18n } from "../../i18n.ts";

/** The customer value help: customers only, with a link to the BP for whoever may open /b1. */
const CUSTOMER = { dialogConfig: cfl.customers() };

/** The batch field's message anchor — the server's `batches_required` key. `__`: data-param shares
 *  its namespace with parameter keys. */
const BATCHES = "__batches";

type Customer = { cardCode: string; cardName: string } | null;

// The configuration's own attributes. No draft state: each control commits on change (UI5 fires
// that on blur/Enter), and `required` + a negative valueState on the empty case is the Fiori way to
// say the same thing the message popover does — once there is a model, so an untouched new form is
// not an error yet. Display mode is Text, matching ConfiguratorForm — accessibleMode only announces
// it. A Panel like each ConfiguratorForm section, the Form inside it only laying out the fields.
export function GeneralForm({ locked, request, isNew, head, batches, modelName, models, saving, modelLocked, onSave, onModel, onBatches }: {
  locked: boolean;
  /** a client's request: its model was the client's pick, and its customer is the company */
  request: boolean;
  /** /configs/new: no batch field yet — a new configuration takes its model's defaults */
  isNew: boolean;
  head: { name: string; modelId: string; customer: Customer };
  batches: number[];
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
  return (
    <Panel accessibleRole="Form" headerText={t("CONFIG_GENERAL")} headerLevel="H5">
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
          {locked || request ? (
            <Text>{modelName}</Text>
          ) : (
          /* Switching the model wipes every entry, batch and table row, because a param key
              only means something inside its own model. Rather than warn about that, the
              field simply stops being editable once there is anything to lose. */
          <Select value={head.modelId} style={{ width: "100%" }}
            disabled={saving || modelLocked}
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
          {locked || request ? <Text>{head.customer?.cardName ?? ""}</Text> : (
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
        {isNew ? null : (
          <FormItem labelContent={<Label required>{t("CONFIG_BATCHES")}</Label>}>
            {locked ? <Text>{batches.join(", ")}</Text> : (
            /* Type a quantity, Enter (or leaving the field) makes it a token. Uncontrolled: the
               typed text is cleared by hand once it has become one. */
            <MultiInput type="Number" data-param={BATCHES} style={{ width: "100%" }}
              placeholder={t("CONFIG_BATCHES_PLACEHOLDER")} accessibleName={t("CONFIG_BATCHES")}
              valueState={batches.length ? "None" : "Negative"}
              valueStateMessage={<div>{t("CONFIG_BATCHES_HINT")}</div>}
              tokens={batches.map((b) => <Token key={b} text={String(b)} />)}
              onChange={(e) => {
                const next = addBatch(batches, e.target.value ?? "");
                if (next !== batches) onBatches(next);
                e.target.value = "";
              }}
              onTokenDelete={(e) => {
                const gone = new Set(e.detail.tokens.map((tk) => Number((tk as HTMLElement).getAttribute("text"))));
                const left = batches.filter((b) => !gone.has(b));
                // Deleting the last quantity falls back to 1 rather than leaving nothing to price.
                onBatches(left.length ? left : [1]);
              }} />
            )}
          </FormItem>
        )}
      </FormGroup>
    </Form>
    </Panel>
  );
}
