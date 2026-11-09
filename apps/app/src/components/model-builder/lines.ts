import { OPERATION_VARS, type ModelDef } from "@confire/config-engine";
import type { Row } from "@confire/ui/types.ts";

// The BOM and routing line rules the builder's line dialog follows, kept pure so they are tested
// apart from the dialog (LineTables.tsx).

export type BomLine = ModelDef["bom"][number];
export type OpLine = ModelDef["routing"][number];

// An item code is still an expression — the value help just writes the common case, a quoted
// literal. `asCode` reads that case back out so the picker can show what was picked; anything
// else (a ternary, a parameter) has no single code and is shown as the expression it is.
const LITERAL = /^\s*"([^"\\]*)"\s*$/;
export const asCode = (expr: string): string | undefined => LITERAL.exec(expr)?.[1];

export const FIGURES = ["setupMin", "runMinPerUnit", "ratePerHour"] as const;
/** Each figure's catalog name, in FIGURES' order (OPERATION_VARS is setup, run, rate). */
const CATALOG_NAME = Object.fromEntries(FIGURES.map((f, i) => [f, OPERATION_VARS[i]!])) as Record<(typeof FIGURES)[number], string>;

const NUMBER = /^\s*-?\d+(\.\d+)?\s*$/;
const NAMES = new Set<string>(OPERATION_VARS);

/** A figure an operation pick may overwrite: empty, a plain number — a new line's default or a
 *  hand-typed figure from before Beas, the staleness linking removes — or a bare catalog name.
 *  Any other formula is the author's and stays (`beasRun * holes`, `area * 0.02`). */
export const isReplaceable = (expr: string | undefined): boolean =>
  !expr?.trim() || NUMBER.test(expr) || NAMES.has(expr.trim());

/** The line with each replaceable figure set to its catalog name, so it follows Beas live. */
export const withCatalogFigures = (line: OpLine): OpLine => ({
  ...line,
  ...Object.fromEntries(FIGURES.filter((f) => isReplaceable(line[f])).map((f) => [f, CATALOG_NAME[f]])),
});

const trimmed = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A picked OperationsCatalog row laid over the line: its code as a literal, its description and
 *  resource (Beas pads them), and the figures as live catalog names. */
export function pickOperation(line: OpLine, row: Row): OpLine {
  const desc = trimmed(row.Description);
  const resource = trimmed(row.ResourceId);
  return withCatalogFigures({
    ...line,
    operationId: JSON.stringify(trimmed(row.OperationId) ?? ""),
    ...(desc ? { desc } : {}),
    ...(resource ? { resource } : {}),
  });
}

export const newBomLine = (): BomLine => ({ itemCode: "", qty: "1" });
/** Empty figures, not "0": the dialog's OK waits until a pick or a typed value fills them. */
export const newOpLine = (): OpLine => ({ setupMin: "", runMinPerUnit: "", ratePerHour: "" });

/** The required fields still empty. An operation and a resource are optional: a workspace
 *  without Beas writes its routing by hand. */
export function missingFields(kind: "bom" | "routing", line: BomLine | OpLine): string[] {
  const keys = kind === "bom" ? (["itemCode", "qty"] as const) : FIGURES;
  return keys.filter((k) => !String((line as Record<string, unknown>)[k] ?? "").trim());
}
