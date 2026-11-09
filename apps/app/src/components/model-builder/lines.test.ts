import { expect, test } from "bun:test";
import { asCode, asLiteral, isReplaceable, linkedForPreview, missingFields, newBomLine, newOpLine, pickOperation, withCatalogFigures, withoutCatalogFigures, type OpLine } from "./lines.ts";
import { evaluate } from "@confire/config-engine";

test("asCode reads a single quoted literal, and nothing else", () => {
  expect(asCode('"AL-6060"')).toBe("AL-6060");
  expect(asCode(' "X" ')).toBe("X");
  expect(asCode('finish == "a" ? "X" : "Y"')).toBeUndefined();
  expect(asCode("")).toBeUndefined();
});

test("isReplaceable: empty, plain numbers and bare catalog names, nothing else", () => {
  for (const s of [undefined, "", " 60 ", "0.5", "beasRun"]) expect(isReplaceable(s)).toBe(true);
  for (const s of ["beasRun * holes", "area * 0.02", "qty"]) expect(isReplaceable(s)).toBe(false);
});

test("pickOperation fills the line and keeps the author's formulas", () => {
  const before: OpLine = { resource: "OLD", setupMin: "60", runMinPerUnit: "beasRun * holes", ratePerHour: "beasRate" };
  expect(pickOperation(before, { OperationId: "ACA_AGUJEROS", Description: "AGUJEROS", ResourceId: "ACA_ACABADO         " })).toEqual({
    operationId: '"ACA_AGUJEROS"', desc: "AGUJEROS", resource: "ACA_ACABADO",
    setupMin: "beasSetup", runMinPerUnit: "beasRun * holes", ratePerHour: "beasRate",
  });
});

test("withCatalogFigures fills only the replaceable figures", () => {
  expect(withCatalogFigures({ operationId: "op", setupMin: "", runMinPerUnit: "area * 0.02", ratePerHour: "21" }))
    .toEqual({ operationId: "op", setupMin: "beasSetup", runMinPerUnit: "area * 0.02", ratePerHour: "beasRate" });
});

test("missingFields names the empty required fields", () => {
  expect(missingFields("routing", newOpLine())).toEqual(["setupMin", "runMinPerUnit", "ratePerHour"]);
  expect(missingFields("bom", newBomLine())).toEqual(["itemCode"]);
});

test("a manual line is complete without an operation", () => {
  expect(missingFields("routing", { resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" })).toEqual([]);
});

test("linkedForPreview asks the resolve for literal operations only, so typing a formula never refetches", () => {
  const routing: OpLine[] = [
    { operationId: '"ACA_AGUJEROS"', setupMin: "beasSetup", runMinPerUnit: "beasRun * holes", ratePerHour: "beasRate" },
    { operationId: 'finish == "a" ? "X" : "Y"', setupMin: "1", runMinPerUnit: "1", ratePerHour: "1" },
    { resource: "SAW", setupMin: "1", runMinPerUnit: "1", ratePerHour: "1" },
  ];
  expect(linkedForPreview(routing)).toEqual([{ operationId: '"ACA_AGUJEROS"', setupMin: "0", runMinPerUnit: "0", ratePerHour: "0" }]);
});

test("unlinking clears the bare catalog names a pick wrote, and keeps the author's formulas", () => {
  expect(withoutCatalogFigures({ setupMin: "beasSetup", runMinPerUnit: "beasRun * holes", ratePerHour: "beasRate" }))
    .toEqual({ setupMin: "", runMinPerUnit: "beasRun * holes", ratePerHour: "" });
});

test("asLiteral writes what asCode and the DSL read back, quotes and backslashes too", () => {
  for (const text of ['TUBO 1/2"', "a\\b", "plain"]) {
    expect(asCode(asLiteral(text))).toBe(text);
    expect(evaluate(asLiteral(text), { vars: {} })).toBe(text);
  }
});
