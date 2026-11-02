import { describe, expect, test } from "bun:test";
import { checkModel } from "../src/check";
import { formState } from "../src/form-state";
import type { ModelDef, TableRows } from "../src/model";
import { bindings, missingInputs, propagate } from "../src/propagate";
import { fieldGroup, lookups, model } from "./fixture";

/** The fixture with a rule on its "Coating" group and a holes table in a section of its own. */
function ruled(group?: string, section?: string): ModelDef {
  const m = structuredClone(model);
  if (group !== undefined) fieldGroup(m, 0, 1).visibleWhen = group;
  m.parameters.find((p) => p.key === "color")!.mandatory = true;
  m.tables!.push({
    key: "holes", title: "Holes", role: "calc",
    columns: [{ key: "d", label: "Diameter", type: "number", required: true, cell: { kind: "input" } }],
  });
  m.structure.sections.push({ key: "extra", title: "Extra", groups: [{ table: "holes" }], ...(section ? { visibleWhen: section } : {}) });
  return m;
}

describe("a section's or group's visibleWhen", () => {
  test("a hidden group hides its fields: null, no domain, not required", () => {
    const m = ruled('material == "steel"');
    const p = propagate(m, lookups, { material: "alu", coated: true, color: "blue" });
    expect(p.visible.coated).toBe(false);
    expect(p.visible.color).toBe(false);
    expect(p.values.coated).toBeNull();
    expect(p.values.color).toBeNull();
    expect(p.domains.coated).toBeUndefined();
    expect(p.domains.color).toBeUndefined();
    expect(p.required.color).toBe(false);
    expect(formState(m, lookups, p, {}).hidden).toEqual(["main/coating"]);
  });

  test("the group shows again once its rule holds, its fields' own rules still apply", () => {
    const p = propagate(ruled('material == "steel"'), lookups, { material: "steel" });
    expect(p.visible.coated).toBe(true);
    expect(p.visible.color).toBe(false); // its own rule: coated defaults to false
    expect(p.hiddenStructure.size).toBe(0);
  });

  test("a rule that cannot evaluate yet hides nothing", () => {
    const m = ruled('material == "steel"');
    const p = propagate(m, lookups, {});
    expect(p.visible.coated).toBe(true);
    expect(formState(m, lookups, p, {}).hidden).toBeUndefined();
  });

  test("a hidden section's tables count no rows and ask for none", () => {
    const m = ruled(undefined, "coated");
    const rows: TableRows = { holes: [{ d: 5 }, {}] };
    const shown = propagate(m, lookups, { coated: true }, rows);
    expect(shown.values.holes_count).toBe(2);
    expect(missingInputs(m, lookups, shown, rows).map((n) => n.code)).toContain("cell_required");
    const hidden = propagate(m, lookups, { coated: false }, rows);
    expect(hidden.values.holes_count).toBe(0);
    expect(hidden.values.holes_d).toBe(0);
    expect(hidden.hiddenTables).toEqual(new Set(["holes"]));
    expect(missingInputs(m, lookups, hidden, rows).map((n) => n.code)).not.toContain("cell_required");
    expect(formState(m, lookups, hidden, rows).hidden).toEqual(["extra"]);
  });

  test("hiding cascades through a table's sums", () => {
    // A group shown by the holes' count hides once their section does.
    const m = ruled("holes_count > 0", "coated");
    const rows = { holes: [{ d: 5 }] };
    expect(bindings(m, lookups, { coated: true }, rows).visible.color).toBe(true);
    expect(bindings(m, lookups, { coated: false }, rows).visible.color).toBe(false);
  });

  test("checkModel checks the rules and keeps the item grid's section unconditional", () => {
    const m = ruled("nope", "coated");
    expect(checkModel(m).map((i) => i.path)).toContain("structure.sections[0].groups[1].visibleWhen");
    m.structure.sections[1]!.groups.push({ table: "items" });
    expect(checkModel(m).map((i) => i.path)).toContain("structure.sections[1].visibleWhen");
  });
});
