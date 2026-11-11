import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { db, configProject, type ConfigCandidate, type ConfigSelection } from "@confire/db";
import {
  computeOutputs,
  ITEM_COL,
  DslError,
  itemsTableOf,
  missingInputs,
  pairMoney,
  propagate,
  type ModelDef,
  type Outputs,
  type ResolvedLookups,
  type TableRows,
  type Val,
} from "@confire/config-engine";
import { B1Error, escapeLiteral, rowsOf, type B1Transport } from "@confire/b1";
import { ENTITY_PROFILES } from "./entity-profiles.ts";
import { canonicalJson } from "./canon.ts";
import { quotationIn, tenantCompany, tenantConnector, tenantCurrency, viaB1 } from "./b1.ts";
import { liveEngine } from "./config-project.ts";
import { assertWritable, inputsOf, internalVisible, transition, quotedOrLater } from "./project-lifecycle.ts";
import { afterPost, type MailAnswer } from "./document-mail.ts";
import { t } from "./i18n/index.ts";

export type ConfigProjectRow = typeof configProject.$inferSelect;

/** UDF on OQUT carrying configDocumentCommandId, so a retried createQuote finds the quotation it
 *  already posted instead of posting a second one. Must exist in the customer's B1: Confire makes
 *  it once the agent answers (agent-pairing.ts ensureUdfs). */
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

/** Header fields the quote page may set on a configurator quotation. Read off the Quotations
 *  profile so the page's write allowlist and the entity page's cannot drift; deliberately NOT the
 *  profile's `editableCollections` or its `U_` escape hatch — DocumentLines come from the item
 *  matrix and U_CF_Key is the dedup key, both the server's alone. */
export const QUOTE_HEADER = new Set(ENTITY_PROFILES.Quotations!.editable);

/**
 * The quotation's DocumentLines and the engineered totals behind them, from the persisted project
 * and the model's live lookups. The server recomputes every price; the browser's figures are never
 * trusted.
 *
 * One selected (candidate, batch) pair is normally one line. With an items table it is n lines —
 * merge production yields several different items from one run, so the cost is joint and can only
 * be *split*, never computed per item. Each pair is priced by the engine's pairMoney, the same unit
 * the process page's Cost elements pane is drawn from, so the two cannot disagree.
 *
 * Several pairs are one offer at several quantities (or designs), not a sum: the first pair's lines
 * are regular and every later pair's are B1 alternative lines (`LineType: dlt_Alternative`), which
 * B1 leaves out of DocTotal. Pairs go in (candidate, batch) order — the commandId's — so the
 * smallest batch of the first pick is the regular one whatever order the picks were made in.
 * `value`/`cost` are the regular pair's alone, which keeps the stored `quotedValue` and the posted
 * DocTotal agreeing by construction.
 */
export function buildQuoteLines(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups, sapItems: SapItems = new Map(),
): { lines: Record<string, unknown>[]; value: number; cost: number } {
  const items = itemsTableOf(model);
  const lines: Record<string, unknown>[] = [];
  let value = 0;
  let cost = 0;
  let first = true;

  const pairs = [...(project.selection ?? [])].sort((a, b) => a.candidateIdx - b.candidateIdx || a.batchQty - b.batchQty);
  for (const s of pairs) {
    const cand = project.candidates[s.candidateIdx];
    if (!cand) continue;
    let pm;
    try {
      pm = pairMoney(model, lookups, cand.assignment, s.batchQty, project.tables);
    } catch (e) {
      if (e instanceof DslError || e instanceof RangeError) {
        throw new ORPCError("BAD_REQUEST", { message: e.message });
      }
      throw e;
    }
    // dlt_Regular is B1's default, so the regular pair sends no LineType and a one-pair quote is unchanged.
    const alt = first ? {} : { LineType: "dlt_Alternative" };
    if (first) { cost = pm.cost; value = pm.value; first = false; }

    const desc =
      Object.entries(cand.assignment)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ") || "Configuration";

    if (!pm.lines.length) {
      lines.push({ ItemCode: model.pricing.quoteItemCode, ItemDescription: desc, Quantity: s.batchQty, UnitPrice: pm.outputs.unitPrice, ...alt });
      continue;
    }
    for (const l of pm.lines) {
      // A row's code that is a SAP item is the line's item. Any other code is a part with no item
      // yet: the configurator's generic item is the B1 item and the code rides along in its mapped
      // UDF, so no article master has to be created per configuration.
      const item = sapItems.get(itemKey(l.row[ITEM_COL]));
      const line: Record<string, unknown> = {
        ItemCode: item ?? model.pricing.quoteItemCode,
        ItemDescription: desc,
        Quantity: l.quantity,
        // the salesperson's price wins over the split: the grid showed it, so the document carries it
        UnitPrice: l.unitPrice,
        ...alt,
      };
      for (const [col, field] of Object.entries(items?.map ?? {})) {
        if (item && col === ITEM_COL) continue;
        const v: Val | undefined = l.row[col];
        if (v !== undefined && v !== null) line[field] = v;
      }
      lines.push(line);
    }
  }
  return { lines, value, cost };
}

