import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Form, FormGroup, FormItem, Input, Label, MessageStrip, Option, Select, Switch, Text } from "@ui5/webcomponents-react";
import type { Issue, ModelDef } from "@confire/config-engine";
import { CflField } from "@confire/ui/cfl/CflField.tsx";
import { cfl } from "@confire/ui/cfl/cfl-configs.ts";
import { ExprInput } from "./ExprInput.tsx";
import type { TableCols } from "./exprHelpers.ts";
import { issueFor } from "./useDraftModel.ts";
import { MasterdataQuerySelect } from "./MasterdataQuerySelect.tsx";
import { orpc } from "../../orpc.ts";
import { toast } from "@confire/ui/toast.ts";

/** Label mode: the price list's name shows, its number is what the model stores. */
const PRICE_LIST = { dialogConfig: cfl.priceLists() };
const ITEM = { dialogConfig: cfl.items() };

export function SettingsTab({ modelId, draft, update, issues, tables, tried }: {
  /** absent until the model is saved — publishing needs a row to publish */
  modelId?: string;
  draft: ModelDef;
  update: (fn: (d: ModelDef) => ModelDef) => void;
  issues: Issue[];
  tables?: TableCols[];
  /** Save was pressed. Until then this tab stays quiet: a new model is empty by definition, and
   *  five red fields on an untouched form say nothing the asterisks don't. */
  tried: boolean;
}) {
  // Batches edited as CSV; parse on change, ignore junk. // ponytail: token editor if CSV annoys
  const [batchText, setBatchText] = useState(draft.batchDefaults.join(", "));
  const setBatches = (text: string) => {
    setBatchText(text);
    const nums = text.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
    update((d) => ({ ...d, batchDefaults: nums }));
  };

  // Every error state on this tab goes through these two, so "only after Save" is one rule in one
  // place rather than a `tried &&` scattered over eight fields.
  const bad = (empty: boolean) => (tried && empty ? "Negative" : "None") as "Negative" | "None";
  const shown = (path: string) => (tried ? issueFor(issues, path) : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem", padding: "1rem" }}>
      <Form accessibleMode="Edit" labelSpan="S12 M12 L12 XL12" layout="S1 M2 L2 XL2">
        <FormGroup headerText="Model">
          <FormItem labelContent={<Label for="model-name" required>Name</Label>}>
            <Input id="model-name" value={draft.name} required
              valueState={bad(!draft.name.trim())}
              valueStateMessage={<div>Give the model a name — it is what the salesperson picks from the catalog.</div>}
              onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label for="model-description">Description</Label>}>
            <Input id="model-description" value={draft.description ?? ""} placeholder="Shown under the model name"
              onInput={(e) => update((d) => ({ ...d, description: e.target.value || undefined }))} />
          </FormItem>
          <FormItem labelContent={<Label>Default batch sizes</Label>}>
            <Input value={batchText} placeholder="1, 10, 100" onInput={(e) => setBatches(e.target.value)}
              valueState={bad(!draft.batchDefaults.length)}
              valueStateMessage={<div>Comma-separated whole numbers above zero, e.g. 1, 10, 100 — these are the batch sizes the configurator prices side by side.</div>} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText="Pricing">
          {/* Mandatory: BOM lines carry no price of their own — this list is where every material's
              unit price is read from, live, on each calculation. */}
          <FormItem labelContent={<Label required>BOM price list</Label>}>
            {/* Wrapper, not a prop on the field: the id is only a jump target for the message
                popover, and `field-<issue path>` is the convention for one. */}
            <div id="field-pricing.priceList" style={{ width: "100%" }}>
            <CflField config={PRICE_LIST} value={draft.pricing.priceList ?? null} accessibleName="BOM price list"
              error={bad(!draft.pricing.priceList) === "Negative"
                ? "Pick the B1 price list every BOM material's unit price is read from. Without it the model cannot cost anything."
                : null}
              onValueChange={(v) => update((d) => ({
                ...d,
                pricing: { ...d.pricing, priceList: v === null || v === "" ? undefined : Number(v) },
              }))} />
            </div>
          </FormItem>
          {/* Where those prices are cached. An `Items` masterdata query with no columns selected,
              so B1 returns whole rows and the nested ItemPrices collection survives the sync —
              a $select on it is rejected. */}
          <FormItem labelContent={<Label required>Item price source</Label>}>
            <div id="field-pricing.itemTable" style={{ width: "100%" }}>
              <MasterdataQuerySelect required accessibleName="Item masterdata query"
                value={draft.pricing.itemTable}
                issue={shown("pricing.itemTable")?.message}
                onChange={(itemTable) => update((d) => ({ ...d, pricing: { ...d.pricing, itemTable } }))} />
            </div>
          </FormItem>
          <FormItem labelContent={<Label required>Unit price expression</Label>}>
            <ExprInput value={draft.pricing.priceExpr} model={draft} extraVars={["qty", "unitCost"]} tables={tables}
              fieldId="expr-pricing.priceExpr" issue={shown("pricing.priceExpr")}
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, priceExpr: v ?? "" } }))} />
          </FormItem>
          <FormItem labelContent={<Label required>Quote item code</Label>}>
            <CflField config={ITEM} value={draft.pricing.quoteItemCode || null} accessibleName="Quote item code" link
              error={bad(!draft.pricing.quoteItemCode) === "Negative"
                ? "Pick the B1 item the quote line is written against — the configured product itself, not a material."
                : null}
              onValueChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, quoteItemCode: v === null ? "" : String(v) } }))} />
          </FormItem>
        </FormGroup>
      </Form>

      <PortalSettings modelId={modelId} />

      <MessageStrip design="Information" hideCloseButton>
        The tables behind LOOKUP() and table domains — maintained values and live B1/Beas queries alike — are managed on the Masterdata page and shared by every model.
      </MessageStrip>
    </div>
  );
}

