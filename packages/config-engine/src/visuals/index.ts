import type { Val } from "../model.ts";
import { sheetLayout } from "./hera/sheetLayout.ts";
import type { VisualCalc, VisualResult } from "./types.ts";

/** Every tenant visual's calculation, by kind. The drawings are `@confire/ui`'s VISUAL_VIEWS, keyed
 *  the same; a test there keeps the two lists equal. Tenant code lives in a folder per tenant. */
export const VISUALS: Record<string, VisualCalc> = {
  [sheetLayout.kind]: sheetLayout,
};

/** The kinds a workspace may place, by its slug. */
export const visualsFor = (tenant: string): VisualCalc[] => Object.values(VISUALS).filter((v) => v.tenants.includes(tenant));

// The calculation runs inside propagate's fixed-point loop and once per enumerated candidate, so the
// same inputs come back many times per edit.
// ponytail: clear-all memo at 500 entries; an LRU only if a profile shows misses.
const memo = new Map<string, VisualResult | undefined>();

/** One run, its inputs checked against their declared types first: a missing, null or mistyped input
 *  is undecided, and so is a calculation that throws — a visual never fails the calculation. */
export function computeVisual(calc: VisualCalc, inputs: Record<string, Val | undefined>): VisualResult | undefined {
  const names = Object.keys(calc.inputs);
  const args: Record<string, Val> = {};
  for (const n of names) {
    const v = inputs[n];
    if (v === undefined || v === null || typeof v !== calc.inputs[n]!.type) return undefined;
    args[n] = v;
  }
  const key = `${calc.kind}\u0000${JSON.stringify(names.map((n) => args[n]))}`;
  if (memo.has(key)) return memo.get(key);
  let r: VisualResult | undefined;
  try {
    r = calc.compute(args);
  } catch {
    r = undefined;
  }
  if (memo.size >= 500) memo.clear();
  memo.set(key, r);
  return r;
}
