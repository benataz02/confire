import { expect, test } from "bun:test";
import { checkModel, type Issue, type ModelDef } from "@confire/config-engine";
import { toRecord } from "../../features/model/record.ts";
import { starterModel } from "./starterModel.ts";
import { anchorOf, builderMessages, modelIssues, type Translate } from "./builderMessages.ts";

// The sentences the page shows. Not the properties file: a test must not depend on the bundle.
const EN: Record<string, string> = {
  MODEL_NAME_REQUIRED: "Enter a model name",
  MODEL_LOOKUPS_FAILED: "Option lists could not be loaded",
  MODEL_ACTION_FAILED: "Action failed",
  MODEL_GROUP_MODEL: "Model",
  MODEL_EXPR_AT: " at '{0}'",
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
    bom: [{ id: "l1", itemCode: '"A"', qty: "1" }, { id: "l2", itemCode: '"B"', qty: "nope" }],
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
  // The span names the part of the expression it is about.
  expect(out.cells?.bom).toEqual({ "1:qty": "unknown identifier 'nope' at 'nope'" });
  expect(out.cells?.constraints).toEqual({ "0:assert": "bad" });
  const combo = out.other!.find((m) => m.detail === "constraints[1].params[1]")!;
  expect(combo.section).toBe("rules");
  const param = out.other!.find((m) => m.detail === "parameters[0].defaultExpr")!;
  expect(param.section).toBe("params");
  expect(param.anchor).toBe('[data-key="p:width"]');
});

test("the starter's one issue is the price list, a Settings field", () => {
  const d = named();
  expect(modelIssues(record(d), checkModel(d), t).fields).toEqual({ "pricing.priceList": expect.any(String) });
});

test("anchors point at the tree row that opens a parameter or table", () => {
  const draft = { ...named(), parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }] } as ModelDef;
  expect(anchorOf("parameters[0].defaultExpr", draft)).toBe('[data-key="p:width"]');
  expect(anchorOf("tables[0].columns[1]", draft)).toBe('[data-key="t:0.0"]');
  expect(anchorOf("computed[2].expr", draft)).toBe('[data-key="c:2"]');
  // Structure-level problems have nowhere to jump — the section is the answer.
  expect(anchorOf("model", draft)).toBeUndefined();
  expect(anchorOf("structure", draft)).toBeUndefined();
});

test("failures are messages: option lists under Rules, a refused action under Model", () => {
  const title = (s: string) => s;
  expect(builderMessages({ t, title })).toEqual([]);
  const out = builderMessages({ t, title, lookupsError: new Error("agent offline"), actionError: new Error("still in use") });
  expect(out.find((m) => m.id === "lookups")?.section).toBe("rules");
  expect(out.find((m) => m.id === "action")?.group).toBe("Model");
});
