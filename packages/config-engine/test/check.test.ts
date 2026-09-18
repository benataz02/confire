import { describe, expect, it, test } from "bun:test";
import { bomItemCodes, checkModel, referencedTables } from "../src/check";
import type { ModelDef } from "../src/model";
import { fieldGroup, model } from "./fixture";

const PRICES = [{ name: "prices", columns: ["code", "price"] }];

describe("checkModel", () => {
  test("fixture model is clean", () => {
    expect(checkModel(model, PRICES)).toEqual([]);
  });

  test("a model without an items table cannot be saved", () => {
    const bad = structuredClone(model);
    bad.tables = [];
    expect(checkModel(bad, PRICES).map((i) => i.message))
      .toContain("a model needs an items table — it is what becomes the quotation lines");
  });

  test("unknown identifier in a bom expr, with span and path", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "sektion * 2";
    const issues = checkModel(bad, PRICES);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe("bom[0].qty");
    expect(issues[0]!.message).toContain("sektion");
    expect(issues[0]!.from).toBe(0);
    expect(issues[0]!.to).toBe(7);
  });

  test("qty allowed in bom but not in constraints", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "expr", assert: "qty > 0", message: "x" });
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.path === "constraints[2].assert")).toBe(true);
  });

  test("unitCost allowed only in pricing", () => {
    const bad = structuredClone(model);
    bad.bom[0]!.qty = "unitCost";
    expect(checkModel(bad, PRICES).length).toBe(1);
    expect(checkModel(model, PRICES)).toEqual([]); // priceExpr uses unitCost and is fine
  });

  test("parse error surfaces with span", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "1 + ";
    const issues = checkModel(bad, PRICES);
    expect(issues[0]!.path).toBe("computed[0].expr");
    expect(typeof issues[0]!.from).toBe("number");
  });

  test("computed cycle detected", () => {
    const bad = structuredClone(model);
    bad.computed = [
      { key: "a", expr: "b + 1" },
      { key: "b", expr: "a + 1" },
    ];
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.message.includes("cycle"))).toBe(true);
  });

  test("duplicate keys detected", () => {
    const bad = structuredClone(model);
    bad.computed.push({ key: "material", expr: "1" });
    expect(checkModel(bad, PRICES).some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  test("table constraint: bad arity and unknown param", () => {
    const bad = structuredClone(model);
    bad.constraints.push({ kind: "table", params: ["material", "nosuch"], rows: [["steel"]], mode: "allow" });
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.message.includes("nosuch"))).toBe(true);
    expect(issues.some((i) => i.message.includes("arity") || i.message.includes("values"))).toBe(true);
  });

  test("table constraint: excluded param is rejected", () => {
    const bad = structuredClone(model);
    bad.parameters.find((p) => p.key === "color")!.excludeFromDomains = true;
    const issues = checkModel(bad, PRICES);
    expect(issues.some((i) => i.message.includes("excluded from engine domains") && i.message.includes("color"))).toBe(true);
  });

  test("structure referencing a missing param", () => {
    const bad = structuredClone(model);
    fieldGroup(bad).params.push("ghost");
    expect(checkModel(bad, PRICES).some((i) => i.message.includes("ghost"))).toBe(true);
  });

  test("unknown function reported", () => {
    const bad = structuredClone(model);
    bad.computed[0]!.expr = "NOPE(1)";
    expect(checkModel(bad, PRICES).some((i) => i.message.includes("NOPE"))).toBe(true);
  });

  test("history: valid config is clean", () => {
    const m = structuredClone(model);
    m.history = {
      table: "past",
      mappings: [
        { param: "material", column: "mat", match: "exact", weight: 2 },
        { param: "section", column: "sec", match: "closeness", weight: 1 },
      ],
      display: ["price"],
    };
    expect(checkModel(m, [...PRICES, { name: "past", columns: ["mat", "sec", "price"] }])).toEqual([]);
  });

  test("history: unknown param, closeness on non-number, unknown columns", () => {
    const m = structuredClone(model);
    m.history = {
      table: "past",
      mappings: [
        { param: "ghost", column: "mat", match: "exact", weight: 1 },
        { param: "material", column: "mat", match: "closeness", weight: 1 },
        { param: "section", column: "missing", match: "exact", weight: 1 },
      ],
      display: ["also_missing"],
    };
    const issues = checkModel(m, [...PRICES, { name: "past", columns: ["mat"] }]);
    expect(issues.some((i) => i.path === "history.mappings[0]" && i.message.includes("ghost"))).toBe(true);
    expect(issues.some((i) => i.path === "history.mappings[1]" && i.message.includes("closeness"))).toBe(true);
    expect(issues.some((i) => i.path === "history.mappings[2]" && i.message.includes("missing"))).toBe(true);
    expect(issues.some((i) => i.path === "history.display[0]")).toBe(true);
  });

  test("history: mappings without a query flagged", () => {
    const m = structuredClone(model);
    m.history = { mappings: [{ param: "material", column: "mat", match: "exact", weight: 1 }], display: [] };
    expect(checkModel(m, PRICES).some((i) => i.path === "history.table")).toBe(true);
  });

  test("history: unknown masterdata name flagged", () => {
    const m = structuredClone(model);
    m.history = { table: "ghost", mappings: [], display: [] };
    expect(checkModel(m, PRICES).some((i) => i.path === "history.table" && i.message.includes("ghost"))).toBe(true);
  });
});

