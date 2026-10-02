import { IllustratedMessage, ObjectStatus, Panel, Text, Title } from "@ui5/webcomponents-react";
import "@ui5/webcomponents-fiori/dist/illustrations/NoData.js";
import { evalTableRows, ITEM_COL } from "@confire/config-engine";
import type { Entries, ModelDef, Propagation, ResolvedLookups, TableRows, Val } from "@confire/config-engine";
import { paramPrices, type CostElement } from "./costElements.ts";
import { money } from "../../lib/money.ts";
import { useCurrency } from "../../orpc.ts";
import { moneyTotals, qtyLabel, type CostLine, type ItemMoney } from "./itemMoney.ts";
import { margin } from "./runView.ts";
import { percent } from "../dashboard/dashboardView.ts";
import { SimilarConfigs } from "./SimilarConfigs.tsx";

// The process page's persistent right-hand rail: cost elements and similar past configurations.
// Panels rather than cards — collapsing is native. Uncontrolled on purpose: the rail sits in
// DynamicSideContent's side slot, outside the ObjectPage, and is only ever hidden, never unmounted,
// so each Panel's own `collapsed` outlives tab switches without the page holding it.
export function InsightsRail({ projectId, model, lk, prop, entries, tables, itemMoney, onCopy, slot, className }: {
  projectId: string;
  model: ModelDef;
  lk?: ResolvedLookups;
  prop?: Propagation | null;
  entries: Entries;
  /** the configuration's table rows — the items grid in here drives the per-item cost split */
  tables: TableRows;
  /** derived cost/price per items row; null until there is an item row and a calculation */
  itemMoney?: ItemMoney | null;
  onCopy: (values: Record<string, Val>) => void;
  /** DynamicSideContent's `sideContent` is a web-component slot: the wrapper passes `slot` down and
   *  the outermost DOM element must carry it, or the content lands in the default (main) slot. */
  slot?: string;
  /** the caller's slide animation — same element as `slot`, so no extra DOM node */
  className?: string;
}) {
  const cur = useCurrency();
  // Evaluated rows, not the raw cells, so a computed item code counts — the same evalTableRows the
  // grid and the quotation's lines are drawn from. The raw rows are where a typed price lives.
  const items = (model.tables ?? []).find((t) => t.role === "items");
  const raw = items ? tables[items.key] ?? [] : [];
  const itemRows = items ? evalTableRows(items, raw, prop?.values ?? {}, lk?.tables) : [];
  const totals = itemMoney ? moneyTotals(itemMoney, raw) : null;
  // Same paramPrices() the per-field badges read, so the two cannot disagree.
  const options = lk && prop ? paramPrices(model, prop, lk.tables) : [];

  return (
    // no height/overflow here: the side area (.ui5-dsc-side) brings its own scrollbar.
    <div slot={slot} className={className}
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem" }}>
      {/* The total rides in headerText rather than a `header` slot: a custom header is only
          toggled by its arrow, this one by the whole bar — and the figure survives collapsing. */}
      <Panel headerText={totals ? `Cost elements · ${money(totals.cost, cur)}` : "Cost elements"}>
        <div style={BODY}>
          {itemMoney && totals ? (
            <CostBody rows={itemRows} money={itemMoney} totals={totals} cur={cur} />
          ) : (
            <IllustratedMessage name="NoData" design="ExtraSmall" titleText="No costs yet"
              subtitleText="Add at least one item with a quantity — the calculation fills this in." />
          )}
          {options.length ? <OptionPrices rows={options} cur={cur} /> : null}
        </div>
      </Panel>
      <Panel headerText="Similar configurations" collapsed>
        <div style={BODY}>
          <SimilarConfigs projectId={projectId} model={model} entries={entries} onCopy={onCopy} />
        </div>
      </Panel>
    </div>
  );
}

const BODY = { display: "flex", flexDirection: "column", gap: "0.75rem", padding: "0 0.25rem 0.5rem" } as const;
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
function CostBody({ rows, money: m, totals, cur }: {
  rows: Record<string, Val>[];
  money: ItemMoney;
  totals: { cost: number; price: number };
  cur?: string;
}) {
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
    ? [{ label: String(rows[i]?.[ITEM_COL] ?? "").trim() || `Item ${i + 1}`, amount: r.unitCost * r.quantity }]
    : []);
  const mg = margin(totals.price, totals.cost);
  return (
    <>
      {group("material", "Materials")}
      {group("operation", "Operations")}
      <div style={SECTION}>
        <MoneyRow label={`Total cost${qtyLabel(m.batchQty)}`} amount={totals.cost} cur={cur} total />
        {/* A typed grid price wins here as it does on the quotation — see moneyTotals. */}
        <MoneyRow label="Price" amount={totals.price} cur={cur} />
        <div style={LINE}>
          <Text>Margin</Text>
          {/* Negative only below zero: any other threshold would be a policy this app does not have. */}
          <ObjectStatus state={mg !== null && mg < 0 ? "Negative" : "None"}>{percent(mg)}</ObjectStatus>
        </div>
      </div>
      {/* One item is the total again, so the split only earns its space from two rows up. */}
      {byItem.length > 1 ? (
        <div style={SECTION}>
          <Title level="H6">Cost by item</Title>
          {byItem.map((l, i) => <MoneyRow key={i} label={l.label} amount={l.amount} cur={cur} />)}
        </div>
      ) : null}
    </>
  );
}

/** The per-field price badges, summed. Informational: the calculated price comes from BOM and
 *  routing and never reads these (see costElements.ts), so they keep their own total. */
function OptionPrices({ rows, cur }: { rows: CostElement[]; cur?: string }) {
  return (
    <div style={SECTION}>
      <Title level="H6">Option prices</Title>
      <Text style={{ color: "var(--sapContent_LabelColor)" }}>Informational — not part of the calculated cost.</Text>
      {rows.map((r) => <MoneyRow key={r.key} label={r.label} amount={r.amount} cur={cur} />)}
      <MoneyRow label="Total" amount={rows.reduce((n, r) => n + r.amount, 0)} cur={cur} total />
    </div>
  );
}
