import { ObjectStatus, Text, Title } from "@ui5/webcomponents-react";
import { ITEM_COL, type Val } from "@confire/config-engine";
import type { CostElement } from "@confire/config-engine";
import { money } from "@confire/ui/money.ts";
import type { CostLine, ItemMoney } from "@confire/ui/money.ts";
import { useI18n } from "../../i18n.ts";
import { margin } from "./runView.ts";
import { percent } from "../dashboard/dashboardView.ts";

// The insights rail's cost blocks. The rail itself is ConfigProcessPage's DynamicSideContent side
// content; these are what its "Cost elements" panel draws.

const SECTION = { display: "flex", flexDirection: "column", gap: "0.25rem" } as const;
/** tabular-nums inherits through UI5's shadow roots, so the decimals line up down the column. */
const LINE = { display: "flex", justifyContent: "space-between", gap: "1rem", fontVariantNumeric: "tabular-nums" } as const;
const RULE = {
  borderBlockStart: "1px solid var(--sapList_BorderColor)",
  paddingBlockStart: "0.25rem", marginBlockStart: "0.25rem",
} as const;

/** The only line this rail draws: a label and an amount, `total` being the same in heavier type
 *  above a rule. */
function MoneyRow({ label, amount, cur, total }: { label: string; amount: number; cur?: string; total?: boolean }) {
  const cell = (t: string) => (total ? <Title level="H6">{t}</Title> : <Text>{t}</Text>);
  return (
    <div style={{ ...LINE, ...(total ? RULE : null) }}>
      {cell(label)}
      {cell(money(amount, cur))}
    </div>
  );
}

/** What the cost is made of, what it sells for, and where it lands — with one total, not one per
 *  block. Materials and Operations are batch totals from the same computeOutputs call the items
 *  split divides, so they add up to Total cost; Cost by item is that same total on the other axis,
 *  in line totals because a cost element is an amount (the grid shows the same money per unit). */
export function CostBody({ rows, money: m, totals, cur }: {
  rows: Record<string, Val>[];
  money: ItemMoney;
  totals: { cost: number; price: number };
  cur?: string;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const group = (kind: CostLine["kind"], title: string) => {
    const ls = m.lines.filter((l) => l.kind === kind);
    return ls.length ? (
      <div style={SECTION}>
        <Title level="H6">{title}</Title>
        {ls.map((l) => <MoneyRow key={l.label} label={l.label} amount={l.amount} cur={cur} />)}
      </div>
    ) : null;
  };
  // The description when the builder filled one in, the row number when it did not.
  const byItem = m.rows.flatMap((r, i) => r
    ? [{ label: String(rows[i]?.[ITEM_COL] ?? "").trim() || t("CONFIG_ITEM", String(i + 1)), amount: r.unitCost * r.quantity }]
    : []);
  const mg = margin(totals.price, totals.cost);
  return (
    <>
      {group("material", t("CONFIG_MATERIALS"))}
      {group("operation", t("CONFIG_OPERATIONS"))}
      <div style={SECTION}>
        <MoneyRow label={t("CONFIG_TOTAL_COST", String(m.batchQty))} amount={totals.cost} cur={cur} total />
        {/* A typed grid price wins here as it does on the quotation — see moneyTotals. */}
        <MoneyRow label={t("CONFIG_PRICE")} amount={totals.price} cur={cur} />
        <div style={LINE}>
          <Text>{t("CONFIG_MARGIN")}</Text>
          {/* Negative only below zero: any other threshold would be a policy this app does not have. */}
          <ObjectStatus state={mg !== null && mg < 0 ? "Negative" : "None"}>{percent(mg)}</ObjectStatus>
        </div>
      </div>
      {/* One item is the total again, so the split only earns its space from two rows up. */}
      {byItem.length > 1 ? (
        <div style={SECTION}>
          <Title level="H6">{t("CONFIG_COST_BY_ITEM")}</Title>
          {byItem.map((l, i) => <MoneyRow key={i} label={l.label} amount={l.amount} cur={cur} />)}
        </div>
      ) : null}
    </>
  );
}

/** The per-field price badges, summed. Informational: the calculated price comes from BOM and
 *  routing and never reads these (see paramPrices in config-engine), so they keep their own total. */
export function OptionPrices({ rows, cur }: { rows: CostElement[]; cur?: string }) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  return (
    <div style={SECTION}>
      <Title level="H6">{t("CONFIG_OPTION_PRICES")}</Title>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>{t("CONFIG_OPTION_NOTE")}</Text>
      {rows.map((r) => <MoneyRow key={r.key} label={r.label} amount={r.amount} cur={cur} />)}
      <MoneyRow label={t("CONFIG_TOTAL")} amount={rows.reduce((n, r) => n + r.amount, 0)} cur={cur} total />
    </div>
  );
}
