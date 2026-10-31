import { ObjectStatus, Text, Title } from "@ui5/webcomponents-react";
import { ITEM_COL, type CostBreakdown, type CostLine, type Val } from "@confire/config-engine";
import { money } from "@confire/ui/money.ts";
import { useI18n } from "../../i18n.ts";
import { percent } from "./runView.ts";

// The insights rail's cost blocks. The rail itself is ConfigProcessPage's DynamicSideContent side
// content; these are what its "Cost elements" panel draws — the view's figures, formatted.

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
 *  block. Materials, Operations and Other costs add up to Total cost; Cost by item is that same total on the
 *  other axis, in line totals because a cost element is an amount (the grid shows it per unit).
 *  `rows` are the items grid's evaluated rows, for the item codes. */
export function CostBody({ rows, cost: c, cur }: {
  rows: Record<string, Val>[];
  cost: CostBreakdown;
  cur?: string;
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const group = (ls: CostLine[], title: string) => (ls.length ? (
    <div style={SECTION}>
      <Title level="H6">{title}</Title>
      {ls.map((l) => <MoneyRow key={l.label} label={l.label} amount={l.amount} cur={cur} />)}
    </div>
  ) : null);
  // The item code when the row has one, the row number when it does not.
  const byItem = c.items.flatMap((r, i) => r
    ? [{ label: String(rows[i]?.[ITEM_COL] ?? "").trim() || t("CONFIG_ITEM", String(i + 1)), amount: r.lineCost }]
    : []);
  return (
    <>
      {group(c.materials, t("CONFIG_MATERIALS"))}
      {group(c.operations, t("CONFIG_OPERATIONS"))}
      {group(c.other, t("CONFIG_OTHER_COSTS"))}
      <div style={SECTION}>
        <MoneyRow label={t("CONFIG_TOTAL_COST", String(c.batchQty))} amount={c.cost} cur={cur} total />
        {/* A typed grid price wins here as it does on the quotation: the same money unit. */}
        <MoneyRow label={t("CONFIG_PRICE")} amount={c.price} cur={cur} />
        <div style={LINE}>
          <Text>{t("CONFIG_MARGIN")}</Text>
          {/* Negative only below zero: any other threshold would be a policy this app does not have. */}
          <ObjectStatus state={c.margin !== null && c.margin < 0 ? "Negative" : "None"}>{percent(c.margin)}</ObjectStatus>
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
