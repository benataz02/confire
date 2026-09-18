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

/** Everything the configuration has to say about itself, as one list for the title's message
 *  popover: what blocks the calculation, what the engine could not reconcile, and whatever the
 *  last server round trip refused. */
export function configMessages(a: {
  model: ModelDef | undefined;
  name: string;
  /** a cardCode is set — a half-filled customer is not one */
  customer: boolean;
  prop: Propagation | null;
  candidates: number;
  capped: boolean;
  widest?: { key: string; size: number };
  lookupsError?: Error | null;
  /** update / calculate / duplicate / delete — whichever failed last */
  configError?: Error | null;
  selectError?: Error | null;
  /** quoted: the page is read-only and every action above is fenced server-side */
  locked: boolean;
}): PageMessage[] {
  const out: PageMessage[] = [];

  if (a.locked)
    out.push({
      id: "locked", type: "Information", text: "Quoted — this configuration is read-only",
      detail: "The quotation it produced is what SAP holds now.", ...CONFIGURE,
    });

  // The same two the footer gates Calculate on. Critical, not Negative: nothing is wrong yet, the
  // configuration just cannot run until they are filled.
  if (!a.name.trim())
    out.push({
      id: "name", type: "Critical", text: "Enter a name",
      detail: "Required before the configuration can calculate.", ...CONFIGURE, anchor: "#cfg-name",
    });
  if (!a.customer)
    out.push({
      id: "customer", type: "Critical", text: "Pick a business partner",
      detail: "Required before the configuration can calculate.", ...CONFIGURE, anchor: "#cfg-customer",
    });

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
  if (a.configError)
    out.push({
      id: "config", type: "Negative", text: a.configError.message,
      detail: "The last change did not go through", ...CONFIGURE,
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
  if (a.selectError)
    out.push({
      id: "select", type: "Negative", text: a.selectError.message, detail: "Selection not saved",
      ...CANDIDATES,
    });

  return out;
}
