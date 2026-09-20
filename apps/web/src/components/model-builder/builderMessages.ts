import { isTableGroup, type Issue, type ModelDef } from "@confire/config-engine";
import type { PageMessage } from "../PageMessages.tsx";

/** The ObjectPageSection an issue path belongs to. BOM and routing share Item Structure, and
 *  tables live in the structure tree on Parameters, so every one of those lands there. */
export function sectionOf(path: string): string {
  if (path.startsWith("parameters") || path.startsWith("structure") || path.startsWith("computed")
      || path.startsWith("tables") || path === "model")
    return "params";
  if (path.startsWith("constraints")) return "rules";
  if (path.startsWith("bom") || path.startsWith("routing")) return "outputs";
  if (path.startsWith("history")) return "history";
  return "settings"; // pricing.*
}

/** Section id -> tab label. The page titles its tabs from this too, so a message's group header and
 *  the tab it jumps to cannot drift apart. */
export const SECTION_TITLE: Record<string, string> = {
  settings: "Settings", params: "Parameters", rules: "Rules",
  outputs: "Item Structure", history: "History",
};

const expr = (path: string) => `[id="expr-${path}"]`;

/** The tree row a table is placed on — `rowKeyOf({ kind: "table" })`, which is an index pair. */
function tableRow(draft: ModelDef, key: string): string | undefined {
  for (const [s, sec] of draft.structure.sections.entries())
    for (const [g, grp] of sec.groups.entries())
      if (isTableGroup(grp) && grp.table === key) return `[data-key="t:${s}.${g}"]`;
  return undefined;
}

/** The control an issue points at, or undefined when the section itself is as close as we get.
 *  Undefined is fine, and so is an anchor that turns out not to be rendered: PageMessages gives up
 *  on one it cannot find and leaves the user on the right tab. */
export function anchorOf(path: string, draft: ModelDef): string | undefined {
  // Parameters and tables are edited in a dialog, so the tree row that opens it is the target.
  const p = /^parameters\[(\d+)\]/.exec(path);
  if (p) {
    const key = draft.parameters[Number(p[1])]?.key;
    return key ? `[data-key="p:${key}"]` : undefined;
  }
  const t = /^tables\[(\d+)\]/.exec(path);
  if (t) {
    const key = (draft.tables ?? [])[Number(t[1])]?.key;
    return key ? tableRow(draft, key) : undefined;
  }
  // A constraint's `params[j]`/`rows[j]` have no field of their own; its condition is the row.
  const c = /^constraints\[(\d+)\](?:\.(when|assert))?/.exec(path);
  if (c) return expr(`constraints[${c[1]}].${c[2] ?? "when"}`);
  if (path === "pricing.priceExpr" || /^(computed|bom|routing)\[\d+\]\.\w+$/.test(path)) return expr(path);
  if (path === "pricing.priceList") return '[id="field-pricing.priceList"]';
  return undefined; // model / structure / tables / history.* — the section is the answer
}

/** Everything the builder has to say about the draft, as one list for the title's message popover.
 *  Anything that blocks the Save button is in here: an invalid model is a checkModel issue, and the
 *  one blocker checkModel has no opinion about is the empty name. */
export function builderMessages(a: {
  draft: ModelDef;
  /** checkModel's issues plus whatever the server rejected the last save with */
  issues: Issue[];
  saveError?: Error | null;
  /** duplicate/delete refusal — the server knows things the confirm dialog cannot */
  actionError?: Error | null;
  /** the preview's value help could not be resolved (agent offline, broken query) */
  lookupsError?: Error | null;
}): PageMessage[] {
  const out: PageMessage[] = [];

  if (!a.draft.name.trim())
    out.push({
      id: "name", type: "Negative", text: "Enter a model name",
      detail: "A model cannot be saved unnamed.",
      group: SECTION_TITLE.settings!, section: "settings", anchor: "#model-name",
    });

  a.issues.forEach((issue, i) => {
    const section = sectionOf(issue.path);
    out.push({
      id: `${issue.path}:${i}`, type: "Negative", text: issue.message, detail: issue.path,
      group: SECTION_TITLE[section]!, section, anchor: anchorOf(issue.path, a.draft),
    });
  });

  if (a.lookupsError)
    out.push({
      id: "lookups", type: "Negative", text: a.lookupsError.message,
      detail: "Option lists could not be loaded",
      group: SECTION_TITLE.params!, section: "params",
    });

  // The preview falls back to the last valid draft while the model has errors; without saying so it
  // would just stop tracking the edits mid-typing with no explanation.
  if (a.issues.length)
    out.push({
      id: "preview", type: "Critical",
      text: `Preview shows the last valid version — fix ${a.issues.length} error${a.issues.length === 1 ? "" : "s"} to preview the current draft.`,
      group: SECTION_TITLE.params!, section: "params",
    });

  // No section: these are about the model as a whole, so there is nowhere to jump.
  if (a.saveError)
    out.push({ id: "save", type: "Negative", text: a.saveError.message, detail: "Save failed", group: "Model" });
  if (a.actionError)
    out.push({ id: "action", type: "Negative", text: a.actionError.message, detail: "Action failed", group: "Model" });

  return out;
}
