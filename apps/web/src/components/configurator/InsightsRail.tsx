import type { ReactNode } from "react";
import { Panel, Text, Title } from "@ui5/webcomponents-react";
import { evalTableRows, ITEM_COL } from "@confire/config-engine";
import type { Entries, ModelDef, Propagation, ResolvedLookups, TableRows, Val } from "@confire/config-engine";
import { paramPrices } from "./costElements.ts";
import { money } from "../../lib/money.ts";
import { useCurrency } from "../../orpc.ts";
import { qtyLabel, type CostLine, type ItemMoney } from "./itemMoney.ts";
import { Similar } from "./HistoryPane.tsx";

// The process page's persistent right-hand rail: cost elements and similar past configurations.
// Panels rather than cards — `collapsed`/`onToggle` are native, and `fixed` on the only open one
// keeps at least one expanded without an accordion state machine.
export function InsightsRail({ projectId, model, lk, prop, entries, tables, itemMoney, onCopy, open, onToggle, slot, className }: {
  projectId: string;
  model: ModelDef;
  lk?: ResolvedLookups;
  prop?: Propagation | null;
  entries: Entries;
  /** the configuration's table rows — the items grid in here drives the per-item cost split */
  tables: TableRows;
  /** derived cost/price per items row; absent = no Items block in the Costs panel */
  itemMoney?: ItemMoney | null;
  onCopy: (values: Record<string, Val>) => void;
  open: Set<string>;
  onToggle: (key: string) => void;
  /** DynamicSideContent's `sideContent` is a web-component slot: the wrapper passes `slot` down and
   *  the outermost DOM element must carry it, or the content lands in the default (main) slot. */
  slot?: string;
  /** the caller's slide animation — same element as `slot`, so no extra DOM node */
  className?: string;
}) {
  // Evaluated rows, not the raw cells, so a computed item code counts — the same evalTableRows the
  // grid and the quotation's lines are drawn from.
  const items = (model.tables ?? []).find((t) => t.role === "items");
  const itemRows = items ? evalTableRows(items, tables[items.key] ?? [], prop?.values ?? {}, lk?.tables) : [];

  const panel = (key: string, title: string, body: ReactNode) => (
    <Panel headerText={title} collapsed={!open.has(key)} fixed={open.has(key) && open.size === 1}
      onToggle={() => onToggle(key)}>
      <div style={{ padding: "0 0.25rem 0.5rem" }}>{body}</div>
    </Panel>
  );

  return (
    // no height/overflow here: the side area (.ui5-dsc-side) brings its own scrollbar.
    <div slot={slot} className={className}
      style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem" }}>
      {panel("costs", "Cost elements", (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {lk && prop
            ? <Costs model={model} lookups={lk} prop={prop} />
            : <Text>No priced parameters yet — fill the form, or add price formulas in the model builder.</Text>}
          {itemMoney ? <LineCosts lines={itemMoney.lines} /> : null}
          {itemMoney ? <ItemCosts rows={itemRows} money={itemMoney} /> : null}
        </div>
      ))}
      {panel("similars", "Similar configurations",
        <Similar projectId={projectId} model={model} entries={entries} onCopy={onCopy} />)}
    </div>
  );
}

const SECTION = {
  display: "flex", flexDirection: "column", gap: "0.25rem",
  borderBlockStart: "1px solid var(--sapList_BorderColor)", paddingBlockStart: "0.5rem",
} as const;
const RULE = {
  borderBlockStart: "1px solid var(--sapList_BorderColor)",
  paddingBlockStart: "0.25rem", marginBlockStart: "0.25rem",
} as const;

/** The only line this rail draws: a label and an amount, `total` being the same in heavier type
 *  above a rule. */
function MoneyRow({ label, amount, cur, total }: { label: string; amount: number; cur?: string; total?: boolean }) {
  const cell = (t: string) => (total ? <Title level="H6">{t}</Title> : <Text>{t}</Text>);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", ...(total ? RULE : null) }}>
      {cell(label)}
      {cell(money(amount, cur))}
    </div>
  );
}

/** What the cost is *made of* — every BOM line by its description (the item code only when the
 *  model builder never filled one in) and every operation by its resource. Batch totals from the
 *  same computeOutputs call the Items block splits, so the two cannot disagree on the money. */
function LineCosts({ lines }: { lines: CostLine[] }) {
  const cur = useCurrency();
  const group = (kind: CostLine["kind"], title: string) => {
    const ls = lines.filter((l) => l.kind === kind);
    return ls.length ? (
      <div style={SECTION}>
        <Title level="H6">{title}</Title>
        {ls.map((l) => <MoneyRow key={l.label} label={l.label} amount={l.amount} cur={cur} />)}
      </div>
    ) : null;
  };
  return <>{group("material", "Materials")}{group("operation", "Operations")}</>;
}

/** Where the configuration's cost actually lands, row by row, split on the items table's own
 *  `basisExpr`. Line totals, not per-unit: a cost element is an amount. The grid next to it shows
 *  the same money per unit, from the same itemSplit call. */
function ItemCosts({ rows, money: m }: { rows: Record<string, Val>[]; money: ItemMoney }) {
  const cur = useCurrency();
  const lines = m.rows
    .map((r, i) => ({ r, label: String(rows[i]?.[ITEM_COL] ?? "").trim() || `Item ${i + 1}` }))
    .filter((l): l is { r: NonNullable<typeof l.r>; label: string } => !!l.r);
  if (!lines.length) return null;
  const total = lines.reduce((n, l) => n + l.r.unitCost * l.r.quantity, 0);
  return (
    <div style={SECTION}>
      <Title level="H6">{`Items${qtyLabel(m.batchQty)}`}</Title>
      {lines.map((l, i) => (
        <MoneyRow key={i} label={l.label} amount={l.r.unitCost * l.r.quantity} cur={cur} />
      ))}
      <MoneyRow label="Total" amount={total} cur={cur} total />
    </div>
  );
}

// Same paramPrices() the per-field badges read, so the card and the badges cannot disagree.
function Costs({ model, lookups, prop }: { model: ModelDef; lookups: ResolvedLookups; prop: Propagation }) {
  const rows = paramPrices(model, prop, lookups.tables);
  const cur = useCurrency();
  if (!rows.length)
    return <Text>No priced parameters yet — fill the form, or add price formulas in the model builder.</Text>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {rows.map((r) => <MoneyRow key={r.key} label={r.label} amount={r.amount} cur={cur} />)}
      <MoneyRow label="Total" amount={rows.reduce((n, r) => n + r.amount, 0)} cur={cur} total />
    </div>
  );
}
