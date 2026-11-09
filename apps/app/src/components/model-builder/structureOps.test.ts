import { expect, test } from "bun:test";
import { checkModel, placedTables, type ModelDef } from "@confire/config-engine";
import { starterModel } from "./starterModel.ts";
import { commitParam } from "../../features/model/parameter.ts";
import { withSheet } from "../../features/model/visualTestModel.ts";

// The starter cannot name a price list — only the admin can pick one. Every other issue would be
// a real structural problem, which is what these assertions are watching for.
const PRICE_LIST_ONLY = [{
  path: "pricing.priceList",
  message: "a model needs a price list — it is what prices the BOM materials",
}];
import {
  applyMove, canDrop, copyKeyIssues, copyKeys, deleteNodes, duplicateNodes, isItemsRow, outermost, parseRowKey,
  placeParam, renameIdents, rowKeyOf,
} from "./structureOps.ts";

/** Two sections: [group "g": width, items] and [group "g2": empty]. */
function model(): ModelDef {
  const m = starterModel("T");
  return {
    ...m,
    parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
    structure: {
      sections: [
        { key: "main", title: "Main", groups: [{ key: "g", title: "G", params: ["width", "items"] }] },
        { key: "other", title: "Other", groups: [{ key: "g2", title: "G2", params: [] }] },
      ],
    },
  };
}

const groupKinds = (m: ModelDef, s: number) =>
  m.structure.sections[s]!.groups.map((g) => `${g.key}:${g.params.join(",")}`);

test("the fixture is a model the save gate accepts", () => {
  expect(checkModel(model(), [])).toEqual(PRICE_LIST_ONLY);
  expect(placedTables(model())).toEqual(["items"]);
});

test("a table row key round-trips through its key", () => {
  const ref = parseRowKey("t:items");
  expect(ref).toEqual({ kind: "table", key: "items" });
  expect(rowKeyOf(ref)).toBe("t:items");
});

test("a table drags like a parameter", () => {
  const m = model();
  // into a group, and beside a parameter or another table
  expect(canDrop(m, "t:items", "g:1.0", "On")).toBe(true);
  expect(canDrop(m, "t:items", "p:width", "Before")).toBe(true);
  expect(canDrop(m, "p:width", "t:items", "After")).toBe(true);
  // but never beside a group, into a section, or onto a field
  expect(canDrop(m, "t:items", "g:0.0", "Before")).toBe(false);
  expect(canDrop(m, "t:items", "s:1", "On")).toBe(false);
  expect(canDrop(m, "t:items", "p:width", "On")).toBe(false);
});

test("moving a table places it once, where it was dropped", () => {
  const moved = applyMove(model(), "t:items", "g:1.0", "On");
  expect(groupKinds(moved, 0)).toEqual(["g:width"]);
  expect(groupKinds(moved, 1)).toEqual(["g2:items"]);
  expect(groupKinds(applyMove(model(), "t:items", "p:width", "Before"), 0)).toEqual(["g:items,width"]);
  expect(placedTables(moved)).toEqual(["items"]);
  expect(checkModel(moved, [])).toEqual(PRICE_LIST_ONLY);
});

test("a field group moved into a section that already has its key is renamed", () => {
  const m = model();
  m.structure.sections[1]!.groups.push({ key: "g", title: "Clash", params: [] });
  // "g" and "g2" are both taken in section 1, so the incoming group lands as "g3".
  const moved = applyMove(m, "g:0.0", "s:1", "On");
  expect(groupKinds(moved, 1)).toEqual(["g2:", "g:", "g3:width,items"]);
});

test("deleting a table removes its def and its place without touching parameters", () => {
  const gone = deleteNodes(model(), [{ kind: "table", key: "items" }]);
  expect(groupKinds(gone, 0)).toEqual(["g:width"]);
  expect(placedTables(gone)).toEqual([]);
  expect(gone.tables).toEqual([]);
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
  m.structure.sections[0]!.groups.push({ key: "t", title: "", params: [] });
  const gone = deleteNodes(m, [{ kind: "group", s: 0, g: 0 }, { kind: "group", s: 1, g: 0 }, { kind: "formula", i: 0 }, { kind: "formula", i: 2 }]);
  expect(groupKinds(gone, 0)).toEqual(["t:"]);
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
  expect(isItemsRow(model(), { kind: "table", key: "items" })).toBe(true);
  expect(isItemsRow(model(), { kind: "group", s: 0, g: 0 })).toBe(false);
});

