import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, configProject, type ConfigCandidate, type ConfigSelection } from "@confire/db";
import {
  bindings,
  computeOutputs,
  DslError,
  itemSplit,
  PRICE_COL,
  type ItemsTable,
  type ModelDef,
  type ResolvedLookups,
  type TableRows,
  type Val,
} from "@confire/config-engine";
import { ENTITY_PROFILES } from "./entity-profiles.ts";

export type ConfigProjectRow = typeof configProject.$inferSelect;

/** UDF on OQUT carrying configDocumentCommandId, so a retried createQuote finds the quotation it
 *  already posted instead of posting a second one. Must exist in the customer's B1 — the install
 *  step is one alphanumeric UDF of length 64 on Sales Quotation (Title). */
export const DEDUP_UDF = "U_CF_Key";

/** Deterministic create command id / SAP dedup UDF value for a project's current selection.
 *  Keyed on what is being quoted, not a version counter: the same picks retried yield the same id
 *  (a retry must never create a second SAP document), a changed selection yields a new one.
 *
 *  It hashes each pick's *assignment*, not its `candidateIdx`. Indices are only meaningful against
 *  the candidate list that produced them, and a recalculate replaces that list — so hashing the
 *  index would let "candidate 0" of a fresh calculation collide with a quotation posted for a
 *  different configuration whose response never arrived. */
export function configDocumentCommandId(input: {
  tenantId: string;
  projectId: string;
  candidates: ConfigCandidate[];
  selection: ConfigSelection[];
  /** row data: it decides how many lines the quotation has and what is on them, so editing the
   *  item matrix has to yield a new id — otherwise the SAP pre-check finds the old quotation and
   *  createQuote reports `reused: true` for a document that no longer matches. */
  tables: TableRows;
}): string {
  // Sorted so a pure reorder of the same picks keeps the same id.
  const sel = [...input.selection]
    .sort((a, b) => a.candidateIdx - b.candidateIdx || a.batchQty - b.batchQty)
    .map((s) => ({
      assignment: input.candidates[s.candidateIdx]?.assignment ?? null,
      batchQty: s.batchQty,
      overrides: s.overrides,
    }));
  const raw = `${input.tenantId}|${input.projectId}|${canonicalJson({ sel, tables: input.tables })}`;
  return createHash("sha256").update(raw).digest("hex");
}

/** JSON with object keys sorted. Plain JSON.stringify will not do: Postgres reorders jsonb object
 *  keys, so a selection read back from config_project would hash differently from the one written. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Whole cents, the way B1 rounds a line total. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Header fields the quote page may set on a configurator quotation. Read off the Quotations
 *  profile so the page's write allowlist and the entity page's cannot drift; deliberately NOT the
 *  profile's `editableCollections` or its `U_` escape hatch — DocumentLines come from the item
 *  matrix and U_CF_Key is the dedup key, both the server's alone. */
export const QUOTE_HEADER = new Set(ENTITY_PROFILES.Quotations!.editable);

/** The one items table a model may declare, if it declared one. checkModel caps it at one. */
const itemsTableOf = (model: ModelDef): ItemsTable | undefined =>
  (model.tables ?? []).find((t): t is ItemsTable => t.role === "items");

/**
 * The quotation's DocumentLines and the engineered totals behind them, from the persisted project
 * and the model's live lookups. The server recomputes every price; the browser's figures are never
 * trusted.
 *
 * One selected (candidate, batch) pair is normally one line. With an items table it is n lines —
 * merge production yields several different items from one run, so the cost is joint and can only
 * be *split*, never computed per item. `value` is the sum of the lines actually built, which is
 * what makes the stored `quotedValue` and the posted document agree by construction.
 */
