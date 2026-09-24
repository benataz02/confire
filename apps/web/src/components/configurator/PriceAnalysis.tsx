import {
  Icon, MessageStrip, ObjectStatus, Table, TableCell, TableHeaderCell, TableHeaderRow, TableRow, Text, Title, ToggleButton,
} from "@ui5/webcomponents-react";
import { LineChart } from "@ui5/webcomponents-react-charts";
import type { Entries, ModelDef } from "@confire/config-engine";
import {
  bestByBatch, candidateLabel, chartRows, fmt, isSelected, margin, openKeys, type PricedCandidate, type Sel,
} from "./runView.ts";
import { percent } from "../dashboard/dashboardView.ts";
import { money } from "../../lib/money.ts";
import { useCurrency } from "../../orpc.ts";

// The one candidates view, portal and internal alike: rows = candidates (labeled by their
// open-parameter values), columns = batch quantities, every price cell IS the selection control —
// one pressed cell = one future quotation line. Below it, how the price moves with quantity for
// the configurations being quoted. Cost only exists on the internal side (the portal payload never
// carries it), so the margin row appears exactly where it may.
export function PriceAnalysis({ model, entries, candidates, selection, onToggle, capped, widest, disabled }: {
  model: ModelDef;
  entries: Entries;
  candidates: PricedCandidate[];
  selection: Sel[];
  onToggle: (candidateIdx: number, batchQty: number) => void;
  /** the portal's only place to say so; the internal page reports it in its message popover */
  capped?: boolean;
  widest?: { key: string; size: number };
  /** locked (quoted) — the cells still show their prices, they just stop being controls */
  disabled?: boolean;
}) {
  const currency = useCurrency();
  const keys = openKeys(model, entries, candidates);
  const best = bestByBatch(candidates);
  const batches = candidates[0]?.perBatch.map((b) => b.batchQty) ?? [];
  const withCost = candidates.some((c) => c.perBatch.some((b) => b.unitCost !== undefined));

  const rows = chartRows(candidates, selection);
  const dataset = batches.map((q, j) =>
    Object.fromEntries([["qty", q], ...rows.map((i) => [`c${i}`, candidates[i]!.perBatch[j]!.unitPrice])]));
  const label = (i: number) => candidateLabel(keys, candidates[i]!.assignment);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Text>
        Unit price per batch quantity. Each picked cell becomes one quotation line; the check marks
        the lowest price for that quantity.{withCost ? " The percentage under a price is its margin." : ""}
      </Text>
      {capped ? (
        <MessageStrip design="Critical" hideCloseButton>
          Stopped at {candidates.length} candidates — go back and set more parameters
          {widest ? ` (${model.parameters.find((p) => p.key === widest.key)?.label ?? widest.key} is widest with ${widest.size} options)` : ""}.
        </MessageStrip>
      ) : null}
      <Table
        headerRow={
          <TableHeaderRow sticky>
            <TableHeaderCell minWidth="14rem"><span>Configuration ({keys.join(" · ") || "fixed"})</span></TableHeaderCell>
            {batches.map((b) => (
              <TableHeaderCell key={b} horizontalAlign="End"><span>Qty {fmt(b)}</span></TableHeaderCell>
            ))}
          </TableHeaderRow>
        }
      >
        {candidates.map((c, i) => (
          <TableRow key={i} rowKey={String(i)}>
            <TableCell><Text>{label(i)}</Text></TableCell>
            {c.perBatch.map((b) => {
              const m = b.unitCost === undefined ? undefined : margin(b.unitPrice, b.unitCost);
              return (
                <TableCell key={b.batchQty} horizontalAlign="End">
                  <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end" }}>
                    {/* Selection = pressed state only; the green check marks the cheapest cell per
                        column, so "selected" and "best price" can never be confused. */}
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                      {best[b.batchQty] === i ? (
                        <Icon name="accept" design="Positive" accessibleName="Lowest price for this quantity"
                          style={{ width: "0.875rem", height: "0.875rem" }} />
                      ) : null}
                      <ToggleButton pressed={isSelected(selection, i, b.batchQty)} disabled={disabled}
                        tooltip={best[b.batchQty] === i ? "Lowest price for this quantity" : undefined}
                        onClick={() => onToggle(i, b.batchQty)}>
                        {money(b.unitPrice, currency)}
                      </ToggleButton>
                    </div>
                    {m !== undefined ? (
                      <ObjectStatus title="Margin" state={m !== null && m < 0 ? "Negative" : "None"}>
                        {percent(m)}
                      </ObjectStatus>
                    ) : null}
                  </div>
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </Table>

      {/* The matrix above is this chart's table view — same numbers, exact — so the chart can stay
          a shape: no data labels, a legend only once there are lines to tell apart. */}
      {rows.length ? (
        <>
          <Title level="H6">
            {rows.length === 1 ? `Unit price by quantity — ${label(rows[0]!)}` : "Unit price by quantity"}
          </Title>
          <LineChart style={{ height: "16rem" }} dataset={dataset} noLegend={rows.length === 1}
            dimensions={[{ accessor: "qty", formatter: (v) => `Qty ${fmt(Number(v))}` }]}
            measures={rows.map((i) => ({
              accessor: `c${i}`, label: label(i), hideDataLabel: true, width: 2,
              // Keyed to the candidate, not the pick order, so unpicking one row never repaints
              // the others. ponytail: two picked rows 11 apart share a colour (the theme has 11);
              // the legend still tells them apart — map picks to free slots if that ever bites.
              color: `var(--sapChart_OrderedColor_${(i % 11) + 1})`,
              formatter: (v: number) => money(v, currency),
            }))} />
        </>
      ) : null}
    </div>
  );
}
