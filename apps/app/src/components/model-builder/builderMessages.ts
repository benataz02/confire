import { isTableGroup, type Issue, type ModelDef } from "@confire/config-engine";
import type { PageMessage } from "@confire/ui/PageMessages.tsx";
import type { RecordIssues, RecordMessage } from "@confire/ui/object-page/useObjectRecord.ts";
import type { Row } from "@confire/ui/types.ts";
import { constraintAt, defOf } from "../../features/model/record.ts";
import { issueText } from "./exprHelpers.ts";

export const issueFor = (issues: Issue[], path: string) => issues.find((i) => i.path === path);

/** `i18n.getText`, passed in so this module stays free of the bundle. */
export type Translate = (key: string, ...params: string[]) => string;

/** Bundle text, or the English `fallback` while the bundle is still loading — a default written
 *  onto the model must not be the raw key. */
export function copy(t: Translate, key: string, fallback: string): string {
  const v = t(key);
  return v && v !== key ? v : fallback;
}

/** The section an issue path belongs to. BOM and routing share Item Structure, and tables live in
 *  the structure tree on Parameters, so every one of those lands there. */
export function sectionOf(path: string): string {
  if (path.startsWith("parameters") || path.startsWith("structure") || path.startsWith("computed")
      || path.startsWith("tables") || path === "model")
    return "params";
  if (path.startsWith("constraints")) return "rules";
  if (path.startsWith("bom") || path.startsWith("routing")) return "outputs";
  if (path.startsWith("history")) return "history";
  return "settings"; // pricing.*
}

/** The tree row a table is placed on — `rowKeyOf({ kind: "table" })`, which is an index pair. */
function tableRow(draft: ModelDef, key: string): string | undefined {
  for (const [s, sec] of draft.structure.sections.entries())
    for (const [g, grp] of sec.groups.entries())
      if (isTableGroup(grp) && grp.table === key) return `[data-key="t:${s}.${g}"]`;
  return undefined;
}

/** The tree row an issue about a parameter, a table or a formula points at, or undefined when the
 *  section itself is as close as we get. An anchor that turns out not to be rendered is fine too:
 *  the message leaves the user on the right tab. */
export function anchorOf(path: string, draft: ModelDef): string | undefined {
  // Parameters and tables are edited on a page of their own, so the tree row that opens it is the target.
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
  if (/^computed\[\d+\]\.expr$/.test(path)) return `[id="expr-${path}"]`;
  return undefined; // model / structure / tables — the section is the answer
}

// A grid's cell in an issue path: `bom[2].qty`, `history.mappings[0]` (the mapping as a whole sits
// on its parameter).
const CELL = /^(bom|routing|history\.mappings)\[(\d+)\](?:\.(\w+))?$/;
const RULE = /^constraints\[(\d+)\](?:\.(when|assert|message))?/;

/** The model record's own rules — checkModel's issues (`issues`, over `defOf(r)`) plus the one it
 *  has no opinion about, the name — mapped onto the page: a field's to its field, a grid's to its
 *  cell, everything about parameters, tables and structure to the Parameters section. */
export function modelIssues(r: Row, issues: Issue[], t: Translate): RecordIssues {
  const fields: Record<string, string> = {};
  const cells: Record<string, Record<string, string>> = {};
  const other: RecordMessage[] = [];
  const draft = defOf(r);
  const cell = (table: string, row: number, col: string, text: string) => {
    (cells[table] ??= {})[`${row}:${col}`] ??= text;
  };
  if (!String(r.name ?? "").trim()) fields.name = t("MODEL_NAME_REQUIRED");
  issues.forEach((issue, i) => {
    const c = CELL.exec(issue.path);
    if (c) {
      const [, table = "", row = "0", col = "param"] = c;
      const line = ((r[table] as Row[] | undefined) ?? [])[Number(row)];
      return cell(table, Number(row), col, issueText(issue, String(line?.[col] ?? ""), t));
    }
    const rule = RULE.exec(issue.path);
    if (rule) {
      const at = constraintAt(r, Number(rule[1]));
      // A combination table's params and rows have no field here: the list is where it is fixed.
      if (at.table === "constraints" && rule[2]) {
        const line = (r.constraints as Row[])[at.row];
        return cell("constraints", at.row, rule[2], issueText(issue, String(line?.[rule[2]] ?? ""), t));
      }
      return other.push({ id: `${issue.path}:${i}`, text: issue.message, detail: issue.path, section: "rules" });
    }
    if (issue.path.startsWith("history.display")) return void (fields["history.display"] ??= issue.message);
    if (issue.path in r) return void (fields[issue.path] ??= issueText(issue, String(r[issue.path] ?? ""), t));
    other.push({ id: `${issue.path}:${i}`, text: issue.message, detail: issue.path, section: sectionOf(issue.path), anchor: anchorOf(issue.path, draft) });
  });
  return { fields, cells, other };
}

/** What the builder says beside the record's own problems: a failed read, a stale preview, a
 *  refused Delete or Duplicate, the issues the server refused the last Save with. */
export function builderMessages(a: {
  /** checkModel's issues for the record on screen — while there are any, the preview lags */
  issues: Issue[];
  /** the record's issues are on screen (a saved model, or a new one after its first Save) */
  shown: boolean;
  /** duplicate/delete refusal — the server knows things the confirm dialog cannot */
  actionError?: Error | null;
  /** the preview's value help could not be resolved (agent offline, broken query) */
  lookupsError?: Error | null;
  t: Translate;
  /** a section id → its title */
  title: (section: string) => string;
}): PageMessage[] {
  const { t } = a;
  const out: PageMessage[] = [];
  if (a.lookupsError)
    out.push({
      id: "lookups", type: "Negative", text: a.lookupsError.message, detail: t("MODEL_LOOKUPS_FAILED"),
      group: a.title("params"), section: "params",
    });
  // The preview falls back to the last valid model while there are errors; without saying so it
  // would just stop tracking the edits mid-typing.
  if (a.shown && a.issues.length)
    out.push({
      id: "preview", type: "Critical",
      text: t(a.issues.length === 1 ? "MODEL_PREVIEW_STALE" : "MODEL_PREVIEW_STALE_N", String(a.issues.length)),
      group: a.title("params"), section: "params",
    });
  if (a.actionError)
    out.push({ id: "action", type: "Negative", text: a.actionError.message, detail: t("MODEL_ACTION_FAILED"), group: t("MODEL_GROUP_MODEL") });
  return out;
}