export function buildQuoteLines(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): { lines: Record<string, unknown>[]; value: number; cost: number } {
  const items = itemsTableOf(model);
  const lines: Record<string, unknown>[] = [];
  let value = 0;
  let cost = 0;

  for (const s of project.selection ?? []) {
    const cand = project.candidates[s.candidateIdx];
    if (!cand) continue;
    let out;
    try {
      out = computeOutputs(model, lookups, cand.assignment, s.batchQty, s.overrides, project.tables);
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) {
        throw new ORPCError("BAD_REQUEST", { message: e.message });
      }
      throw e;
    }
    cost += out.unitCost * s.batchQty;

    const desc =
      Object.entries(cand.assignment)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "Configuration";

    // itemSplit drops the rows that ship nothing, or the shares would not sum to the total.
    const scope = { ...bindings(model, lookups, cand.assignment, project.tables).values, qty: s.batchQty };
    const split = !items ? [] : itemSplit(
      items, project.tables[items.key] ?? [], scope, lookups.tables, s.batchQty,
      { cost: out.unitCost * s.batchQty, price: out.unitPrice * s.batchQty },
    );

    if (!items || split.length === 0) {
      lines.push({
        ItemCode: model.pricing.quoteItemCode,
        ItemDescription: desc,
        Quantity: s.batchQty,
        UnitPrice: out.unitPrice,
      });
      value += out.unitPrice * s.batchQty;
      continue;
    }

    for (const l of split) {
      // The salesperson's price wins over the split: the grid showed it, so the document carries
      // it. Absence — not a sentinel — is what "they left it alone" looks like, the same rule an
      // override on a formula cell follows. It is read off `raw`, because the price is not a
      // declared column and so never appears in the evaluated row.
      const typed = l.raw[PRICE_COL];
      const unitPrice =
        typeof typed === "number" && Number.isFinite(typed) && typed >= 0 ? typed : l.price / l.quantity;
      const line: Record<string, unknown> = {
        // the configurator's generic item stays the B1 item; the customer-facing code rides along
        // in a mapped UDF, so no article master has to be created per configuration.
        ItemCode: model.pricing.quoteItemCode,
        ItemDescription: desc,
        Quantity: l.quantity,
        UnitPrice: unitPrice,
      };
      for (const [col, field] of Object.entries(items.map ?? {})) {
        const v: Val | undefined = l.row[col];
        if (v !== undefined && v !== null) line[field] = v;
      }
      lines.push(line);
      // B1 re-derives LineTotal as round(Quantity * UnitPrice), so rounding the same way here is
      // what keeps DocTotal equal to the stored quotedValue. It used to follow from splitShares'
      // whole-cent guarantee; a hand-typed price moves the total, so that no longer covers it.
      value += round2(unitPrice * l.quantity);
    }
  }
  return { lines, value, cost };
}

/** Canonical Quotations draft: the lines above, plus the customer header. */
export function buildQuoteSeed(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): Record<string, unknown> {
  if (!project.customer) {
    throw new ORPCError("BAD_REQUEST", { message: "Customer is required before quoting" });
  }
  if (!project.selection?.length) {
    throw new ORPCError("BAD_REQUEST", { message: "Select at least one candidate before quoting" });
  }
  for (const s of project.selection) {
    if (!project.candidates[s.candidateIdx])
      throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
  }

  const seed: Record<string, unknown> = {
    CardCode: project.customer.cardCode,
    CardName: project.customer.cardName,
    DocumentLines: buildQuoteLines(project, model, lookups).lines,
  };
  const currency = model.pricing.currency;
  if (currency) seed.DocCurrency = currency;
  return seed;
}

/** Engineered value and cost of the selected candidates. Same builder as the lines, so the stored
 *  margin matches the quotation that was sent to the cent. */
export function quotedTotals(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups,
): { value: number; cost: number } {
  const { value, cost } = buildQuoteLines(project, model, lookups);
  return { value, cost };
}

/** Selection pairs must exist in the calculation and must not duplicate. */
export function validateSelectionPairs(
  candidates: ConfigCandidate[],
  selection: ConfigSelection[],
): void {
  const seen = new Set<string>();
  for (const s of selection) {
    const cand = candidates[s.candidateIdx];
    if (!cand || !cand.perBatch.some((b) => b.batchQty === s.batchQty)) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Selection does not match the calculated candidate/batch options",
      });
    }
    const key = `${s.candidateIdx}:${s.batchQty}`;
    if (seen.has(key)) {
      throw new ORPCError("BAD_REQUEST", { message: "Duplicate candidate/batch pair" });
    }
    seen.add(key);
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbOrTx = typeof db | Tx;

/** Reject update/calculate/select while quoted. */
export async function assertConfigMutable(
  tenantId: string,
  projectId: string,
  client: DbOrTx = db,
): Promise<void> {
  const [project] = await client
    .select({ status: configProject.status })
    .from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId)))
    .limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (project.status === "quoted") {
    throw new ORPCError("CONFLICT", { message: "Configuration is quoted and locked" });
  }
}