/** The items grid's codes that are SAP items, by `itemKey`, each as SAP spells it. */
export type SapItems = ReadonlyMap<string, string>;
const itemKey = (v: Val | undefined) => (typeof v === "string" ? v.trim().toUpperCase() : "");

/** Which of the grid's codes are SAP items: one `Items` read per distinct code, at quote time, since
 *  a code may be typed (or read off a drawing) for a part that has no item yet, and the masterdata
 *  cache is one filtered page of SAP, not its item master. Keyed case-blind, as SQL Server's
 *  collation matches, and answered in SAP's own spelling.
 *  ponytail: one call per code — a grid is a handful of parts; one `or` filter if they grow. */
export async function sapItemsOf(b1: B1Transport, project: ConfigProjectRow, model: ModelDef): Promise<SapItems> {
  const items = itemsTableOf(model);
  const codes = new Set((items ? project.tables[items.key] ?? [] : []).map((r) => r[ITEM_COL]).filter((v): v is string => !!itemKey(v)).map((v) => v.trim()));
  const found = await Promise.all([...codes].map(async (code) => {
    const res = await b1.readEntitySet("Items", { filter: `ItemCode eq '${escapeLiteral(code)}'`, select: ["ItemCode"], top: 1 });
    const hit = rowsOf(res.data)[0] as { ItemCode?: unknown } | undefined;
    return typeof hit?.ItemCode === "string" ? [[itemKey(code), hit.ItemCode] as const] : [];
  }));
  return new Map(found.flat());
}

/** Canonical Quotations draft: the lines above, plus the customer header.
 *
 *  `currency` is the tenant's B1 local currency (b1.ts' tenantCurrency), passed in rather than read
 *  here so this module stays free of db access. It is only a *default*: DocCurrency is in
 *  ENTITY_PROFILES.Quotations.editable and therefore in QUOTE_HEADER, and createQuote spreads the
 *  page's header patch over this seed — so a salesperson quoting a foreign-currency customer can
 *  still pick their currency in the quote page's value help. */
