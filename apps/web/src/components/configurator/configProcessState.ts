import type { Entries, TableRows } from "@confire/config-engine";

/** Should the page fire a calculate? `dirty` is "the user has edits the server has not seen";
 *  `runReady` is "the server already holds candidates". The second trigger is what calculates a
 *  freshly created configuration, or one whose model was just switched, without an edit. */
export function needsCalculation(p: {
  /** quoted => the server refuses every write; never fire the autosave calculate */
  locked: boolean;
  conflicted: boolean;
  missingCount: number;
  batchCount: number;
  lookupsReady: boolean;
  dirty: boolean;
  runReady: boolean;
}) {
  if (p.locked || p.conflicted || p.missingCount > 0 || p.batchCount === 0 || !p.lookupsReady) return false;
  return p.dirty || !p.runReady;
}

// --- Portal-only from here ------------------------------------------------------------------
// The internal process page no longer diffs against the server row: configs.calculate returns the
// project it saved, so `draft !== null` is the whole dirty check. PortalRequestPage still runs
// update -> run -> get, so it still has to ask "did this change?". These go when it stops.

export function sameEntries(a: Entries, b: Entries): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) {
    if (!Object.hasOwn(b, k) || JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/** Row data survives a Postgres round trip as jsonb, which reorders object keys — so compare the
 *  canonical shape, not the literal string. Same reason configDocumentCommandId sorts keys. */
export function sameTables(a: TableRows, b: TableRows): boolean {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const canon = (t: TableRows) =>
    keys.map((k) => (t[k] ?? []).map((row) => Object.keys(row).sort().map((c) => [c, row[c]])));
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Parse one dialled-in quantity into the batch list: positive integers only, de-duped, ascending.
 *  StepInput clamps to `min` but still yields 0 before the user touches it, and its value is a
 *  number that can be NaN — so everything the guards reject here is reachable. */
export function addBatch(batches: number[], raw: string): number[] {
  const n = Number(raw.trim()); // "" and "  " both coerce to 0, which the n < 1 guard rejects
  if (!Number.isInteger(n) || n < 1 || batches.includes(n)) return batches;
  return [...batches, n].sort((a, b) => a - b);
}
