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
import { useI18n } from "../../i18n.ts";
import { toast } from "@confire/ui/toast.ts";
import type { Translate } from "./builderMessages.ts";

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
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
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
        <FormGroup headerText={t("MODEL_GROUP_MODEL")}>
          <FormItem labelContent={<Label for="model-name" required>{t("MODEL_NAME")}</Label>}>
            <Input id="model-name" value={draft.name} required
              valueState={bad(!draft.name.trim())}
              valueStateMessage={<div>{t("MODEL_NAME_HINT")}</div>}
              onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
          </FormItem>
          <FormItem labelContent={<Label for="model-description">{t("MODEL_DESCRIPTION")}</Label>}>
            <Input id="model-description" value={draft.description ?? ""} placeholder={t("MODEL_DESCRIPTION_PH")}
              onInput={(e) => update((d) => ({ ...d, description: e.target.value || undefined }))} />
          </FormItem>
          <FormItem labelContent={<Label>{t("MODEL_BATCHES")}</Label>}>
            <Input value={batchText} placeholder={t("MODEL_BATCHES_PH")} onInput={(e) => setBatches(e.target.value)}
              valueState={bad(!draft.batchDefaults.length)}
              valueStateMessage={<div>{t("MODEL_BATCHES_HINT")}</div>} />
          </FormItem>
        </FormGroup>
        <FormGroup headerText={t("MODEL_PRICING")}>
          {/* Mandatory: BOM lines carry no price of their own — this list is where every material's
              unit price is read from, live, on each calculation. */}
          <FormItem labelContent={<Label required>{t("MODEL_PRICE_LIST")}</Label>}>
            {/* Wrapper, not a prop on the field: the id is only a jump target for the message
                popover, and `field-<issue path>` is the convention for one. */}
            <div id="field-pricing.priceList" style={{ width: "100%" }}>
            <CflField config={PRICE_LIST} value={draft.pricing.priceList ?? null} accessibleName={t("MODEL_PRICE_LIST")}
              error={bad(!draft.pricing.priceList) === "Negative" ? t("MODEL_PRICE_LIST_ERR") : null}
              onValueChange={(v) => update((d) => ({
                ...d,
                pricing: { ...d.pricing, priceList: v === null || v === "" ? undefined : Number(v) },
              }))} />
            </div>
          </FormItem>
          {/* Where those prices are cached. An `Items` masterdata query with no columns selected,
              so B1 returns whole rows and the nested ItemPrices collection survives the sync —
              a $select on it is rejected. */}
          <FormItem labelContent={<Label required>{t("MODEL_ITEM_SOURCE")}</Label>}>
            <div id="field-pricing.itemTable" style={{ width: "100%" }}>
              <MasterdataQuerySelect required accessibleName={t("MODEL_ITEM_QUERY")}
                value={draft.pricing.itemTable}
                issue={shown("pricing.itemTable")?.message}
                onChange={(itemTable) => update((d) => ({ ...d, pricing: { ...d.pricing, itemTable } }))} />
            </div>
          </FormItem>
          <FormItem labelContent={<Label required>{t("MODEL_PRICE_EXPR")}</Label>}>
            <ExprInput value={draft.pricing.priceExpr} model={draft} extraVars={["qty", "unitCost"]} tables={tables}
              fieldId="expr-pricing.priceExpr" issue={shown("pricing.priceExpr")}
              onChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, priceExpr: v ?? "" } }))} />
          </FormItem>
          <FormItem labelContent={<Label required>{t("MODEL_QUOTE_ITEM")}</Label>}>
            <CflField config={ITEM} value={draft.pricing.quoteItemCode || null} accessibleName={t("MODEL_QUOTE_ITEM")} link
              error={bad(!draft.pricing.quoteItemCode) === "Negative" ? t("MODEL_QUOTE_ITEM_ERR") : null}
              onValueChange={(v) => update((d) => ({ ...d, pricing: { ...d.pricing, quoteItemCode: v === null ? "" : String(v) } }))} />
          </FormItem>
        </FormGroup>
      </Form>

      <PortalSettings modelId={modelId} />

      <MessageStrip design="Information" hideCloseButton>
        {t("MODEL_MASTERDATA_NOTE")}
      </MessageStrip>
    </div>
  );
}

const PRICING_TEXT = {
  indicative: "MODEL_PRICING_INDICATIVE",
  request: "MODEL_PRICING_REQUEST",
} as const;

/** The customer portal (spec D15, D21). Applied as it is changed, not on Save: these are columns
 *  beside the definition, so publishing never touches the model's calculations. */
function PortalSettings({ modelId }: { modelId?: string }) {
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const qc = useQueryClient();
  const rec = useQuery({ ...orpc.models.get.queryOptions({ input: { id: modelId! } }), enabled: !!modelId });
  const publish = useMutation(orpc.models.publish.mutationOptions({
    onSuccess: (row) => {
      qc.setQueryData(orpc.models.get.queryOptions({ input: { id: row.id } }).queryKey, row);
      toast(row.portal ? t("MODEL_TOAST_PUBLISHED") : t("MODEL_TOAST_UNPUBLISHED"));
    },
  }));
  const portal = rec.data?.portal ?? false;
  const pricing = rec.data?.portalPricing ?? "request";
  const set = (patch: Partial<{ portal: boolean; portalPricing: "indicative" | "request" }>) =>
    publish.mutate({ id: modelId!, portal, portalPricing: pricing, ...patch });
  const off = !modelId || !rec.data || publish.isPending;

  return (
    <Form accessibleMode="Edit" labelSpan="S12 M12 L12 XL12" layout="S1 M2 L2 XL2">
      <FormGroup headerText={t("MODEL_PORTAL")}>
        <FormItem labelContent={<Label for="model-portal">{t("MODEL_PORTAL_PUBLISH")}</Label>}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <Switch id="model-portal" checked={portal} disabled={off} accessibleName={t("MODEL_PORTAL_PUBLISH")}
              onChange={(e) => set({ portal: e.target.checked })} />
            <Text style={{ fontSize: "0.75rem", color: "var(--sapContent_LabelColor)" }}>
              {modelId ? t("MODEL_PORTAL_HINT") : t("MODEL_PORTAL_SAVE_FIRST")}
            </Text>
          </div>
        </FormItem>
        <FormItem labelContent={<Label for="model-portal-pricing">{t("MODEL_PORTAL_PRICES")}</Label>}>
          <Select id="model-portal-pricing" value={pricing} disabled={off} style={{ width: "100%" }}
            onChange={(e) => set({ portalPricing: (e.detail.selectedOption.value ?? "request") as "indicative" | "request" })}>
            {Object.entries(PRICING_TEXT).map(([v, key]) => <Option key={v} value={v}>{t(key)}</Option>)}
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
