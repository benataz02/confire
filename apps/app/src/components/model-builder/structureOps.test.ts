import { expect, test } from "bun:test";
import { checkModel, isTableGroup, placedTables, type ModelDef } from "@confire/config-engine";
import { starterModel } from "./starterModel.ts";
import { commitParam } from "../../features/model/parameter.ts";

// The starter cannot name a price list — only the admin can pick one. Every other issue would be
// a real structural problem, which is what these assertions are watching for.
const PRICE_LIST_ONLY = [{
  path: "pricing.priceList",
  message: "a model needs a price list — it is what prices the BOM materials",
}];
import {
  applyMove, canDrop, copyKeyIssues, copyKeys, deleteNodes, duplicateNodes, isItemsRow, outermost, parseRowKey,
  placeParam, placeTable, renameIdents, rowKeyOf, tableKeyAt,
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
  expect(checkModel(model(), [])).toEqual(PRICE_LIST_ONLY);
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
  expect(checkModel(moved, [])).toEqual(PRICE_LIST_ONLY);
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

test("deleting a table group removes it from the section without touching parameters", () => {
  const gone = deleteNodes(model(), [{ kind: "table", s: 0, g: 1 }]);
  expect(groupKinds(gone, 0)).toEqual(["group:g"]);
  expect(placedTables(gone)).toEqual([]);
  expect(gone.parameters.map((p) => p.key)).toEqual(["width"]);
});

test("deleteNodes drops the defs a section held", () => {
  const gone = deleteNodes(model(), [{ kind: "section", s: 0 }]);
  expect(gone.structure.sections.map((s) => s.key)).toEqual(["other"]);
  expect(gone.parameters).toEqual([]);
  expect(gone.tables).toEqual([]);
});

test("deleteNodes takes several positions at once without one shifting the next", () => {
  const m = model();
  m.computed = [{ key: "a", expr: "1" }, { key: "b", expr: "2" }, { key: "c", expr: "3" }];
  const gone = deleteNodes(m, [{ kind: "group", s: 0, g: 0 }, { kind: "group", s: 1, g: 0 }, { kind: "formula", i: 0 }, { kind: "formula", i: 2 }]);
  expect(groupKinds(gone, 0)).toEqual(["table:items"]);
  expect(groupKinds(gone, 1)).toEqual([]);
  expect(gone.computed.map((c) => c.key)).toEqual(["b"]);
  expect(gone.parameters).toEqual([]);
});

test("a formula goes with its parameter, however the parameter went; an untied one stays", () => {
  const m = model();
  m.computed = [{ key: "a", expr: "width", param: "width" }, { key: "b", expr: "1" }];
  expect(deleteNodes(m, [{ kind: "group", s: 0, g: 0 }]).computed.map((c) => c.key)).toEqual(["b"]);
  expect(deleteNodes(m, [{ kind: "param", key: "width" }]).computed.map((c) => c.key)).toEqual(["b"]);
});

test("a copied formula is tied to its parameter's copy when that is copied too", () => {
  const m = model();
  m.computed = [{ key: "a", expr: "width", param: "width" }];
  const both = [{ kind: "param", key: "width" }, { kind: "formula", i: 0 }] as const;
  expect(duplicateNodes(m, [...both], copyKeys(m, [...both])).computed[1]).toEqual({ key: "a2", expr: "width2", param: "width2" });
  const alone = [{ kind: "formula", i: 0 }] as const;
  expect(duplicateNodes(m, [...alone], copyKeys(m, [...alone])).computed[1]).toEqual({ key: "a2", expr: "width", param: "width" });
});

test("a row inside a picked section or group is not acted on twice", () => {
  const refs = outermost(model(), [{ kind: "section", s: 0 }, { kind: "group", s: 0, g: 0 }, { kind: "param", key: "width" }, { kind: "group", s: 1, g: 0 }]);
  expect(refs).toEqual([{ kind: "section", s: 0 }, { kind: "group", s: 1, g: 0 }]);
});

test("a formula row is addressed by index", () => {
  expect(parseRowKey("c:2")).toEqual({ kind: "formula", i: 2 });
  expect(rowKeyOf({ kind: "formula", i: 2 })).toBe("c:2");
});

test("a formula drags onto a parameter, which ties it, or beside a formula, whose tie it takes", () => {
  const m = model();
  m.parameters.push({ key: "depth", label: "Depth", type: "number", ui: "input" });
  (m.structure.sections[1]!.groups[0] as { params: string[] }).params.push("depth");
  m.computed = [{ key: "a", expr: "1", param: "width" }, { key: "b", expr: "2", param: "depth" }, { key: "c", expr: "3" }];
  expect(canDrop(m, "c:0", "p:depth", "Before")).toBe(false);
  expect(canDrop(m, "c:0", "c:1", "On")).toBe(false);
  expect(canDrop(m, "c:0", "g:1.0", "On")).toBe(false);
  expect(canDrop(m, "p:width", "c:0", "Before")).toBe(false);
  const ties = (d: typeof m) => d.computed.map((c) => `${c.key}:${c.param ?? "-"}`);
  // On: its last formula; just below it: its first.
  expect(ties(applyMove(m, "c:0", "p:depth", "On"))).toEqual(["b:depth", "c:-", "a:depth"]);
  expect(ties(applyMove(m, "c:0", "p:depth", "After"))).toEqual(["a:depth", "b:depth", "c:-"]);
  expect(ties(applyMove(m, "c:2", "c:1", "Before"))).toEqual(["a:width", "c:depth", "b:depth"]);
  expect(ties(applyMove(m, "c:0", "c:2", "After"))).toEqual(["b:depth", "c:-", "a:-"]);
});

test("the items grid is the one row that is neither deleted nor copied", () => {
  expect(isItemsRow(model(), { kind: "table", s: 0, g: 1 })).toBe(true);
  expect(isItemsRow(model(), { kind: "group", s: 0, g: 0 })).toBe(false);
});

test("a copied section takes its content, renamed, and lands after the last section", () => {
  const m = model();
  m.parameters.push({ key: "height", label: "Height", type: "number", ui: "input", visibleWhen: 'width > 2 && height != "width"' });
  (m.structure.sections[0]!.groups[0] as { params: string[] }).params.push("height");
  const refs = [{ kind: "section", s: 0 } as const];
  const keys = copyKeys(m, refs);
  // the items grid stays out: a model holds exactly one
  expect(keys.map((k) => `${k.kind}:${k.from}→${k.key}`)).toEqual(["section:main→main2", "param:width→width2", "param:height→height2"]);
  const out = duplicateNodes(m, refs, keys);
  expect(out.structure.sections.map((s) => s.key)).toEqual(["main", "other", "main2"]);
  expect(out.structure.sections[2]!.groups).toEqual([{ key: "g", title: "G", params: ["width2", "height2"] }]);
  // the copy reads the copy; the string literal is not a reference
  expect(out.parameters.find((p) => p.key === "height2")!.visibleWhen).toBe('width2 > 2 && height2 != "width"');
  expect(out.parameters.find((p) => p.key === "height")!.visibleWhen).toBe('width > 2 && height != "width"');
  expect(checkModel(out, [])).toEqual(PRICE_LIST_ONLY);
});

test("copied groups, parameters and formulas go to the bottom of where their source is", () => {
  const m = model();
  m.computed = [{ key: "area", expr: "width * 2" }, { key: "x", expr: "1" }];
  const refs = [{ kind: "group", s: 1, g: 0 }, { kind: "param", key: "width" }, { kind: "formula", i: 0 }] as const;
  const out = duplicateNodes(m, [...refs], copyKeys(m, [...refs]));
  expect(groupKinds(out, 1)).toEqual(["group:g2", "group:g3"]);
  expect((out.structure.sections[0]!.groups[0] as { params: string[] }).params).toEqual(["width", "width2"]);
  expect(out.computed).toEqual([...m.computed, { key: "area2", expr: "width2 * 2" }]);
});

test("a copy's keys are checked against the model and against each other", () => {
  const m = model();
  m.parameters.push({ key: "depth", label: "Depth", type: "number", ui: "input" });
  (m.structure.sections[1]!.groups[0] as { params: string[] }).params.push("depth");
  const keys = copyKeys(m, [{ kind: "param", key: "width" }, { kind: "group", s: 1, g: 0 }]);
  expect(keys.map((k) => k.key)).toEqual(["width2", "g3", "depth2"]);
  expect(copyKeyIssues(m, keys)).toEqual({});
  keys[0]!.key = "fresh";
  keys[1]!.key = "1g";
  keys[2]!.key = "fresh";
  expect(copyKeyIssues(m, keys)).toEqual({ "p:width": "taken", "g:1.0": "invalid", "p:depth": "taken" });
  keys[0]!.key = "width";
  keys[2]!.key = "depth2";
  expect(copyKeyIssues(m, keys)).toEqual({ "p:width": "taken", "g:1.0": "invalid" });
});

test("renameIdents leaves an expression it cannot read alone", () => {
  expect(renameIdents('a + "', new Map([["a", "b"]]))).toBe('a + "');
  expect(renameIdents("max(a, ab)", new Map([["a", "b"]]))).toBe("max(b, ab)");
});

test("placeParam lands in a field group, not a table group", () => {
  const m = placeParam(model(), "width", 1, 0);
  expect(m.structure.sections[1]!.groups[0]).toEqual({ key: "g2", title: "G2", params: ["width"] });
  expect(groupKinds(m, 0)).toEqual(["group:g", "table:items"]);
});

// The parameter page's position is the URL's, and a reload drops a group added unsaved: a new
// parameter still lands in a group, never in none.
test("a new parameter whose position holds no field group lands in the last one", () => {
  const p = { key: "len", label: "Len", type: "number" as const, ui: "input" as const };
  for (const place of [undefined, { s: 0, g: 1 }, { s: 5, g: 0 }]) {
    const m = commitParam(model(), p, undefined, place);
    expect(m.structure.sections[1]!.groups[0]).toEqual({ key: "g2", title: "G2", params: ["len"] });
  }
  const noGroup = { ...model(), structure: { sections: [{ key: "main", title: "Main", groups: [{ table: "items" }] }] } };
  expect(commitParam(noGroup, p, undefined, { s: 0, g: 0 })).toBe(noGroup);
});