test("a copied section takes its content, renamed, and lands after the last section", () => {
  const m = model();
  m.parameters.push({ key: "height", label: "Height", type: "number", ui: "input", visibleWhen: 'width > 2 && height != "width"' });
  (m.structure.sections[0]!.groups[0] as { params: string[] }).params.push("height");
  m.structure.sections[2] = { key: "rest", title: "Rest", groups: [{ key: "r", title: "R", params: [], visibleWhen: "width > 1" }], visibleWhen: "height > 0" };
  const refs = [{ kind: "section", s: 0 } as const, { kind: "section", s: 2 } as const];
  const keys = copyKeys(m, refs);
  // the items grid stays out: a model holds exactly one
  expect(keys.map((k) => `${k.kind}:${k.from}→${k.key}`)).toEqual(["section:main→main2", "param:width→width2", "param:height→height2", "section:rest→rest2"]);
  const out = duplicateNodes(m, refs, keys);
  expect(out.structure.sections.map((s) => s.key)).toEqual(["main", "other", "rest", "main2", "rest2"]);
  expect(out.structure.sections[3]!.groups).toEqual([{ key: "g", title: "G", params: ["width2", "height2"] }]);
  // a calculation table goes along like a parameter, renamed in the one key namespace
  const calc = { ...model().tables![0]!, key: "holes", role: "calc" as const };
  m.tables = [...m.tables!, calc];
  m.structure.sections[0]!.groups[0]!.params.push("holes");
  expect(copyKeys(m, [{ kind: "group", s: 0, g: 0 }]).map((k) => `${k.kind}:${k.key}`)).toContain("table:holes2");
  // a copied section's and group's rules read the copies too
  expect(out.structure.sections[4]).toEqual({ key: "rest2", title: "Rest", groups: [{ key: "r", title: "R", params: [], visibleWhen: "width2 > 1" }], visibleWhen: "height2 > 0" });
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
  expect(groupKinds(out, 1)).toEqual(["g2:", "g3:"]);
  expect(out.structure.sections[0]!.groups[0]!.params).toEqual(["width", "items", "width2"]);
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

test("placeParam moves a key into a group", () => {
  const m = placeParam(model(), "width", 1, 0);
  expect(m.structure.sections[1]!.groups[0]).toEqual({ key: "g2", title: "G2", params: ["width"] });
  expect(groupKinds(m, 0)).toEqual(["g:items"]);
});

// The parameter page's position is the URL's, and a reload drops a group added unsaved: a new
// parameter still lands in a group, never in none.
test("a new parameter whose position holds no group lands in the last one", () => {
  const p = { key: "len", label: "Len", type: "number" as const, ui: "input" as const };
  for (const place of [undefined, { s: 0, g: 1 }, { s: 5, g: 0 }]) {
    const m = commitParam(model(), p, undefined, place);
    expect(m.structure.sections[1]!.groups[0]).toEqual({ key: "g2", title: "G2", params: ["len"] });
  }
  const noGroup = { ...model(), structure: { sections: [{ key: "main", title: "Main", groups: [] }] } };
  expect(commitParam(noGroup, p, undefined, { s: 0, g: 0 })).toBe(noGroup);
});

test("a visual row round-trips its key", () => {
  expect(rowKeyOf({ kind: "visual", key: "hoja" })).toBe("v:hoja");
  expect(parseRowKey("v:hoja")).toEqual({ kind: "visual", key: "hoja" });
});

test("deleting a visual, or its group, drops its definition", () => {
  expect(deleteNodes(withSheet(), [{ kind: "visual", key: "hoja" }]).visuals).toEqual([]);
  expect(deleteNodes(withSheet(), [{ kind: "visual", key: "hoja" }]).structure.sections[0]!.groups[0]!.params).toEqual(["width"]);
  expect(deleteNodes(withSheet(), [{ kind: "group", s: 0, g: 0 }]).visuals).toEqual([]);
});

test("a duplicated group leaves its visual out, and copies avoid visual keys", () => {
  expect(copyKeys(withSheet(), [{ kind: "group", s: 0, g: 0 }]).map((k) => k.from)).not.toContain("hoja");
  const m = withSheet({ key: "width2" }, { structure: { sections: [{ key: "s", title: "S", groups: [
    { key: "g", title: "G", params: ["width", "width2"] }, { key: "it", title: "I", params: ["items"] },
  ] }] } });
  expect(copyKeys(m, [{ kind: "param", key: "width" }])[0]!.key).toBe("width3");
});
