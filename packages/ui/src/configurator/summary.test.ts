import { expect, test } from "bun:test";
import type { FormState, ModelDef } from "@confire/config-engine";
import { configSummary } from "./summary.ts";

const model: ModelDef = {
  name: "Manifold",
  parameters: [
    { key: "material", label: "Material", type: "string", ui: "dropdown",
      domain: { kind: "options", ref: { source: "manual", options: [{ value: "alu", label: "Aluminium 6082" }] } } },
    { key: "ports", label: "Ports", type: "number", ui: "input" },
    { key: "finish", label: "Finish", type: "string", ui: "input" },
    { key: "note", label: "Note", type: "string", ui: "input" },
  ],
  structure: { sections: [] },
  computed: [], constraints: [], bom: [], routing: [],
  pricing: { margin: 20, quoteItemCode: "CFG" },
  batchDefaults: [1],
};

const form: FormState = {
  fields: {
    material: { value: "alu", visible: true, required: false, options: [{ value: "alu", label: "Aluminium 6082" }] },
    ports: { value: 6, visible: true, required: false },
    finish: { value: "anodized", visible: false, required: false }, // hidden: skipped
    note: { visible: true, required: false }, // unset: skipped
  },
  conflicts: [], open: 0, tables: {},
};

test("batches first, then visible filled fields in model order, an option by its label", () => {
  expect(configSummary(model, form, [500, 1000])).toEqual(["500 · 1,000", "Material: Aluminium 6082", "Ports: 6"]);
});

test("max caps the fields, not the batches", () => {
  expect(configSummary(model, form, [500, 1000], 1)).toEqual(["500 · 1,000", "Material: Aluminium 6082"]);
});

test("no batches, no batch item", () => {
  expect(configSummary(model, form, [])).toEqual(["Material: Aluminium 6082", "Ports: 6"]);
});
