import type { FormState, ModelDef, Notice } from "@confire/config-engine";
import { GENERAL_SECTION } from "@confire/ui/configurator/formHelpers.ts";
import type { PageMessage } from "@confire/ui/PageMessages.tsx";

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

/** A `missing` code in this page's words, and the field it jumps to. An unknown code reads as the
 *  server's English, so a code added there shows before this page learns it. */
function missingText(t: TextFn, m: Notice): { text: string; detail: string; anchor?: string } {
  const [a = "", b = "", c = ""] = m.params;
  switch (m.code) {
    case "name_required": return { text: t("CONFIG_ENTER_NAME"), detail: t("CONFIG_REQUIRED_OPEN"), anchor: "#cfg-name" };
    case "customer_required": return { text: t("CONFIG_PICK_BP"), detail: t("CONFIG_REQUIRED_OPEN"), anchor: "#cfg-customer" };
    case "batches_required": return { text: t("CONFIG_BATCHES_MISSING"), detail: t("CONFIG_REQUIRED_OPEN") };
    case "param_required": return { text: t("CONFIG_MISSING_PARAM", a), detail: t("CONFIG_REQUIRED_QUOTE") };
    case "table_empty": return { text: t("CONFIG_MISSING_ROWS", a), detail: t("CONFIG_REQUIRED_QUOTE") };
    case "cell_required": return { text: t("CONFIG_MISSING_CELLS", a, b, c), detail: t("CONFIG_REQUIRED_QUOTE") };
    default: return { text: m.message, detail: t("CONFIG_REQUIRED_QUOTE") };
  }
}

/** Everything the configuration has to say about itself, as one list for the title's message
 *  popover: what the server says is missing or worth knowing (in this page's language), the rules
 *  the inputs break, and whatever this page's own calls ran into. */
export function configMessages(a: {
  t: TextFn;
  model: ModelDef | undefined;
  /** the view's — every one of these is the server's */
  missing: Notice[];
  issues: Notice[];
  form: Pick<FormState, "conflicts" | "fields"> | null;
  calculation: { state: string; message?: string } | null;
  lookupsError?: Error | null;
  /** a sync the user asked for, that failed */
  syncError?: Error | null;
  /** the last edit: refused (reverted to what is stored) or not delivered (kept, for a retry) */
  writeError?: { refused: boolean; error: Error } | null;
  /** model switch / duplicate / delete / a request decision — every one that failed */
  configErrors?: (Error | null)[];
  /** read-only, and every action above is fenced server-side: an internal configuration once
   *  quoted, a client's request in every status but in review */
  locked: false | { request: boolean; status: string; quoteResponse?: string | null };
}): PageMessage[] {
  const out: PageMessage[] = [];
  const t = a.t;
  // A configuration message without a field of its own lands at the top of the page.
  const configure = { section: GENERAL_SECTION, group: t("CONFIG_SECTION_CONFIGURE") };
  const candidates = { section: "candidates", group: t("CONFIG_SECTION_CANDIDATES") };

  const lock = !a.locked ? undefined
    : !a.locked.request ? requestLock(t, "quoted")
    : requestLock(t, a.locked.quoteResponse === "accepted" ? "accepted" : a.locked.status === "quoted" ? "awaiting" : a.locked.status);
  if (lock) out.push({ id: "locked", type: "Information", ...lock, ...configure });

  // What the calculation and the quote wait on. Critical, not Negative: nothing is wrong yet.
  a.missing.forEach((m, i) => {
    const { text, detail, anchor } = missingText(t, m);
    out.push({
      id: `missing:${i}`, type: "Critical", text, detail, ...configure,
      anchor: anchor ?? (m.key ? `[data-param="${m.key}"]` : undefined),
    });
  });

  // A conflict names the parameters it involves; ConfiguratorForm tags each visible one with
  // `data-param` and marks it inline, so the jump goes to the first one actually drawn.
  (a.form?.conflicts ?? []).forEach((c, i) => {
    const key = c.params.find((k) => a.form!.fields[k]?.visible);
    out.push({
      id: `conflict:${i}`, type: "Negative", text: c.message,
      detail: c.params.length ? c.params.map((k) => labelOf(a.model, k)).join(", ") : undefined,
      ...configure, anchor: key ? `[data-param="${key}"]` : undefined,
    });
  });

  if (a.calculation?.state === "failed")
    out.push({ id: "calculation", type: "Negative", text: a.calculation.message ?? t("CONFIG_CALC_FAILED"), detail: t("CONFIG_CALC_FAILED"), ...configure });

  if (a.lookupsError)
    out.push({ id: "lookups", type: "Negative", text: a.lookupsError.message, detail: t("CONFIG_LOOKUPS_FAILED"), ...configure });
  if (a.writeError)
    out.push({
      id: "write", type: "Negative", text: a.writeError.error.message,
      detail: t(a.writeError.refused ? "CONFIG_CHANGE_REFUSED" : "CONFIG_CHANGE_UNSENT"), ...configure,
    });
  // Each failure its own message: one long-past error must not hide a newer one.
  (a.configErrors ?? []).forEach((e, i) => {
    if (e) out.push({ id: `config:${i}`, type: "Negative", text: e.message, detail: t("CONFIG_CHANGE_FAILED"), ...configure });
  });
  if (a.syncError)
    out.push({ id: "sync", type: "Negative", text: a.syncError.message, detail: t("CONFIG_SYNC_ERROR"), ...configure });

  const list = a.model?.pricing?.priceList;
  for (const m of a.issues) {
    const [p0 = "", p1 = "", p2 = ""] = m.params;
    const id = `${m.code}:${m.key ?? ""}:${p0}`;
    switch (m.code) {
      case "not_an_option":
        out.push({ id, type: "Critical", text: t("CONFIG_NOT_AN_OPTION", p0, p1), detail: t("CONFIG_NOT_AN_OPTION_DETAIL"), ...configure, anchor: `[data-param="${m.key}"]` });
        break;
      // Option lists come from a cache, so the page always renders — but it owes the user the truth
      // about the data: never synced is why the lists are empty; a failed sync does not block.
      case "sync_failed":
        out.push({ id, type: "Negative", text: t("CONFIG_SYNC_FAILED_TABLE", p0, p1), detail: Number(p2) ? t("CONFIG_SYNC_SHOWING", p2) : t("CONFIG_SYNC_NONE"), ...configure });
        break;
      case "sync_never":
        out.push({ id, type: "Critical", text: t("CONFIG_SYNC_NEVER", p0), detail: t("CONFIG_SYNC_NEVER_DETAIL"), ...configure });
        break;
      case "capped":
        out.push({ id, type: "Critical", text: t("CONFIG_CAPPED", p0), detail: p1 ? t("CONFIG_WIDEST", p1, p2) : undefined, ...candidates });
        break;
      // Critical, not Negative: the calculation went through, it priced these materials at 0.
      case "unpriced":
        out.push({ id, type: "Critical", text: list ? t("CONFIG_UNPRICED_LIST", p0, String(list)) : t("CONFIG_UNPRICED", p0), detail: t("CONFIG_UNPRICED_DETAIL"), ...candidates });
        break;
      default:
        out.push({ id, type: "Critical", text: m.message, ...configure });
    }
  }
  return out;
}
