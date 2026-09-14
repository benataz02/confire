import { expect, test } from "bun:test";
import { checkModel, isTableGroup, placedTables, type ModelDef } from "@confire/config-engine";
import { starterModel } from "./starterModel.ts";
import {
  applyMove, canDrop, parseRowKey, placeParam, placeTable, removeFromStructure, rowKeyOf,
  tableKeyAt, unplacedParams, unplacedTables,
} from "./structureOps.ts";

/** Two sections: [fields "g", table "items"] and [fields "g2"]. */
function model(): ModelDef {
  const m = starterModel("T");
  return {
    ...m,
    parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
    structure: {
      sections: [
        { key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["width"] }, { table: "items" }] },
        { key: "other", title: "Other", groups: [{ key: "g2", title: "G2", params: [] }] },
      ],
    },
  };
}

const groupKinds = (m: ModelDef, s: number) =>
  m.structure.sections[s]!.groups.map((g) => (isTableGroup(g) ? `table:${g.table}` : `group:${g.key}`));

test("the fixture is a model the save gate accepts", () => {
  expect(checkModel(model(), [])).toEqual([]);
  expect(placedTables(model())).toEqual(["items"]);
});

test("a table row key round-trips through its position", () => {
  const ref = parseRowKey("t:0.1");
  expect(ref).toEqual({ kind: "table", s: 0, g: 1 });
  expect(rowKeyOf(ref)).toBe("t:0.1");
  expect(tableKeyAt(model(), 0, 1)).toBe("items");
  expect(tableKeyAt(model(), 0, 0)).toBeUndefined();
});

test("a table drags like a group, not like a field", () => {
  const m = model();
  // beside another group, and into a section
  expect(canDrop(m, "t:0.1", "g:0.0", "Before")).toBe(true);
  expect(canDrop(m, "t:0.1", "s:1", "On")).toBe(true);
  // but never into a group, nor beside a parameter
  expect(canDrop(m, "t:0.1", "g:0.0", "On")).toBe(false);
  expect(canDrop(m, "t:0.1", "p:width", "After")).toBe(false);
});

test("a parameter cannot be dropped onto a table group", () => {
  const m = model();
  expect(canDrop(m, "p:width", "g:1.0", "On")).toBe(true);
  // g:0.1 IS the table group — a drop there would have nowhere to go
  expect(canDrop(m, "p:width", "g:0.1", "On")).toBe(false);
});

test("moving a table to another section keeps its key", () => {
  // A field group moved across sections gets uniquified; a table group must not, or it would
  // point at a table that does not exist.
  const moved = applyMove(model(), "t:0.1", "s:1", "On");
  expect(groupKinds(moved, 0)).toEqual(["group:g"]);
  expect(groupKinds(moved, 1)).toEqual(["group:g2", "table:items"]);
  expect(placedTables(moved)).toEqual(["items"]);
  expect(checkModel(moved, [])).toEqual([]);
});

test("a field group moved into a section that already has its key is renamed", () => {
  const m = model();
  m.structure.sections[1]!.groups.push({ key: "g", title: "Clash", params: [] });
  // "g" and "g2" are both taken in section 1, so the incoming group lands as "g3".
  const moved = applyMove(m, "g:0.0", "s:1", "On");
  expect(groupKinds(moved, 1)).toEqual(["group:g2", "group:g", "group:g3"]);
});

test("placeTable never leaves the same table in two groups", () => {
  const once = placeTable(model(), "items", 1);
  expect(groupKinds(once, 0)).toEqual(["group:g"]);
  expect(groupKinds(once, 1)).toEqual(["group:g2", "table:items"]);
  // placing again moves it rather than duplicating
  const twice = placeTable(once, "items", 0);
  expect(placedTables(twice)).toEqual(["items"]);
  expect(groupKinds(twice, 1)).toEqual(["group:g2"]);
});

test("deleting a table group unplaces the table without touching parameters", () => {
  const gone = removeFromStructure(model(), { kind: "table", s: 0, g: 1 });
  expect(groupKinds(gone, 0)).toEqual(["group:g"]);
  expect(unplacedTables(gone)).toEqual(["items"]);
  expect(unplacedParams(gone)).toEqual([]);
});

test("placing a parameter skips table groups when counting what is placed", () => {
  const m = placeParam(model(), "width", 1, 0);
  expect(unplacedParams(m)).toEqual([]);
  expect(groupKinds(m, 0)).toEqual(["group:g", "table:items"]);
});

// The migration path the team chose: a legacy model keeps its table inside a group's params, so
// the table simply stops counting as placed and the form's catch-all section picks it up.
test("a legacy table inside a group's params reads as unplaced", () => {
  const legacy: ModelDef = {
    ...model(),
    structure: {
      sections: [{ key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["width", "items"] }] }],
    },
  };
  expect(placedTables(legacy)).toEqual([]);
  expect(unplacedTables(legacy)).toEqual(["items"]);
});
