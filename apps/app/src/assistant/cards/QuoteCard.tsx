import { useNavigate } from "@tanstack/react-router";
import { Button, Text } from "@ui5/webcomponents-react";
import { money } from "@confire/ui/money.ts";
import { useI18n } from "../../i18n.ts";
import { useCurrency } from "../../orpc.ts";
import { TableCard } from "./kit.tsx";

// The quotation the picks would post (tool `propose_quotation`, i.e. `configs.quoteDraft`): its lines
// and total, and the way to the quote page — where the header is completed and the user posts, as
// from the page's own footer. Nothing in the panel posts (spec §4.6).

type Line = { ItemCode?: string; ItemDescription?: string; Quantity?: number; UnitPrice?: number };
export type QuoteDraft = { data: { DocumentLines?: Line[]; DocCurrency?: string }; totals: { value: number }; name: string };

export function QuoteCard({ projectId, d }: { projectId: string; d: QuoteDraft }) {
  const i18n = useI18n();
  const t = (k: string, ...a: string[]) => i18n.getText(k, ...a);
  const navigate = useNavigate({ from: "/$slug" });
  const tenant = useCurrency();
  const currency = d.data.DocCurrency ?? tenant;
  const lines = d.data.DocumentLines ?? [];
  return (
    <TableCard title={t("ASSISTANT_QUOTE")} subtitle={d.name}
      columns={[
        { key: "item", label: t("ASSISTANT_ITEM") }, { key: "qty", label: t("ASSISTANT_QUANTITY"), end: true },
        { key: "unit", label: t("ASSISTANT_UNIT_PRICE"), end: true }, { key: "total", label: t("ASSISTANT_LINE_TOTAL"), end: true },
      ]}
      rows={lines.map((l, i) => ({
        id: String(i),
        cells: {
          item: l.ItemDescription || l.ItemCode || "—", qty: String(l.Quantity ?? ""),
          unit: money(l.UnitPrice ?? 0, currency), total: money((l.UnitPrice ?? 0) * (l.Quantity ?? 0), currency),
        },
      }))}
      footer={
        <>
          <Text style={{ flex: 1, alignSelf: "center", fontWeight: "bold" }}>{t("ASSISTANT_QUOTE_TOTAL", money(d.totals.value, currency))}</Text>
          <Button design="Emphasized" onClick={() => void navigate({ to: "/$slug/configs/$id/quote", params: { id: projectId } })}>
            {t("ASSISTANT_CARD_REVIEW")}
          </Button>
        </>
      } />
  );
}