export function buildQuoteSeed(
  project: ConfigProjectRow, model: ModelDef, lookups: ResolvedLookups, currency?: string | null, sapItems?: SapItems,
): Record<string, unknown> {
  if (!project.customer) {
    throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_NEEDS_CUSTOMER") });
  }
  // The same check that hides the page's Create quote — the browser is not trusted to have done it.
  // A broken rule keeps the last prices on screen; it does not make them quotable.
  const prop = propagate(model, lookups, project.entries, project.tables);
  if (prop.conflicts.length)
    throw new ORPCError("BAD_REQUEST", { message: prop.conflicts.map((c) => c.message).join("; ") });
  const gaps = missingInputs(model, lookups, prop, project.tables);
  if (gaps.length)
    throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_INCOMPLETE", gaps.map((g) => g.message).join("; ")) });
  if (!project.selection?.length) {
    throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_NEEDS_SELECTION") });
  }
  for (const s of project.selection) {
    if (!project.candidates[s.candidateIdx])
      throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_NO_CANDIDATE", s.candidateIdx) });
  }

  const seed: Record<string, unknown> = {
    CardCode: project.customer.cardCode,
    CardName: project.customer.cardName,
    DocumentLines: buildQuoteLines(project, model, lookups, sapItems).lines,
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
        message: t("SELECTION_MISMATCH"),
      });
    }
    const key = `${s.candidateIdx}:${s.batchQty}`;
    if (seen.has(key)) {
      throw new ORPCError("BAD_REQUEST", { message: t("SELECTION_DUPLICATE") });
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
    if (!cand) throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_NO_CANDIDATE", s.candidateIdx) });
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
    throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_NEEDS_CALCULATION") });
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
  const done = quotedOrLater(project.status) && here;
  const replaces = !done && here ? project.b1DocEntry! : null;
  const { sapItems, docNum } = await viaB1(async () => {
    const { b1 } = await tenantConnector(tenantId);
    return {
      sapItems: await sapItemsOf(b1, project, model.definition),
      // The title names the quotation being updated by the number users know it by. Cosmetic:
      // a failed read falls back to the DocEntry rather than blocking the page.
      docNum: replaces === null ? null : await b1.readEntity("Quotations", replaces, { select: ["DocNum"] })
        .then((r) => Number((r.data as Record<string, unknown>).DocNum) || null, () => null),
    };
  });
  return {
    commandId: commandIdOf(tenantId, project, here),
    data: buildQuoteSeed(project, model.definition, lookups, await tenantCurrency(tenantId), sapItems),
    totals: quotedTotals(project, model.definition, lookups),
    quoted: done ? { docEntry: project.b1DocEntry!, quotedAt: project.quotedAt } : null,
    // A reopened project re-quotes its quotation (§7.3): the page says so before the user posts.
    replaces: replaces === null ? null : { docEntry: replaces, docNum },
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
      message: t("QUOTE_REQUOTE_NO_UDF", DEDUP_UDF),
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
  input: { projectId: string; commandId: string; header?: Record<string, unknown>; notify?: boolean },
) {
  // Refuse rather than silently write less than the page asked for — the same contract
  // entities.create honours. Checked before anything reaches SAP.
  const rejected = Object.keys(input.header ?? {}).filter((k) => !QUOTE_HEADER.has(k));
  if (rejected.length)
    throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_NOT_SETTABLE", rejected.join(", ")) });

  const project = await loadQuotable(tenantId, input.projectId);
  // One connector for the whole write: `here` is decided against the company its calls carry, so a
  // switch landing mid-way turns into the agent's 409, never a PATCH of another company's DocEntry.
  const conn = await tenantConnector(tenantId);
  const here = quotationIn(project, conn.companyDb);
  // Already posted: the row IS the idempotency record for a retry that got its response.
  // It sends nothing either: whichever call quoted it sent it then (document-mail spec §5.3).
  if (quotedOrLater(project.status) && here)
    return { docEntry: project.b1DocEntry!, docNum: null, reused: true, row: null, etag: null, mode: "created" as const, mail: null as MailAnswer };
  const actor = { userId, side: "internal" as const };
  await assertWritable(tenantId, project.id, actor);
  // The customer of a portal project is the company (spec §10) — the page cannot quote someone else.
  if (project.portalCardCode !== null && input.header?.CardCode !== undefined && input.header.CardCode !== project.customer?.cardCode)
    throw new ORPCError("BAD_REQUEST", { message: t("QUOTE_REQUEST_OWN_BP") });

  const commandId = commandIdOf(tenantId, project, here);
  if (commandId !== input.commandId)
    throw new ORPCError("CONFLICT", { message: t("QUOTE_STATE_CHANGED"), data: { reason: "STATE_CHANGED" } });

  const { model, lookups } = await liveEngine(tenantId, project);
  const { b1 } = conn;
  const seed = buildQuoteSeed(project, model.definition, lookups, await tenantCurrency(tenantId), await viaB1(() => sapItemsOf(b1, project, model.definition)));
  const totals = quotedTotals(project, model.definition, lookups);

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
          message: t("QUOTE_CHECK_NO_UDF", DEDUP_UDF, e.message),
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
      throw new ORPCError("BAD_GATEWAY", { message: t("QUOTE_NO_DOCENTRY") });
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
  // This call performed the transition, so it sends — its two `reused` paths included: they are
  // reached only when an earlier call failed before its transition, so nothing was sent then. A
  // re-quote in place sends the revised quotation. Only created has the document in hand.
  // A client's request never goes from the tenant's mailbox: the client hears by Confire's own mail
  // (the `quoted` event's notification) and answers in the portal. The workspace's Outlook is for an
  // internal configuration, whose conversation with the customer happens outside Confire.
  const mail = input.notify && project.portalCardCode === null ? await afterPost({
    tenantId, userId, b1, companyDb: conn.companyDb, entity: "Quotations",
    doc: posted.row ?? { DocEntry: posted.docEntry }, // the update and dedup paths: afterPost reads it
    projects: async () => [project.id],
  }) : null;
  return { ...posted, mail };
}
