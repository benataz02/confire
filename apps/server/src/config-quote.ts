import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, configProject, type ConfigCandidate, type ConfigSelection } from "@confire/db";
import {
  bindings,
  computeOutputs,
  DslError,
  itemSplit,
  missingInputs,
  propagate,
  typedPrice,
  type ItemsTable,
  type ModelDef,
  type Outputs,
  type ResolvedLookups,
  type TableRows,
  type Val,
} from "@confire/config-engine";
import { B1Error, rowsOf, type B1Transport } from "@confire/b1";
import { ENTITY_PROFILES } from "./entity-profiles.ts";
import { canonicalJson } from "./canon.ts";
import { quotationIn, tenantCompany, tenantConnector, tenantCurrency, viaB1 } from "./b1.ts";
import { liveEngine } from "./config-project.ts";
import { assertWritable, inputsOf, internalVisible, transition } from "./project-lifecycle.ts";

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
  /** The quotation this one modifies or replaces (a reopened project, §7.3). Absent for a first
   *  quote, which keeps every key written before re-quotes existed. It is what stops the create
   *  path's pre-check from finding the closed quotation and reporting it as the new one. */
  replaces?: number;
}): string {
  // Sorted so a pure reorder of the same picks keeps the same id.
  const sel = [...input.selection]
    .sort((a, b) => a.candidateIdx - b.candidateIdx || a.batchQty - b.batchQty)
    .map((s) => ({
      assignment: input.candidates[s.candidateIdx]?.assignment ?? null,
      batchQty: s.batchQty,
    }));
  const raw = `${input.tenantId}|${input.projectId}|${canonicalJson({ sel, tables: input.tables, replaces: input.replaces })}`;
  return createHash("sha256").update(raw).digest("hex");
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
      out = computeOutputs(model, lookups, cand.assignment, s.batchQty, project.tables);
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
      // it. It is read off `raw`, because the price is not a declared column and so never appears
      // in the evaluated row.
      const unitPrice = typedPrice(l.raw) ?? l.price / l.quantity;
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

/** Canonical Quotations draft: the lines above, plus the customer header.
 *
 *  `currency` is the tenant's B1 local currency (b1.ts' tenantCurrency), passed in rather than read
 *  here so this module stays free of db access. It is only a *default*: DocCurrency is in
 *  ENTITY_PROFILES.Quotations.editable and therefore in QUOTE_HEADER, and createQuote spreads the
 *  page's header patch over this seed — so a salesperson quoting a foreign-currency customer can
 *  still pick their currency in the quote page's value help. */
export function buildQuoteSeed(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups, currency?: string | null,
): Record<string, unknown> {
  if (!project.customer) {
    throw new ORPCError("BAD_REQUEST", { message: "Customer is required before quoting" });
  }
  // The same check that hides the page's Create quote — the browser is not trusted to have done it.
  const gaps = missingInputs(model, lookups, propagate(model, lookups, project.entries, project.tables), project.tables);
  if (gaps.length)
    throw new ORPCError("BAD_REQUEST", { message: `Complete the configuration before quoting: ${gaps.map((g) => g.message).join("; ")}` });
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

export function applySelection(
  model: ModelDef, lookups: ResolvedLookups,
  candidates: ConfigCandidate[], selection: ConfigSelection[], tableRows?: TableRows,
): { candidateIdx: number; batchQty: number; outputs: Outputs }[] {
  return selection.map((s) => {
    const cand = candidates[s.candidateIdx];
    if (!cand) throw new ORPCError("BAD_REQUEST", { message: `No candidate at index ${s.candidateIdx}` });
    try {
      const outputs = computeOutputs(model, lookups, cand.assignment, s.batchQty, tableRows);
      return { candidateIdx: s.candidateIdx, batchQty: s.batchQty, outputs };
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) throw new ORPCError("BAD_REQUEST", { message: e.message });
      throw e;
    }
  });
}

// ---- Quotation write-back -------------------------------------------------------------------
// Numbers are recomputed from the persisted selection on both the draft and the post, so the
// browser can influence *which* selection is quoted (via commandId) and nothing else.

/** The project as staff may quote it: a client's draft does not exist for them. */
async function loadQuotable(tenantId: string, projectId: string) {
  const [project] = await db.select().from(configProject)
    .where(and(eq(configProject.id, projectId), eq(configProject.tenantId, tenantId), internalVisible)).limit(1);
  if (!project) throw new ORPCError("NOT_FOUND");
  if (!project.candidates.length)
    throw new ORPCError("BAD_REQUEST", { message: "Calculate the configuration before quoting" });
  return project;
}

/** `here`: the project's quotation is in the company this quote goes to (quotationIn). Only then is
 *  there a quotation to modify or replace; in another company the quote is a first one. */
const commandIdOf = (tenantId: string, p: ConfigProjectRow, here: boolean) => configDocumentCommandId({
  tenantId, projectId: p.id, candidates: p.candidates, selection: p.selection ?? [], tables: p.tables,
  replaces: here ? p.b1DocEntry! : undefined,
});

export async function quoteDraft(tenantId: string, projectId: string) {
  const project = await loadQuotable(tenantId, projectId);
  const { model, lookups } = await liveEngine(tenantId, project);
  const here = quotationIn(project, await tenantCompany(tenantId));
  const done = project.status === "quoted" && here;
  return {
    commandId: commandIdOf(tenantId, project, here),
    data: buildQuoteSeed(project, model.definition, lookups, await tenantCurrency(tenantId)),
    totals: quotedTotals(project, model.definition, lookups),
    quoted: done ? { docEntry: project.b1DocEntry!, quotedAt: project.quotedAt } : null,
    // A reopened project re-quotes its quotation (§7.3): the page says so before the user posts.
    replaces: !done && here ? { docEntry: project.b1DocEntry! } : null,
    portal: project.portalCardCode !== null,
    name: project.name, // the page's breadcrumb back to the configuration
  };
}

/** The current quotation as the re-quote needs it. Read whole: one document, and $select on the
 *  DocumentLines collection is not something to bet a write on. */
async function readQuotation(b1: B1Transport, docEntry: number) {
  const res = await b1.readEntity("Quotations", docEntry);
  const row = res.data as Record<string, unknown>;
  if (!(DEDUP_UDF in row))
    throw new ORPCError("BAD_REQUEST", {
      message: `Cannot re-quote safely: ${DEDUP_UDF} is missing from Sales Quotation in SAP. Create it (alphanumeric, length 64) and try again.`,
    });
  const lines = (row.DocumentLines as Record<string, unknown>[] | undefined) ?? [];
  return {
    row, etag: res.etag,
    key: row[DEDUP_UDF] as string | null,
    // ponytail: unverified (spec §16) — a quotation whose lines were partly copied to an order may
    // still say bost_Open, so a closed line counts as closed too. Check both against a live B1.
    open: row.DocumentStatus === "bost_Open" && lines.every((l) => l.LineStatus !== "bost_Close"),
  };
}

export async function createQuote(
  tenantId: string,
  userId: string,
  input: { projectId: string; commandId: string; header?: Record<string, unknown> },
) {
  // Refuse rather than silently write less than the page asked for — the same contract
  // entities.create honours. Checked before anything reaches SAP.
  const rejected = Object.keys(input.header ?? {}).filter((k) => !QUOTE_HEADER.has(k));
  if (rejected.length)
    throw new ORPCError("BAD_REQUEST", { message: `Not settable on a quotation: ${rejected.join(", ")}` });

  const project = await loadQuotable(tenantId, input.projectId);
  // One connector for the whole write: `here` is decided against the company its calls carry, so a
  // switch landing mid-way turns into the agent's 409, never a PATCH of another company's DocEntry.
  const conn = await tenantConnector(tenantId);
  const here = quotationIn(project, conn.companyDb);
  // Already posted: the row IS the idempotency record for a retry that got its response.
  if (project.status === "quoted" && here)
    return { docEntry: project.b1DocEntry!, docNum: null, reused: true, row: null, etag: null, mode: "created" as const };
  const actor = { userId, side: "internal" as const };
  await assertWritable(tenantId, project.id, actor);
  // The customer of a portal project is the company (spec §10) — the page cannot quote someone else.
  if (project.portalCardCode !== null && input.header?.CardCode !== undefined && input.header.CardCode !== project.customer?.cardCode)
    throw new ORPCError("BAD_REQUEST", { message: "A request is quoted to the client's own business partner" });

  const commandId = commandIdOf(tenantId, project, here);
  if (commandId !== input.commandId)
    throw new ORPCError("CONFLICT", { message: "STATE_CHANGED" });

  const { model, lookups } = await liveEngine(tenantId, project);
  const seed = buildQuoteSeed(project, model.definition, lookups, await tenantCurrency(tenantId));
  const totals = quotedTotals(project, model.definition, lookups);
  const { b1 } = conn;

  const posted = await viaB1(async () => {
    const current = here ? await readQuotation(b1, project.b1DocEntry!) : null;

    if (current?.open) {
      // Re-quote an open quotation in place. The same check-then-create, applied to an update: a
      // retry after a lost response finds its own key already written.
      const done = { docEntry: project.b1DocEntry!, docNum: Number(current.row.DocNum ?? 0) || null, reused: true, row: null, etag: null, mode: "updated" as const };
      if (current.key === commandId) return done;
      // CardCode/CardName stay out: the business partner of a quotation does not change on a
      // re-quote, and asking B1 to "change" it to itself is not a request worth risking.
      const { CardCode: _c, CardName: _n, ...body } = { ...seed, ...(input.header ?? {}) };
      try {
        // ponytail: unverified (spec §16) — that B1S-ReplaceCollectionsOnPatch deletes the lines
        // it was not sent, and that U_CF_Key can be rewritten in the same PATCH.
        await b1.updateEntity("Quotations", project.b1DocEntry!, { ...body, [DEDUP_UDF]: commandId },
          { etag: current.etag, replaceCollections: true });
      } catch (e) {
        // 412: the ETag moved. If it moved because our own PATCH landed and the answer was lost,
        // the key says so; anyone else's edit is a real conflict.
        if (!(e instanceof B1Error && e.status === 412)) throw e;
        if ((await readQuotation(b1, project.b1DocEntry!)).key !== commandId) throw e;
      }
      return { ...done, reused: false };
    }

    // Create: a first quote, or a new quotation replacing one B1 has closed. Check-then-create
    // against the dedup UDF covers the window the DB cannot: we POSTed, B1 created the quotation,
    // and our response never arrived. The closed predecessor is excluded by DocEntry as well as by
    // the key (`replaces` is in it): a modify may have written this very key onto it.
    const filter = `${DEDUP_UDF} eq '${commandId}'${here ? ` and DocEntry ne ${project.b1DocEntry}` : ""}`;
    const existing = await b1.readEntitySet("Quotations", { filter, select: ["DocEntry", "DocNum"], top: 1 }).catch((e) => {
      // Only a 400 means "no such property"; an unreachable agent or a rejected session is a
      // different problem and must keep its own status rather than becoming setup advice.
      if (e instanceof B1Error && e.status === 400)
        throw new ORPCError("BAD_REQUEST", {
          message: `Cannot check for an existing quotation: ${DEDUP_UDF} is missing from Sales Quotation in SAP. Create it (alphanumeric, length 64) and try again. (${e.message})`,
        });
      throw e;
    });
    const prior = rowsOf(existing.data)[0];

    // createEntity answers with the document itself (Prefer: return-representation), not a
    // collection — so this is `.data`, not `rowsOf(.data)[0]`.
    // ponytail: unverified (spec §16) — that B1 accepts a Sales Quotation for a lead (cLid).
    const created = prior ? null : await b1.createEntity("Quotations", {
      ...seed,
      // The page's patch lands over the seed — CardCode, currency and the dates are correctable
      // there — but QUOTE_HEADER keeps DocumentLines and the dedup key out of it, so the lines
      // still come from the item matrix and the key is still ours.
      ...(input.header ?? {}),
      [DEDUP_UDF]: commandId,
    }, { prefer: "representation" });
    const doc = (prior ?? created?.data ?? {}) as Record<string, unknown>;
    const docEntry = Number(doc.DocEntry);
    if (!Number.isFinite(docEntry))
      throw new ORPCError("BAD_GATEWAY", { message: "SAP created the quotation but returned no DocEntry" });
    return {
      docEntry,
      docNum: doc.DocNum === undefined ? null : Number(doc.DocNum),
      reused: !!prior,
      // The representation is the same document entities.one would read back, ETag and all, so
      // the browser seeds that query from here and opens the quotation without a second Service
      // Layer round trip. Null on the dedup path — that read selected two fields, not a document.
      row: created ? doc : null,
      etag: created?.etag ?? null,
      mode: "created" as const,
    };
  });

  const now = new Date();
  await transition({
    tenantId, projectId: project.id, action: "quote", actor,
    payload: (row) => ({
      docEntry: posted.docEntry, docNum: posted.docNum, value: totals.value, mode: posted.mode, inputs: inputsOf(row),
      company: conn.companyDb,
    }),
    set: {
      b1DocEntry: posted.docEntry, b1Company: conn.companyDb, quotedAt: now,
      quotedValue: totals.value.toFixed(4), quotedCost: totals.cost.toFixed(4),
    },
  });
  return posted;
}
