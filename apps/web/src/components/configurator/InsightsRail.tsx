import type { ReactNode } from "react";
import { Panel, Text, Title } from "@ui5/webcomponents-react";
import { evalTableRows, ITEM_COL } from "@confire/config-engine";
import type { Entries, ModelDef, Propagation, ResolvedLookups, TableRows, Val } from "@confire/config-engine";
import { money, paramPrices } from "./costElements.ts";
import { DocHistory, Similar } from "./HistoryPane.tsx";

// The process page's persistent right-hand rail: cost elements, B1 document history, similar past
// configurations. Three Panels rather than cards — `collapsed`/`onToggle` are native, and `fixed`
// on the only open one keeps at least one expanded without an accordion state machine.
export function InsightsRail({ projectId, model, lk, prop, entries, tables, onCopy, open, onToggle, slot, className }: {
  projectId: string;
  model: ModelDef;
  lk?: ResolvedLookups;
  prop?: Propagation | null;
  entries: Entries;
  /** the configuration's table rows — the items grid in here is what doc history matches on */
  tables: TableRows;
  onCopy: (values: Record<string, Val>) => void;
  open: Set<string>;
  onToggle: (key: string) => void;
  /** DynamicSideContent's `sideContent` is a web-component slot: the wrapper passes `slot` down and
   *  the outermost DOM element must carry it, or the content lands in the default (main) slot. */
  slot?: string;
  /** the caller's slide animation — same element as `slot`, so no extra DOM node */
  className?: string;
}) {
  // The items grid IS the item list: no model setting names an item-code parameter any more.
  // Evaluated, not the raw cells, so a computed item code counts — the same evalTableRows the grid
  // and the quotation's lines are drawn from. ponytail: 20, because each code is another OR clause
  // in the crossjoin filter and the oRPC input caps it there; page the rest if a grid ever needs it.
  const items = (model.tables ?? []).find((t) => t.role === "items");
  const itemCodes = items
    ? [...new Set(
        evalTableRows(items, tables[items.key] ?? [], prop?.values ?? {}, lk?.tables)
          .map((r) => String(r[ITEM_COL] ?? "").trim())
          .filter(Boolean),
      )].slice(0, 20)
    : [];

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
      {panel("costs", "Cost elements", lk && prop
        ? <Costs model={model} lookups={lk} prop={prop} />
        : <Text>No priced parameters yet — fill the form, or add price formulas in the model builder.</Text>)}
      {panel("documents", "Documents",
        <DocHistory projectId={projectId} itemCodes={itemCodes} open={open.has("documents")} />)}
      {panel("similars", "Similar configurations",
        <Similar projectId={projectId} model={model} entries={entries} onCopy={onCopy} />)}
    </div>
  );
}

// Same paramPrices() the per-field badges read, so the card and the badges cannot disagree.
function Costs({ model, lookups, prop }: { model: ModelDef; lookups: ResolvedLookups; prop: Propagation }) {
  const rows = paramPrices(model, prop, lookups.tables);
  const cur = model.pricing.currency;
  if (!rows.length)
    return <Text>No priced parameters yet — fill the form, or add price formulas in the model builder.</Text>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
          <Text>{r.label}</Text>
          <Text>{money(r.amount, cur)}</Text>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem",
        borderBlockStart: "1px solid var(--sapList_BorderColor)", paddingBlockStart: "0.25rem", marginBlockStart: "0.25rem" }}>
        <Title level="H6">Total</Title>
        <Title level="H6">{money(rows.reduce((n, r) => n + r.amount, 0), cur)}</Title>
      </div>
    </div>
  );
}
