import type { SQL } from "drizzle-orm";
import {
  costBreakdown, domainOf, formState, marginOf, paramPrices, syncTables,
  type ModelDef, type Notice, type Propagation, type Val,
} from "@confire/config-engine";
import type { ConfigCandidate } from "@confire/db";
import { liveProject, type LiveProject } from "./config-project.ts";
import type { RowCache } from "./lookups.ts";

// What the staff process page — and later an MCP client — is shown of a configuration: everything
// the screen draws, worked out here, plain JSON, without the engine's raw output (no candidate's
// BOM or routing, no prices). The browser formats it and sorts it, and computes nothing from it.

/** The open parameters the candidates assign, in model order: the columns that tell them apart. */
function openKeys(model: ModelDef, entries: Record<string, Val>, candidates: ConfigCandidate[]): string[] {
  const assigned = new Set<string>();
  for (const c of candidates) for (const k of Object.keys(c.assignment)) if (!(k in entries)) assigned.add(k);
  return model.parameters.map((p) => p.key).filter((k) => assigned.has(k));
}

const labelOf = (model: ModelDef, key: string) => model.parameters.find((p) => p.key === key)?.label || key;

/** The parameter whose live options multiply out most — what to fix when the enumeration caps. */
function widestOf(prop: Propagation): { key: string; size: number } | undefined {
  let widest: { key: string; size: number } | undefined;
  for (const k of prop.open) {
    const size = (prop.domains[k] ?? []).filter((o) => !o.eliminatedBy).length;
    if (!widest || size > widest.size) widest = { key: k, size };
  }
  return widest;
}

/** What the message popover says that the server knows, beyond `missing` and the conflicts. */
function issuesOf(live: Pick<LiveProject, "row" | "model" | "md" | "lookups" | "prop">, capped: boolean): Notice[] {
  const { row, md, lookups, prop } = live;
  const model = live.model.definition;
  const out: Notice[] = [];
  // An entry the field does not offer: options move with other fields and the cache, and an API
  // client can send any value — the page never offers one, so nothing else would say it.
  for (const p of model.parameters) {
    const v = row.entries[p.key];
    if (p.domain?.kind !== "options" || v === undefined || v === null || !prop.visible[p.key]) continue;
    const dom = domainOf(model, lookups, p.key);
    if (!dom.length) continue; // an empty table says so itself (sync_never)
    const off = (Array.isArray(v) ? v : [v]).filter((x) => !dom.some((o) => o.value === x));
    for (const x of off)
      out.push({ key: p.key, code: "not_an_option", params: [labelOf(model, p.key), String(x)], message: `${String(x)} is not one of ${labelOf(model, p.key)}'s options` });
  }
  // Freshness travels with the data: a never-synced table is why its lists are empty, a failed sync
  // is worth knowing; merely stale says nothing, that is what a sync frequency is for.
  const named = syncTables(model);
  for (const r of md) {
    if (r.kind !== "query" || !named.has(r.name)) continue;
    if (r.syncError)
      out.push({ code: "sync_failed", params: [r.name, r.syncError, String(r.rowCount ?? 0)], message: `'${r.name}' could not be refreshed: ${r.syncError}` });
    else if (!r.syncedAt)
      out.push({ code: "sync_never", params: [r.name], message: `'${r.name}' has not been synced yet` });
  }
  if (capped) {
    const w = widestOf(prop);
    out.push({
      code: "capped", params: [String(row.candidates.length), ...(w ? [labelOf(model, w.key), String(w.size)] : [])],
      message: `Stopped at ${row.candidates.length} candidates — set more parameters${w ? ` (${labelOf(model, w.key)} has ${w.size} options)` : ""}`,
    });
  }
  // Read off the stored candidates, so the warning is exactly as current as the prices it is about.
  const list = model.pricing.priceList;
  const unpriced = new Set(row.candidates.flatMap((c) => c.perBatch.flatMap((b) => b.outputs.bom.filter((l) => l.unpriced).map((l) => l.itemCode))));
  for (const code of unpriced)
    out.push({
      code: "unpriced", params: [code, ...(list ? [String(list)] : [])],
      message: `No price for ${code} in ${list ? `price list ${list}` : "the price list"} — its material is costed at 0`,
    });
  return out;
}

/** The view, from a live project. Pure: everything it reads is already loaded. */
export function composeView(live: Pick<LiveProject, "row" | "model" | "md" | "lookups" | "prop" | "missing" | "calculation">) {
  const { row, lookups, prop } = live;
  const model = live.model.definition;
  const stored = row.candidates;
  const selection = row.selection ?? [];

  const keys = openKeys(model, row.entries, stored);
  // Lowest unit price per batch quantity -> candidate index, first wins on ties.
  const best = new Map<number, { idx: number; price: number }>();
  stored.forEach((c, idx) => {
    for (const b of c.perBatch) {
      const cur = best.get(b.batchQty);
      if (!cur || b.outputs.unitPrice < cur.price) best.set(b.batchQty, { idx, price: b.outputs.unitPrice });
    }
  });
  const capped = stored.length >= 200;
  const optionRows = paramPrices(model, prop, lookups.tables);

  return {
    project: {
      id: row.id, name: row.name, customer: row.customer, status: row.status, modelId: row.modelId,
      entries: row.entries, batches: row.batches, tables: row.tables, sources: row.sources, selection: row.selection,
      calculatedAt: row.calculatedAt, b1DocEntry: row.b1DocEntry, b1Company: row.b1Company,
      quoteResponse: row.quoteResponse, portalCardCode: row.portalCardCode, assigneeId: row.assigneeId,
      updatedAt: row.updatedAt,
    },
    form: formState(model, lookups, prop, row.tables),
    missing: live.missing,
    calculation: live.calculation,
    candidates: {
      keys,
      rows: stored.map((c, i) => ({
        assignment: Object.fromEntries(keys.map((k) => [k, c.assignment[k] ?? null])),
        perBatch: c.perBatch.map((b) => ({
          batchQty: b.batchQty, unitPrice: b.outputs.unitPrice, unitCost: b.outputs.unitCost, total: b.outputs.batchTotal,
          margin: marginOf(b.outputs.unitPrice, b.outputs.unitCost), lowest: best.get(b.batchQty)?.idx === i,
        })),
      })),
      capped,
      ...(capped ? { widest: widestOf(prop) } : {}),
    },
    costs: costBreakdown(model, lookups, row.tables, stored, selection, row.batches),
    optionPrices: { rows: optionRows, total: optionRows.reduce((n, r) => n + r.amount, 0) },
    // What the picked cells price at, before a hand-typed price in the items grid moves it — the
    // grid and the quotation, not this figure, are what the customer is charged.
    selection: {
      picks: selection,
      total: selection.reduce((n, s) => n + (stored[s.candidateIdx]?.perBatch.find((b) => b.batchQty === s.batchQty)?.outputs.batchTotal ?? 0), 0),
    },
    issues: issuesOf(live, capped),
  };
}
export type ConfigView = ReturnType<typeof composeView>;

/** A staff read: the live project (refreshed when stale and writable), composed. */
export async function configView(tenantId: string, where: SQL, cache?: RowCache) {
  const live = await liveProject(tenantId, where, "internal", cache);
  return { live, view: composeView(live) };
}
