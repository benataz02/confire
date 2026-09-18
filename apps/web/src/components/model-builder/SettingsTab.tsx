import { useState } from "react";
import { Form, FormGroup, FormItem, Input, Label, MessageStrip, Switch } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { EntityValueHelp } from "../ValueHelp.tsx";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";

export function SettingsTab({ draft, update, issues, tables, portalMeta, setPortalMeta }: {
  draft: ModelDef;
  update: (fn: (d: ModelDef) => ModelDef) => void;
  issues: Issue[];
  tables?: TableCols[];
  portalMeta: { portal: boolean; portalDescription: string };
  setPortalMeta: (p: { portal: boolean; portalDescription: string }) => void;
}) {
  // Batches edited as CSV; parse on change, ignore junk. // ponytail: token editor if CSV annoys
  const [batchText, setBatchText] = useState(draft.batchDefaults.join(", "));
  const setBatches = (text: string) => {
    setBatchText(text);
    const nums = text.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    update((d) => ({ ...d, batchDefaults: nums }));
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <Form accessibleMode="Edit" labelSpan="S12 M12 L12 XL12" layout="S1 M1 L2 XL2">
        <FormGroup headerText="Model">
          <FormItem labelContent={<Label for="model-name" required>Name</Label>}>
            <Input id="model-name" value={draft.name} required
              valueState={draft.name.trim() ? "None" : "Negative"}
              valueStateMessage={<div>Enter a name</div>}
              onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label for="model-description">Description</Label>}>
            <Input id="model-description" value={draft.description ?? ""} placeholder="Shown under the model name"
              onInput={(e) => update((d) => ({ ...d, description: e.target.value || undefined }))} />
          </FormItem>
          <FormItem labelContent={<Label>Default batch sizes</Label>}>
            <Input value={batchText} placeholder="1, 10, 100" onInput={(e) => setBatches(e.target.value)}
              valueState={draft.batchDefaults.length ? "None" : "Negative"}
              valueStateMessage={<div>At least one positive integer batch size</div>} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Pricing">
          {/* Mandatory: BOM lines carry no price of their own — this list is where every material's
              unit price is read from, live, on each calculation. */}
          <FormItem labelContent={<Label required>BOM price list</Label>}>
            {/* Wrapper, not a prop on EntityValueHelp: the id is only a jump target for the
                message popover, and `field-<issue path>` is the convention for one. */}
            <div id="field-pricing.priceList" style={{ width: "100%" }}>
            <EntityValueHelp entitySet="PriceLists" keyField="PriceListNo" select={["PriceListNo", "PriceListName"]}
              value={draft.pricing.priceList ?? undefined}
              valueState={draft.pricing.priceList ? "None" : "Negative"}
              headerText="Select a price list"
              onChange={(v) => update((d) => ({
                ...d,
                pricing: { ...d.pricing, priceList: v == null || v === "" ? undefined : Number(v) },
              }))} />
            </div>
          </FormItem>
          <FormItem labelContent={<Label required>Unit price expression</Label>}>
            <ExprInput value={draft.pricing.priceExpr} model={draft} extraVars={["qty", "unitCost"]} tables={tables}
              fieldId="expr-pricing.priceExpr" issue={issueFor(issues, "pricing.priceExpr")}
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, priceExpr: v ?? "" } }))} />
          </FormItem>
          <FormItem labelContent={<Label required>Quote item code</Label>}>
            <EntityValueHelp entitySet="Items" keyField="ItemCode" select={["ItemCode", "ItemName"]}
              value={draft.pricing.quoteItemCode || undefined}
              valueState={draft.pricing.quoteItemCode ? "None" : "Negative"}
              headerText="Select an item"
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, quoteItemCode: v == null ? "" : String(v) } }))} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Client portal">
          <FormItem labelContent={<Label>Available in portal</Label>}>
            <Switch checked={portalMeta.portal}
              onChange={(e) => setPortalMeta({ ...portalMeta, portal: e.target.checked })} />
          </FormItem>
          <FormItem labelContent={<Label>Portal description</Label>}>
            <Input value={portalMeta.portalDescription} placeholder="Shown on the client's catalog card"
              onInput={(e) => setPortalMeta({ ...portalMeta, portalDescription: e.target.value })} />
          </FormItem>
        </FormGroup>
      </Form>

      <MessageStrip design="Information" hideCloseButton>
        The tables behind LOOKUP() and table domains — maintained values and live B1/Beas queries alike — are managed on the Masterdata page and shared by every model.
      </MessageStrip>
    </div>
  );
}
