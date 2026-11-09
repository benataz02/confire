import type { Val } from "../model.ts";

/** A visual's declared inputs or outputs: name → what it holds and how the builder labels it. */
export type VisualIO = Record<string, { type: "number" | "string" | "boolean"; label: string }>;

/** One run of a visual's calculation: the values formulas read, and what the drawing draws — from
 *  the same run, so the count and the picture cannot disagree. `view` is plain JSON. */
export type VisualResult = { outputs: Record<string, Val>; view: unknown };

/** The calculation half of a tenant visual (the drawing half is `@confire/ui`'s, by the same kind).
 *  Code a Confire developer writes for one tenant; `tenants` are the slugs that may use it. */
export type VisualCalc = {
  kind: string;
  tenants: string[];
  label: string;
  inputs: VisualIO;
  outputs: VisualIO;
  /** undefined = undecided: the inputs make no sense (a zero piece, a negative gap) */
  compute: (inputs: Record<string, Val>) => VisualResult | undefined;
};
