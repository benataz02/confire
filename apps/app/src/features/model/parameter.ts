import { checkModel, type ModelDef, type Param } from "@confire/config-engine";
import type { RecordIssues, RecordMessage } from "@confire/ui/object-page/useObjectRecord.ts";
import type { Row, Section } from "@confire/ui/types.ts";
import { issueText, modelWithParam, type TableCols } from "../../components/model-builder/exprHelpers.ts";
import { placeParam } from "../../components/model-builder/structureOps.ts";

// One parameter of the open model, as a record of its own: the Param's fields. Definition and
// Behavior are declared; Domain stays a template (ParamDomain) — its editor switches with the kind.
// Save writes the parameter into the model record and saves the model (ParamPage).

type Translate = (key: string, ...params: string[]) => string;

/** A control that can hold one type only sets it, and Type stays locked while it is picked. */
export const CONTROL_TYPE: Partial<Record<Param["ui"], Param["type"]>> = { textarea: "string", checkbox: "boolean", slider: "number" };

/** Switching control: its type, and a slider gets a range plus a default at its min — the handle
 *  always shows a position, so an empty value would draw as the min while the quote still waits. */
export function withControl(p: Param, ui: Param["ui"]): Partial<Param> {
  const type = CONTROL_TYPE[ui] ?? p.type;
  if (ui === "slider") {
    const domain = p.domain?.kind === "range" ? p.domain : { kind: "range" as const, min: 0, max: 100, step: 1 };
    return { ui, type, domain, defaultExpr: p.defaultExpr || String(domain.min) };
  }
  // A range only bounds a number; a list domain stays (a boolean with options is still legal).
  return { ui, type, domain: type !== "number" && p.domain?.kind === "range" ? undefined : p.domain };
}

/** An unchecked flag is no flag: the model stores it only when set. */
const flag = (key: string) => (v: unknown) => ({ [key]: v ? true : undefined });

export const paramSections = (t: Translate): Section[] => [
  {
    id: "definition", label: t("MODEL_DEFINITION"),
    fields: [
      { key: "key", label: t("MODEL_KEY"), required: true, controlType: "text", readonly: true, editableOnCreate: true },
      { key: "label", label: t("MODEL_COL_LABEL"), required: true, controlType: "text" },
      // Usually one identifier, so the Input's own suggestion list is enough.
      { key: "defaultExpr", label: t("MODEL_DEFAULT"), controlType: "expr" },
      {
        key: "type", label: t("MODEL_TYPE"), required: true,
        options: (["string", "number", "boolean"] as const).map((v) => ({ value: v, label: v })),
        disabled: (fd) => !!CONTROL_TYPE[fd.ui as Param["ui"]],
      },
      { key: "unit", label: t("MODEL_UNIT"), controlType: "optionalText", placeholder: t("MODEL_UNIT_PH") },
      {
        key: "ui", label: t("MODEL_CONTROL"), required: true, controlType: "paramUi",
        onChange: (v, fd) => withControl(fd as Param, v as Param["ui"]),
      },
    ],
  },
  { id: "domain", label: t("MODEL_DOMAIN") },
  {
    id: "behavior", label: t("MODEL_BEHAVIOR"),
    fields: [
      { key: "help", label: t("MODEL_HELP"), controlType: "note" },
      { key: "readonly", label: t("MODEL_READONLY"), type: "boolean", onChange: flag("readonly") },
      { key: "priceExpr", label: t("MODEL_PRICE_FORMULA"), controlType: "exprArea" },
      { key: "visibleWhen", label: t("MODEL_VISIBLE_WHEN"), controlType: "exprArea", placeholder: t("MODEL_VISIBLE_PH") },
      { key: "mandatory", label: t("MODEL_MANDATORY"), type: "boolean", onChange: flag("mandatory") },
      { key: "requiredWhen", label: t("MODEL_REQUIRED_WHEN"), controlType: "exprArea", placeholder: t("MODEL_REQUIRED_PH") },
    ],
  },
];

const DECLARED = new Set(["key", "label", "defaultExpr", "type", "unit", "ui", "help", "readonly", "priceExpr", "visibleWhen", "mandatory", "requiredWhen"]);

// mandatory by default: an unanswered field is the usual mistake, and unticking it is one click.
export const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select", mandatory: true });

/** The domain is missing or half-built, so a list control would list nothing. A source with no
 *  columns is checkModel's to report — the key column is convention, not a field here. */
function domainIssue(p: Param, t: Translate): string | undefined {
  if (p.ui === "slider" && p.domain?.kind !== "range") return t("MODEL_SLIDER_RANGE");
  if (!p.domain)
    return (p.ui === "select" || p.ui === "radio" || p.ui === "multicombo") && p.type !== "boolean"
      ? t("MODEL_CONTROL_DOMAIN") : undefined;
  if (p.domain.kind !== "options") return undefined;
  const ref = p.domain.ref;
  if (ref.source !== "manual" && !ref.table) return t("MODEL_CHOOSE_MASTERDATA");
  return undefined;
}

/** The parameter, checked against the model with it spliced in — so an unsaved rename resolves the
 *  way it will once saved. `at` is its index there: what checkModel's paths and the expression
 *  fields' ids name. */
export function checkParam(draft: ModelDef, tables: TableCols[], p: Param) {
  const scope = modelWithParam(draft, p);
  const at = scope.parameters.findIndex((x) => x.key === p.key);
  const mine = at < 0 ? [] : checkModel(scope, tables).filter((x) => x.path.startsWith(`parameters[${at}]`));
  return { scope, at, mine };
}

/** The parameter page's `validate`: the key and label rules, the domain's, and checkModel's issues
 *  for this parameter — each on its field, the domain's under Domain. */
export function paramIssues(r: Row, draft: ModelDef, tables: TableCols[], isNew: boolean, t: Translate): RecordIssues {
  const p = r as Param;
  const fields: Record<string, string> = {};
  const other: RecordMessage[] = [];
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p.key)) fields.key = t("MODEL_KEY_INVALID");
  else if (isNew && draft.parameters.some((x) => x.key === p.key)) fields.key = t("MODEL_KEY_TAKEN");
  if (!p.label) fields.label = t("MODEL_LABEL_REQUIRED");
  const d = domainIssue(p, t);
  if (d) other.push({ id: "domain", text: d, section: "domain" });
  const { at, mine } = checkParam(draft, tables, p);
  mine.forEach((issue, i) => {
    const field = issue.path.slice(`parameters[${at}].`.length).split(/[.[]/)[0] ?? "";
    if (DECLARED.has(field)) fields[field] ??= issueText(issue, String(r[field] ?? ""), t);
    else other.push({ id: `${issue.path}:${i}`, text: issue.message, detail: issue.path, section: "domain" });
  });
  return { fields, other };
}

/** The parameter written back over the one the page opened, or appended (and placed) when new. */
export function commitParam(d: ModelDef, p: Param, openedAs: string | undefined, place?: { s: number; g: number }): ModelDef {
  if (openedAs !== undefined) return { ...d, parameters: d.parameters.map((x) => (x.key === openedAs ? p : x)) };
  const out = { ...d, parameters: [...d.parameters, p] };
  return place ? placeParam(out, p.key, place.s, place.g) : out;
}