describe("lookup ref validation", () => {
  const withRef = (ref: object, extra: Partial<ModelDef> = {}): ModelDef => ({
    ...structuredClone(model),
    parameters: [
      ...structuredClone(model).parameters,
      { key: "pick", label: "Pick", type: "string", ui: "select", domain: { kind: "options", ref: ref as never } },
    ],
    ...extra,
  });

  it("flags a ref to an unknown table", () => {
    const issues = checkModel(withRef({ source: "table", table: "ghost", valueCol: "x" }), [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.message.includes("unknown table 'ghost'"))).toBe(true);
  });

  it("flags unknown columns in a ref", () => {
    const issues = checkModel(withRef({ source: "table", table: "prices", valueCol: "nope", columns: ["alsoNope"] }), [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.message.includes("no column 'nope'"))).toBe(true);
    expect(issues.some((i) => i.message.includes("no column 'alsoNope'"))).toBe(true);
  });

  it("puts derived keys in scope and flags collisions", () => {
    const ok = checkModel(
      withRef({ source: "table", table: "prices", valueCol: "code" }, { computed: [{ key: "p2", expr: "pick_price * 2" }] }),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(ok).toEqual([]);
    const hidden = checkModel(
      withRef(
        { source: "table", table: "prices", valueCol: "code", columns: [] },
        { computed: [{ key: "p2", expr: "pick_price * 2" }] },
      ),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(hidden).toEqual([]);
    const collide = checkModel(
      withRef({ source: "table", table: "prices", valueCol: "code" }, { computed: [{ key: "pick_price", expr: "1" }] }),
      [{ name: "prices", columns: ["code", "price"] }],
    );
    expect(collide.some((i) => i.message.includes("collides"))).toBe(true);
  });

  it("resolves query refs against the tenant's masterdata, same namespace as table refs", () => {
    const m = withRef({ source: "query", table: "items", valueCol: "ItemCode" });
    expect(checkModel(m, [
      { name: "prices", columns: ["code", "price"] },
      { name: "items", columns: ["ItemCode", "ItemName"] },
    ])).toEqual([]);
  });

  it("flags two derived keys colliding with each other (not a pre-existing key)", () => {
    const bad = structuredClone(model);
    bad.parameters.push(
      {
        key: "a",
        label: "A",
        type: "string",
        ui: "select",
        domain: { kind: "options", ref: { source: "table", table: "t1", valueCol: "x", columns: ["b_c"] } as never },
      },
      {
        key: "a_b",
        label: "AB",
        type: "string",
        ui: "select",
        domain: { kind: "options", ref: { source: "table", table: "t2", valueCol: "y", columns: ["c"] } as never },
      },
    );
    const issues = checkModel(bad, [
      { name: "t1", columns: ["x", "b_c"] },
      { name: "t2", columns: ["y", "c"] },
    ]);
    expect(issues.some((i) => i.message.includes("a_b_c") && i.message.includes("collides"))).toBe(true);
  });

  it("flags a derived key placed in the structure like a real parameter", () => {
    const bad = withRef({ source: "table", table: "prices", valueCol: "code" });
    fieldGroup(bad).params.push("pick_price");
    const issues = checkModel(bad, [{ name: "prices", columns: ["code", "price"] }]);
    expect(issues.some((i) => i.path === "structure" && i.message.includes("pick_price"))).toBe(true);
  });
});

describe("referencedTables", () => {
  it("collects domain refs and statically-known LOOKUP names", () => {
    const m = structuredClone(model);
    m.parameters[0]!.domain = { kind: "options", ref: { source: "query", table: "items", valueCol: "ItemCode" } };
    m.bom[0]!.qty = 'LOOKUP("prices", "code", material, "price")';
    m.pricing.priceExpr = 'unitCost * LOOKUP("margins", "k", "std", "v")';
    expect([...referencedTables(m)].sort()).toEqual(["items", "margins", "prices"]);
  });

  it("keeps going past an unparseable expression, and ignores manual domains", () => {
    const m = structuredClone(model);
    m.computed[0]!.expr = "1 + "; // checkModel's problem, not this one's
    m.bom[0]!.qty = 'LOOKUP("prices", "code", material, "price")';
    m.parameters[0]!.domain = { kind: "options", ref: { source: "manual", options: [{ value: "a" }] } };
    expect([...referencedTables(m)]).toEqual(["prices"]); // still found, past the bad expression
  });

  it("does not treat the history cache source as a live lookup", () => {
    const m = structuredClone(model);
    m.history = { table: "past", mappings: [], display: [] };
    expect([...referencedTables(m)]).toEqual([]); // "past" is a history cache source, not a lookup
  });
});

describe("bomItemCodes", () => {
  const withItem = (itemCode: string): ModelDef => {
    const m = structuredClone(model);
    m.bom = [{ id: "l", itemCode, qty: "1" }];
    return m;
  };

  it("reads the literal the value help writes", () => {
    expect(bomItemCodes(withItem('"CBL-STL"'))).toEqual(["CBL-STL"]);
  });

  it("takes both branches of a conditional item code", () => {
    expect(bomItemCodes(withItem('material == "steel" ? "A" : "B"')).sort())
      .toEqual(["A", "B", "steel"]); // the condition's literal rides along; B1 just returns nothing for it
  });

  it("expands a parameter-held item code over its resolved domain", () => {
    const domains = { material: [{ value: "COND-steel" }, { value: "COND-alu" }] };
    expect(bomItemCodes(withItem("material"), domains).sort()).toEqual(["COND-alu", "COND-steel"]);
  });

  it("yields nothing for a code only decidable at evaluation time", () => {
    expect(bomItemCodes(withItem('CONCAT("X", 1 + 1)'))).toEqual(["X"]);
    expect(bomItemCodes(withItem("1 + "))).toEqual([]); // unparseable: checkModel's problem
  });
});
