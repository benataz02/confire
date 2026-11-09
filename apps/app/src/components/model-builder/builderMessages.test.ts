import { expect, test } from "bun:test";
import { checkModel, type Issue, type ModelDef } from "@confire/config-engine";
import { toRecord } from "../../features/model/record.ts";
import { starterModel } from "./starterModel.ts";
import { anchorOf, builderMessages, modelIssues, rowOf, type Translate } from "./builderMessages.ts";

// The sentences the page shows. Not the properties file: a test must not depend on the bundle.
const EN: Record<string, string> = {
  MODEL_NAME_REQUIRED: "Enter a model name",
  MODEL_LOOKUPS_FAILED: "Option lists could not be loaded",
  MODEL_ACTION_FAILED: "Action failed",
  MODEL_GROUP_MODEL: "Model",
  MODEL_EXPR_AT: " at '{0}'",
  MODEL_LINE_AT: "{0}, line {1}",
  MODEL_ROUTING: "Routing",
};
const t: Translate = (key, ...params) =>
  params.reduce((s, p, i) => s.replaceAll(`{${i}}`, p), EN[key] ?? key);

const record = (d: ModelDef) => toRecord({ definition: d, portal: false, portalPricing: "request" });
const named = (): ModelDef => ({ ...starterModel("T"), name: "T" });

test("an unnamed model's name is a field error checkModel has no opinion about", () => {
  const r = record({ ...named(), name: "  " });
  expect(modelIssues(r, [], t).fields).toEqual({ name: "Enter a model name" });
});

test("an issue lands on its field, a grid's on its cell, the rest under its section", () => {
  const d: ModelDef = {
    ...named(),
    parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
    bom: [{ itemCode: '"A"', qty: "1" }, { itemCode: '"B"', qty: "nope" }],
    constraints: [
      { kind: "expr", assert: "width >", message: "m" },
      { kind: "table", params: ["width", "x"], rows: [], mode: "allow" },
    ],
  };
  const issues: Issue[] = [
    { path: "pricing.priceList", message: "needs a price list" },
    { path: "bom[1].qty", message: "unknown identifier 'nope'", from: 0, to: 4 },
    { path: "constraints[0].assert", message: "bad" },
    { path: "constraints[1].params[1]", message: "unknown parameter 'x'" },
    { path: "parameters[0].defaultExpr", message: "unknown identifier" },
  ];
  const out = modelIssues(record(d), issues, t);
  expect(out.fields?.["pricing.priceList"]).toBe("needs a price list");
  // A BOM/routing line has no cell any more (its table opens a dialog): the issue is a message on
  // its row, and the span still names the part of the expression it is about.
  expect(out.cells?.bom).toBeUndefined();
  expect(out.other!.find((m) => m.anchor === '[data-line="bom:1"]')?.text).toBe("unknown identifier 'nope' at 'nope'");
  expect(out.cells?.constraints).toEqual({ "0:assert": "bad" });
  const combo = out.other!.find((m) => m.detail === "constraints[1].params[1]")!;
  expect(combo.section).toBe("rules");
  const param = out.other!.find((m) => m.detail === "parameters[0].defaultExpr")!;
  expect(param.section).toBe("params");
  expect(param.anchor).toBe('.confire-params-struct [row-key="p:width"]');
});

test("the starter's one issue is the price list, a Settings field", () => {
  const d = named();
  expect(modelIssues(record(d), checkModel(d), t).fields).toEqual({ "pricing.priceList": expect.any(String) });
});

test("an issue's row is the tree row that opens its parameter, table, formula or heading", () => {
  const draft = { ...named(), parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }] } as ModelDef;
  expect(rowOf("parameters[0].defaultExpr", draft)).toBe("p:width");
  expect(rowOf("tables[0].columns[1]", draft)).toBe("t:items");
  expect(rowOf("computed[2].expr", draft)).toBe("c:2");
  expect(rowOf("structure.sections[1].visibleWhen", draft)).toBe("s:1");
  expect(rowOf("structure.sections[1].groups[2].visibleWhen", draft)).toBe("g:1.2");
  expect(anchorOf("computed[2].expr", draft)).toBe('.confire-params-struct [row-key="c:2"]');
  // Structure-level problems have nowhere to jump — the section is the answer.
  expect(rowOf("model", draft)).toBeUndefined();
  expect(anchorOf("structure", draft)).toBeUndefined();
});

test("failures are messages: option lists under Rules, a refused action under Model", () => {
  const title = (s: string) => s;
  expect(builderMessages({ t, title })).toEqual([]);
  const out = builderMessages({ t, title, lookupsError: new Error("agent offline"), actionError: new Error("still in use") });
  expect(out.find((m) => m.id === "lookups")?.section).toBe("rules");
  expect(out.find((m) => m.id === "action")?.group).toBe("Model");
});

test("a line issue is a message anchored on its row", () => {
  const d: ModelDef = { ...named(), routing: [
    { resource: "SAW", setupMin: "1", runMinPerUnit: "1", ratePerHour: "60" },
    { resource: "SAW", setupMin: "nope", runMinPerUnit: "1", ratePerHour: "60" },
  ] };
  const r = record(d);
  const out = modelIssues(r, checkModel(d), t);
  expect(out.cells?.routing).toBeUndefined();
  expect(out.other).toContainEqual(expect.objectContaining({ section: "outputs", anchor: '[data-line="routing:1"]', detail: "Routing, line 2" }));
});

test("a visual's issue points at its tree row", async () => {
  const { withSheet } = await import("../../features/model/visualTestModel.ts");
  expect(rowOf("visuals[0].inputs.gapX", withSheet())).toBe("v:hoja");
});
