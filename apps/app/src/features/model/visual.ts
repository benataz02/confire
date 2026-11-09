import { checkModel, VISUALS, type ModelDef, type Visual, type VisualCalc } from "@confire/config-engine";
import type { RecordIssues } from "@confire/ui/object-page/useObjectRecord.ts";
import type { Row, Section } from "@confire/ui/types.ts";
import { issueText, type TableCols } from "../../components/model-builder/exprHelpers.ts";
import { keyProblem } from "./table.ts";

// One tenant visual of the open model, as a record of its own: key, title, kind, and one formula per
// input as a flat `inputs.<name>` key (the model record's flat keys: checkModel's issue paths).
// Placement is the structure tree's job. Spec: docs/superpowers/specs/2026-11-09-tenant-visuals-design.md.

type Translate = (key: string, ...params: string[]) => string;

const INPUT = "inputs.";

export function toVisualRecord(v: Visual): Row {
  return {
    key: v.key, kind: v.kind,
    ...(v.title ? { title: v.title } : {}),
    ...Object.fromEntries(Object.entries(v.inputs).map(([name, src]) => [`${INPUT}${name}`, src])),
  };
}

/** The visual a record holds. A known kind keeps only its own inputs, so switching the kind leaves
 *  no stale formula behind. */
export function fromVisualRecord(r: Row): Visual {
  const kind = String(r.kind ?? "");
  const declared = VISUALS[kind]?.inputs;
  const inputs: Record<string, string> = {};
  for (const [k, src] of Object.entries(r)) {
    if (!k.startsWith(INPUT) || typeof src !== "string") continue;
    const name = k.slice(INPUT.length);
    if (!declared || Object.hasOwn(declared, name)) inputs[name] = src;
  }
  const title = typeof r.title === "string" && r.title ? r.title : undefined;
  return { key: String(r.key ?? ""), kind, ...(title ? { title } : {}), inputs };
}

/** Definition, Inputs and Outputs (a template: the names formulas read). Inputs are declared for
 *  every kind the workspace may pick, each field shown while the record's kind declares it — so a
 *  kind switch shows its own inputs at once. */
export function visualSections(t: Translate, kinds: VisualCalc[]): Section[] {
  const inputs = new Map<string, { label: string; kinds: Set<string> }>();
  for (const k of kinds)
    for (const [name, io] of Object.entries(k.inputs)) {
      const seen = inputs.get(name) ?? { label: io.label, kinds: new Set<string>() };
      seen.kinds.add(k.kind);
      inputs.set(name, seen);
    }
  return [
    {
      id: "definition", label: t("MODEL_DEFINITION"),
      fields: [
        { key: "key", label: t("MODEL_KEY"), help: t("MODEL_KEY_HELP"), required: true, controlType: "text" },
        { key: "title", label: t("MODEL_TITLE"), help: t("MODEL_TITLE_HELP"), controlType: "text" },
        { key: "kind", label: t("MODEL_VISUAL_KIND"), required: true, options: kinds.map((k) => ({ value: k.kind, label: k.label })) },
      ],
    },
    {
      id: "inputs", label: t("MODEL_VISUAL_INPUTS"),
      fields: [...inputs].map(([name, i]) => ({
        key: `${INPUT}${name}`, label: i.label, controlType: "expr", required: true,
        visible: (d: Row) => i.kinds.has(String(d.kind ?? "")),
      })),
    },
    { id: "outputs", label: t("MODEL_VISUAL_OUTPUTS") },
  ];
}

/** The visual written back over the one the page opened; a rename follows into placement. */
export function commitVisual(d: ModelDef, openedAs: string, v: Visual): ModelDef {
  return {
    ...d,
    visuals: (d.visuals ?? []).map((x) => (x.key === openedAs ? v : x)),
    structure: openedAs === v.key ? d.structure : {
      sections: d.structure.sections.map((sec) => ({
        ...sec,
        groups: sec.groups.map((g) => ({ ...g, params: g.params.map((k) => (k === openedAs ? v.key : k)) })),
      })),
    },
  };
}

/** The visual page's `validate`: checkModel over the model with this visual spliced in, its issues
 *  put on the key, the kind and each input's field. */
export function visualIssues(r: Row, draft: ModelDef, tables: TableCols[], openedAs: string, t: Translate): RecordIssues {
  const v = fromVisualRecord(r);
  const scope = commitVisual(draft, openedAs, v);
  const at = (scope.visuals ?? []).findIndex((x) => x.key === v.key);
  const mine = checkModel(scope, tables).filter((x) => x.path === `visuals[${at}]` || x.path.startsWith(`visuals[${at}].`));
  const fields: Record<string, string> = {};
  const keyed = keyProblem(v.key, t) ?? mine.find((x) => x.path === `visuals[${at}]`)?.message;
  if (keyed) fields.key = keyed;
  const kind = mine.find((x) => x.path === `visuals[${at}].kind`);
  if (kind) fields.kind = kind.message;
  for (const issue of mine) {
    const name = issue.path.slice(`visuals[${at}].inputs.`.length);
    if (!issue.path.startsWith(`visuals[${at}].inputs.`)) continue;
    fields[`${INPUT}${name}`] ??= issueText(issue, v.inputs[name] ?? "", t);
  }
  return { fields, other: [] };
}
