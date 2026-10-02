import type { QueryClient } from "@tanstack/react-query";
import { fetchPage, sourceKey, type CflRequest } from "./cfl-provider.ts";
import { keyFieldOf } from "./cfl-configs.ts";
import type { CflFieldConfig, Row } from "../types.ts";

// CflExistenceService: does a typed key exist, and which row is it. The react-query cache is the
// cache — a probed value is not probed again for five minutes — so the Beas 500-entry eviction is
// not reimplemented here.

const STALE = 5 * 60_000;

/** `fixedFilters` and `keyField eq value`, one row: the probe and the label lookup's read. */
export function probeRequest(cfg: CflFieldConfig, value: unknown): CflRequest {
  const d = cfg.dialogConfig;
  const v = typeof value === "number" ? value : String(value ?? "").trim();
  return { filter: [...(d.fixedFilters ?? []), { field: keyFieldOf(d), op: "eq", value: v }] };
}

/** Shared with the label lookup, so a probe and a label are one read. */
export const probeKey = (cfg: CflFieldConfig, value: unknown) =>
  ["cfl-probe", sourceKey(cfg.searchEndpoint ?? cfg.dialogConfig.source), probeRequest(cfg, value)] as const;

/** The row behind a key. `undefined` = the probe itself failed (agent down, a 400): unknown, not
 *  missing. `null` = definitely not there. */
export async function findRow(qc: QueryClient, cfg: CflFieldConfig, value: unknown): Promise<Row | null | undefined> {
  try {
    const page = await qc.fetchQuery({
      queryKey: probeKey(cfg, value),
      queryFn: () => fetchPage(cfg.searchEndpoint ?? cfg.dialogConfig.source, probeRequest(cfg, value)),
      staleTime: STALE,
      retry: false,
    });
    const key = keyFieldOf(cfg.dialogConfig);
    // Any row is a hit, as in Beas (`value.length > 0`): B1's collation matches `eq` case-
    // insensitively, so 'c001' finding 'C001' is SAP saying it exists. The exact one wins if both.
    return page.rows.find((r) => String(r[key] ?? "").trim() === String(value ?? "").trim()) ?? page.rows[0] ?? null;
  } catch (e) {
    console.warn("value help existence check failed", e);
    return undefined;
  }
}

/** A failed probe counts as "exists": a backend problem never blocks the user, and saving then
 *  relies on SAP's own validation. */
export async function exists(qc: QueryClient, cfg: CflFieldConfig, value: unknown): Promise<boolean> {
  return (await findRow(qc, cfg, value)) !== null;
}

/** Write "exists" for a picked row, so no probe follows the pick (Beas markValueKnown). */
export function markKnown(qc: QueryClient, cfg: CflFieldConfig, row: Row): void {
  const value = row[keyFieldOf(cfg.dialogConfig)];
  qc.setQueryData(probeKey(cfg, value), { rows: [row] });
}

/** Every distinct value exists? (Beas `wu()`), probing each once. */
export async function allExist(qc: QueryClient, cfg: CflFieldConfig, values: unknown[]): Promise<Set<string>> {
  const missing = new Set<string>();
  const distinct = [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
  await Promise.all(distinct.map(async (v) => { if (!(await exists(qc, cfg, v))) missing.add(v); }));
  return missing;
}

/** "Business partner not found" — the dialog title names the entity (Beas `Du()`). */
export const notFoundMessage = (cfg: CflFieldConfig) =>
  cfg.dialogConfig.title ? `${cfg.dialogConfig.title} not found` : "Entry not found";
