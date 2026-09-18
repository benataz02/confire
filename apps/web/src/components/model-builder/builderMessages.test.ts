import { expect, test } from "bun:test";
import { checkModel, type ModelDef } from "@confire/config-engine";
import { starterModel } from "./starterModel.ts";
import { anchorOf, builderMessages } from "./builderMessages.ts";

const named = () => ({ ...starterModel("T"), name: "T" });

test("an unnamed model reports the blocker checkModel has no opinion about", () => {
  const draft = { ...named(), name: "  " };
  const msgs = builderMessages({ draft, issues: [] });
  expect(msgs.map((m) => m.id)).toContain("name");
  const name = msgs.find((m) => m.id === "name")!;
  expect(name.type).toBe("Negative");
  expect(name.section).toBe("settings");
  expect(name.anchor).toBe("#model-name");
});

test("issues land on the section that owns them", () => {
  const draft = named();
  const msgs = builderMessages({ draft, issues: checkModel(draft) });
  // The starter's one issue is the missing price list, which is a Settings field.
  const priceList = msgs.find((m) => m.detail === "pricing.priceList")!;
  expect(priceList.section).toBe("settings");
  expect(priceList.group).toBe("Settings");
  expect(priceList.anchor).toBe('[id="field-pricing.priceList"]');
  // …and an issue at all means the preview is stale, which is its own message.
  expect(msgs.find((m) => m.id === "preview")?.type).toBe("Critical");
});

test("anchors point at the control the issue is about", () => {
  const draft = {
    ...named(),
    parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
  } as ModelDef;
  // Dialog-only fields anchor to the tree row that opens the dialog.
  expect(anchorOf("parameters[0].defaultExpr", draft)).toBe('[data-key="p:width"]');
  // ExprInputs write their path as a DOM id.
  expect(anchorOf("bom[2].qty", draft)).toBe('[id="expr-bom[2].qty"]');
  expect(anchorOf("pricing.priceExpr", draft)).toBe('[id="expr-pricing.priceExpr"]');
  // A constraint's sub-paths have no field of their own; its condition is the row.
  expect(anchorOf("constraints[1].rows[0]", draft)).toBe('[id="expr-constraints[1].when"]');
  expect(anchorOf("constraints[1].assert", draft)).toBe('[id="expr-constraints[1].assert"]');
  // Structure-level problems have nowhere to jump — the section is the answer.
  expect(anchorOf("model", draft)).toBeUndefined();
  expect(anchorOf("structure", draft)).toBeUndefined();
});

test("operation failures are messages too, ungrouped from any section", () => {
  const draft = named();
  const msgs = builderMessages({
    draft, issues: [],
    saveError: new Error("CONFLICT"),
    actionError: new Error("still in use"),
    syncError: new Error("agent offline"),
  });
  expect(msgs.find((m) => m.id === "save")?.section).toBeUndefined();
  expect(msgs.find((m) => m.id === "action")?.group).toBe("Model");
  expect(msgs.find((m) => m.id === "sync")?.section).toBe("history");
});
