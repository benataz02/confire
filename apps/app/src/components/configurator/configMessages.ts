import type { ModelDef, Propagation } from "@confire/config-engine";
import type { PageMessage } from "../PageMessages.tsx";

/** `(key, ...params)` — the caller's `i18n.getText`, so this stays pure and testable. */
export type TextFn = (key: string, ...params: string[]) => string;

const labelOf = (model: ModelDef | undefined, key: string) =>
  model?.parameters.find((p) => p.key === key)?.label ?? key;

type Lock = { text: string; detail: string };
/** Why a client's request is read-only, in its status's own words (spec §7). A quoted request reads
 *  the client's answer, so `accepted` stands in for quoted once they gave it. Statuses missing here
 *  are never read-only on this page. */
function requestLock(t: TextFn, status: string): Lock | undefined {
  switch (status) {
    case "quoted": return { text: t("CONFIG_LOCK_QUOTED"), detail: t("CONFIG_LOCK_QUOTED_DETAIL") };
    case "submitted": return { text: t("CONFIG_LOCK_SUBMITTED"), detail: t("CONFIG_LOCK_SUBMITTED_DETAIL") };
    case "returned": return { text: t("CONFIG_LOCK_RETURNED"), detail: t("CONFIG_LOCK_RETURNED_DETAIL") };
    case "declined": return { text: t("CONFIG_LOCK_DECLINED"), detail: t("CONFIG_LOCK_DECLINED_DETAIL") };
    case "awaiting": return { text: t("CONFIG_LOCK_AWAITING"), detail: t("CONFIG_LOCK_AWAITING_DETAIL") };
    case "accepted": return { text: t("CONFIG_LOCK_ACCEPTED"), detail: t("CONFIG_LOCK_ACCEPTED_DETAIL") };
    default: return undefined;
  }
}

/** Everything the configuration has to say about itself, as one list for the title's message
 *  popover: what blocks the calculation, what the engine could not reconcile, and whatever the
 *  last server round trip refused. */
export function configMessages(a: {
  t: TextFn;
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
  const configure = { section: "configure", group: a.t("CONFIG_SECTION_CONFIGURE") };
  const candidates = { section: "candidates", group: a.t("CONFIG_SECTION_CANDIDATES") };

  const lock = !a.locked ? undefined
    : !a.locked.request ? requestLock(a.t, "quoted")
    : requestLock(a.t, a.locked.quoteResponse === "accepted" ? "accepted" : a.locked.status === "quoted" ? "awaiting" : a.locked.status);
  if (lock) out.push({ id: "locked", type: "Information", ...lock, ...configure });

  // Two of the General fields the configurator waits for (batch quantities come through `missing`).
  // Critical, not Negative: nothing is wrong yet, the configuration just cannot start until they are filled.
  if (!a.name.trim())
    out.push({
      id: "name", type: "Critical", text: a.t("CONFIG_ENTER_NAME"),
      detail: a.t("CONFIG_REQUIRED_OPEN"), ...configure, anchor: "#cfg-name",
    });
  if (!a.customer)
    out.push({
      id: "customer", type: "Critical", text: a.t("CONFIG_PICK_BP"),
      detail: a.t("CONFIG_REQUIRED_OPEN"), ...configure, anchor: "#cfg-customer",
    });

  // Why Create quote has not appeared yet. Critical for the same reason as the two above.
  (a.missing ?? []).forEach((m, i) =>
    out.push({
      id: `missing:${i}`, type: "Critical", text: m.message,
      detail: a.t("CONFIG_REQUIRED_QUOTE"), ...configure, anchor: `[data-param="${m.key}"]`,
    }));

  // A conflict names the parameters it involves; ConfiguratorForm tags each visible one with
  // `data-param` and marks it inline, so the jump goes to the first one actually drawn.
  (a.prop?.conflicts ?? []).forEach((c, i) => {
    const key = c.params.find((k) => a.prop!.visible[k]);
    out.push({
      id: `conflict:${i}`, type: "Negative", text: c.message,
      detail: c.params.length ? c.params.map((k) => labelOf(a.model, k)).join(", ") : undefined,
      ...configure, anchor: key ? `[data-param="${key}"]` : undefined,
    });
  });

  if (a.lookupsError)
    out.push({
      id: "lookups", type: "Negative", text: a.lookupsError.message,
      detail: a.t("CONFIG_LOOKUPS_FAILED"), ...configure,
    });
  // Each failure its own message: one long-past error must not hide a newer one.
  (a.configErrors ?? []).forEach((e, i) => {
    if (e)
      out.push({
        id: `config:${i}`, type: "Negative", text: e.message,
        detail: a.t("CONFIG_CHANGE_FAILED"), ...configure,
      });
  });

  // Option lists come from a cache now, so the page always renders — but it owes the user the
  // truth about how old the data is. Never-synced is Critical (the lists are empty and that is
  // why); a failed sync is Negative but non-blocking; merely stale says nothing, because that is
  // what a sync frequency is for.
  for (const row of a.sync ?? []) {
    if (row.syncError)
      out.push({
        id: `sync:${row.table}`, type: "Negative", text: a.t("CONFIG_SYNC_FAILED_TABLE", row.table, row.syncError),
        detail: row.rowCount ? a.t("CONFIG_SYNC_SHOWING", String(row.rowCount)) : a.t("CONFIG_SYNC_NONE"),
        ...configure,
      });
    else if (!row.syncedAt)
      out.push({
        id: `sync:${row.table}`, type: "Critical", text: a.t("CONFIG_SYNC_NEVER", row.table),
        detail: a.t("CONFIG_SYNC_NEVER_DETAIL"),
        ...configure,
      });
  }
  if (a.syncError)
    out.push({
      id: "sync", type: "Negative", text: a.syncError.message,
      detail: a.t("CONFIG_SYNC_ERROR"), ...configure,
    });

  if (a.capped)
    out.push({
      id: "capped", type: "Critical",
      text: a.t("CONFIG_CAPPED", String(a.candidates)),
      detail: a.widest
        ? a.t("CONFIG_WIDEST", labelOf(a.model, a.widest.key), String(a.widest.size))
        : undefined,
      ...candidates,
    });
  // Critical, not Negative: the calculation went through, it just priced these materials at 0 —
  // every figure on the page is understated by them until the item gets a price and a sync.
  const list = a.model?.pricing?.priceList;
  for (const code of a.unpriced ?? [])
    out.push({
      id: `unpriced:${code}`, type: "Critical",
      text: list ? a.t("CONFIG_UNPRICED_LIST", code, String(list)) : a.t("CONFIG_UNPRICED", code),
      detail: a.t("CONFIG_UNPRICED_DETAIL"),
      ...candidates,
    });
  if (a.selectError)
    out.push({
      id: "select", type: "Negative", text: a.selectError.message, detail: a.t("CONFIG_SELECT_FAILED"),
      ...candidates,
    });

  return out;
}
