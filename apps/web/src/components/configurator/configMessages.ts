import type { ModelDef, Propagation } from "@confire/config-engine";
import type { PageMessage } from "../PageMessages.tsx";

/** The two ObjectPageSections ConfigProcessPage draws, and their titles. */
const CONFIGURE = { section: "configure", group: "Configure" } as const;
const CANDIDATES = { section: "candidates", group: "Candidates" } as const;

/** propagate() reports a conflict against `parameters.<key>` or `constraints[i]`. Only the first
 *  has a control on this page — ConfiguratorForm tags every one with `data-param`. */
const conflictParam = (path: string) => /^parameters\.(.+)$/.exec(path)?.[1];

const labelOf = (model: ModelDef | undefined, key: string) =>
  model?.parameters.find((p) => p.key === key)?.label ?? key;

type Lock = { text: string; detail: string };
const QUOTED: Lock = { text: "Quoted — this configuration is read-only", detail: "The quotation it produced is what SAP holds now." };
/** Why a client's request is read-only, in its status's own words (spec §7). A quoted request reads
 *  the client's answer, so `accepted` stands in for quoted once they gave it. Statuses missing here
 *  are never read-only on this page. */
const REQUEST_LOCK: Record<string, Lock> = {
  submitted: { text: "Accept the request to edit it", detail: "It stays exactly as the client submitted it until someone takes it into review." },
  returned: { text: "With the client for changes", detail: "The client edits it now; it comes back when they resubmit." },
  declined: { text: "Declined — this request is closed", detail: "Nothing can change on it any more." },
  quoted: { text: "Quoted — waiting for the client's answer", detail: "A decline reopens the request in review." },
  accepted: { text: "Quote accepted by the client", detail: "Create the sales order in SAP from the quotation." },
};

/** Everything the configuration has to say about itself, as one list for the title's message
 *  popover: what blocks the calculation, what the engine could not reconcile, and whatever the
 *  last server round trip refused. */
export function configMessages(a: {
  model: ModelDef | undefined;
  name: string;
  /** a cardCode is set — a half-filled customer is not one */
  customer: boolean;
  prop: Propagation | null;
  /** what the quote still waits on — missingInputs plus the batch quantities, keyed by data-param */
  missing?: { key: string; message: string }[];
  candidates: number;
  capped: boolean;
  widest?: { key: string; size: number };
  lookupsError?: Error | null;
  /** per-table freshness from configs.lookups — the data is cached, so "old" and "never synced"
   *  are states the page has to be able to say out loud */
  sync?: { table: string; syncedAt: string | Date | null; syncError: string | null; rowCount: number }[];
  /** a sync the user asked for, that failed */
  syncError?: Error | null;
  /** BOM item codes the calculation costed at 0 — see unpricedItems */
  unpriced?: string[];
  /** update / calculate / duplicate / delete / a request decision — every one that failed */
  configErrors?: (Error | null)[];
  selectError?: Error | null;
  /** read-only, and every action above is fenced server-side: an internal configuration once
   *  quoted, a client's request in every status but in review */
  locked: false | { request: boolean; status: string; quoteResponse?: string | null };
}): PageMessage[] {
  const out: PageMessage[] = [];

  const lock = !a.locked ? undefined
    : !a.locked.request ? QUOTED
    : REQUEST_LOCK[a.locked.quoteResponse === "accepted" ? "accepted" : a.locked.status];
  if (lock) out.push({ id: "locked", type: "Information", ...lock, ...CONFIGURE });

  // Two of the General fields the configurator waits for (batch quantities come through `missing`).
  // Critical, not Negative: nothing is wrong yet, the configuration just cannot start until they are filled.
  if (!a.name.trim())
    out.push({
      id: "name", type: "Critical", text: "Enter a name",
      detail: "Required before the configurator opens.", ...CONFIGURE, anchor: "#cfg-name",
    });
  if (!a.customer)
    out.push({
      id: "customer", type: "Critical", text: "Pick a business partner",
      detail: "Required before the configurator opens.", ...CONFIGURE, anchor: "#cfg-customer",
    });

  // Why Create quote has not appeared yet. Critical for the same reason as the two above.
  (a.missing ?? []).forEach((m, i) =>
    out.push({
      id: `missing:${i}`, type: "Critical", text: m.message,
      detail: "Required before the configuration can be quoted.", ...CONFIGURE, anchor: `[data-param="${m.key}"]`,
    }));

  (a.prop?.conflicts ?? []).forEach((c, i) => {
    const key = conflictParam(c.path);
    out.push({
      id: `conflict:${i}`, type: "Negative", text: c.message,
      detail: key ? labelOf(a.model, key) : c.path,
      ...CONFIGURE, anchor: key ? `[data-param="${key}"]` : undefined,
    });
  });

  if (a.lookupsError)
    out.push({
      id: "lookups", type: "Negative", text: a.lookupsError.message,
      detail: "Option lists could not be loaded", ...CONFIGURE,
    });
  // Each failure its own message: one long-past error must not hide a newer one.
  (a.configErrors ?? []).forEach((e, i) => {
    if (e)
      out.push({
        id: `config:${i}`, type: "Negative", text: e.message,
        detail: "The last change did not go through", ...CONFIGURE,
      });
  });

  // Option lists come from a cache now, so the page always renders — but it owes the user the
  // truth about how old the data is. Never-synced is Critical (the lists are empty and that is
  // why); a failed sync is Negative but non-blocking; merely stale says nothing, because that is
  // what a sync frequency is for.
  for (const t of a.sync ?? []) {
    if (t.syncError)
      out.push({
        id: `sync:${t.table}`, type: "Negative", text: `'${t.table}' could not be refreshed: ${t.syncError}`,
        detail: t.rowCount ? `Showing the ${t.rowCount} rows from the last good sync.` : "No data has been cached yet.",
        ...CONFIGURE,
      });
    else if (!t.syncedAt)
      out.push({
        id: `sync:${t.table}`, type: "Critical", text: `'${t.table}' has not been synced yet`,
        detail: "Its options are empty until the first sync finishes. Press Sync data.",
        ...CONFIGURE,
      });
  }
  if (a.syncError)
    out.push({
      id: "sync", type: "Negative", text: a.syncError.message,
      detail: "Sync failed", ...CONFIGURE,
    });

  if (a.capped)
    out.push({
      id: "capped", type: "Critical",
      text: `Stopped at ${a.candidates} candidates — set more parameters`,
      detail: a.widest
        ? `${labelOf(a.model, a.widest.key)} is widest with ${a.widest.size} options`
        : undefined,
      ...CANDIDATES,
    });
  // Critical, not Negative: the calculation went through, it just priced these materials at 0 —
  // every figure on the page is understated by them until the item gets a price and a sync.
  const list = a.model?.pricing?.priceList;
  for (const code of a.unpriced ?? [])
    out.push({
      id: `unpriced:${code}`, type: "Critical",
      text: `No price for ${code} in ${list ? `price list ${list}` : "the price list"}`,
      detail: "Its material is costed at 0 until the item has a price and the data is synced.",
      ...CANDIDATES,
    });
  if (a.selectError)
    out.push({
      id: "select", type: "Negative", text: a.selectError.message, detail: "Selection not saved",
      ...CANDIDATES,
    });

  return out;
}