const PRICING_TEXT = {
  indicative: "Indicative prices while configuring",
  request: "Prices on request (none until quoted)",
} as const;

/** The customer portal (spec D15, D21). Applied as it is changed, not on Save: these are columns
 *  beside the definition, so publishing never touches the model's calculations. */
function PortalSettings({ modelId }: { modelId?: string }) {
  const qc = useQueryClient();
  const rec = useQuery({ ...orpc.models.get.queryOptions({ input: { id: modelId! } }), enabled: !!modelId });
  const publish = useMutation(orpc.models.publish.mutationOptions({
    onSuccess: (row) => {
      qc.setQueryData(orpc.models.get.queryOptions({ input: { id: row.id } }).queryKey, row);
      toast(row.portal ? "Published on the customer portal" : "Not on the customer portal");
    },
  }));
  const portal = rec.data?.portal ?? false;
  const pricing = rec.data?.portalPricing ?? "request";
  const set = (patch: Partial<{ portal: boolean; portalPricing: "indicative" | "request" }>) =>
    publish.mutate({ id: modelId!, portal, portalPricing: pricing, ...patch });
  const off = !modelId || !rec.data || publish.isPending;

  return (
    <Form accessibleMode="Edit" labelSpan="S12 M12 L12 XL12" layout="S1 M2 L2 XL2">
      <FormGroup headerText="Customer portal">
        <FormItem labelContent={<Label for="model-portal">Publish on the portal</Label>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <Switch id="model-portal" checked={portal} disabled={off} accessibleName="Publish on the portal"
              onChange={(e) => set({ portal: e.target.checked })} />
            <Text style={{ fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" }}>
              {modelId
                ? "Every customer company on the portal can configure it. Applies at once, without Save."
                : "Save the model first."}
            </Text>
          </div>
        </FormItem>
        <FormItem labelContent={<Label for="model-portal-pricing">Prices shown to clients</Label>}>
          <Select id="model-portal-pricing" value={pricing} disabled={off} style={{ width: "100%" }}
            onChange={(e) => set({ portalPricing: (e.detail.selectedOption.value ?? "request") as "indicative" | "request" })}>
            {Object.entries(PRICING_TEXT).map(([v, t]) => <Option key={v} value={v}>{t}</Option>)}
          </Select>
        </FormItem>
      </FormGroup>
      {publish.error ? (
        <FormGroup>
          <FormItem><MessageStrip design="Negative" hideCloseButton>{publish.error.message}</MessageStrip></FormItem>
        </FormGroup>
      ) : null}
    </Form>
  );
}
