# Tenant Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tenant's models carry visuals written for that tenant — inputs as formulas, outputs as values formulas read, a picture beside a field group — and ship hera's sheet layout as the first.

**Architecture:** A visual is two halves keyed by one kind id: a pure calculation in `packages/config-engine` (it runs inside `propagate`, on the server and in the builder preview) and a lazily loaded React drawing in `packages/ui`. A model places a visual in a group like a table; its outputs join the formula scope as `<key>_<output>`, its view rides `FormState.visuals` to the staff form only.

**Tech Stack:** Bun, TypeScript, zod 4, React 19, UI5 Web Components for React, oRPC v2 beta, TanStack Router.

**Spec:** `docs/superpowers/specs/2026-11-09-tenant-visuals-design.md`

## Global Constraints

- Bun only (`bun test …`, `bunx tsc -p <project>/tsconfig.json --noEmit`); type-checking is per project and is the gate.
- Imports carry explicit `.ts`/`.tsx` extensions; `verbatimModuleSyntax` is on, so types use `import type`.
- `packages/config-engine` stays pure and dependency-free (zod only): no React, no I/O.
- Kind id `hera.sheetLayout`, `tenants: ["hera"]` (tenant slugs).
- Outputs are named `<visual key>_<output>`; hera's outputs are `piezas` and `aprovechamiento`.
- One sheet calculation stays within **50 ms** for sheets up to 3000×1500 and pieces down to 6 mm.
- Guillotine layouts only; pieces turn 90° freely; gap X/Y follow the sheet's axes whichever way a piece faces; margin X at both ends along the length (`largoFormato`), margin Y at both sides along the width (`anchoFormato`).
- `aprovechamiento` = pieces' total area ÷ whole sheet area (margins included) × 100, rounded to a whole percent.
- Display only — no interactions. Staff only — the portal never receives a visual. Chat and MCP tool results carry no drawing data.
- Every colour is a Horizon theme parameter (`var(--sap…)`), never a raw colour. UI texts go through the i18n bundles in en, es and eu.
- `// ponytail:` comments mark deliberate simplifications with their ceiling and upgrade path.
- The working tree carries unrelated uncommitted work: each commit adds only the files its task lists. Commit messages end with the session's attribution lines.

## Review Focus

- **An empty items row** (no article picked: `items_salesLength` sums to 0) must leave the visual undecided — no count, an empty state, no crash. → Task 1 (`nest` refuses a 0 piece), Task 4 (input `"0"` leaves outputs absent).
- **Decimal millimetres** (a 120.5 × 70.25 piece) must not lose a piece to float error or produce overlapping pieces. → Task 1 (geometry check on a decimal case).
- **A piece bigger than the usable sheet** is a decided answer: 0 pieces, the empty sheet drawn. → Task 1.
- **More than one items row** (ALUMIGRAF's `IF(items_count == 1, …, null)` inputs) must leave the visual undecided without breaking the rest of the form. → Task 4 (input `"null"`).
- **A client opening a request** on a model that places a visual must see the form without it and without a crash (the group still lists the key). → Task 5 (projection test).

## Test model

Task 3 adds this to `packages/config-engine/test/fixture.ts`; tests in other packages copy it (it is small, and they cannot import the engine's test folder). The visual sits in a group with one parameter, the items grid in a group of its own (a group holding the grid may carry no `visibleWhen`):

```ts
export const SHEET_INPUTS = { sheetLength: "1000", sheetWidth: "500", pieceLength: "120", pieceWidth: "70", gapX: "3", gapY: "3", marginX: "10", marginY: "10" };
export const withSheet = (over: Partial<Visual> = {}, extra: Partial<ModelDef> = {}): ModelDef => ({
  name: "Sheet",
  parameters: [{ key: "width", label: "Width", type: "number", ui: "input" }],
  structure: { sections: [{ key: "s", title: "S", groups: [
    { key: "g", title: "G", params: ["width", "hoja"] },
    { key: "it", title: "Items", params: ["items"] },
  ] }] },
  computed: [{ key: "perSheet", expr: "hoja_piezas" }],
  tables: [itemsTable()], constraints: [], bom: [], routing: [],
  pricing: { margin: 20, quoteItemCode: "Q", priceList: 1 },
  batchDefaults: [1],
  visuals: [{ key: "hoja", kind: "hera.sheetLayout", inputs: SHEET_INPUTS, ...over }],
  ...extra,
});
const lookups: ResolvedLookups = { domains: {}, tables: {} };
```

`width` has no default, so an input reading it is unbound.

---

### Task 1: Hera's sheet layout calculation

**Files:**
- Create: `packages/config-engine/src/visuals/types.ts`
- Create: `packages/config-engine/src/visuals/hera/sheetLayout.ts`
- Test: `packages/config-engine/test/visuals-sheet.test.ts`

**Interfaces:**
- Produces (`visuals/types.ts`):
  ```ts
  export type VisualIO = Record<string, { type: "number" | "string" | "boolean"; label: string }>;
  export type VisualResult = { outputs: Record<string, Val>; view: unknown };
  export type VisualCalc = {
    kind: string; tenants: string[]; label: string;
    inputs: VisualIO; outputs: VisualIO;
    /** undefined = undecided: the inputs make no sense (a zero piece, a negative gap) */
    compute: (inputs: Record<string, Val>) => VisualResult | undefined;
  };
  ```
- Produces (`visuals/hera/sheetLayout.ts`):
  ```ts
  export type SheetInputs = { sheetLength: number; sheetWidth: number; pieceLength: number; pieceWidth: number; gapX: number; gapY: number; marginX: number; marginY: number };
  export type SheetBlock = { x: number; y: number; columns: number; rows: number; rotated: boolean };
  export type SheetView = { sheet: [number, number]; margin: [number, number]; piece: [number, number]; gap: [number, number]; blocks: SheetBlock[]; count: number; used: number };
  export function nest(i: SheetInputs): SheetView | undefined;
  export function sheetPieces(v: SheetView): { x: number; y: number; w: number; h: number; rotated: boolean }[];
  export const sheetLayout: VisualCalc; // kind "hera.sheetLayout", tenants ["hera"], outputs { piezas, aprovechamiento }
  ```
  Block coordinates are real millimetres from the sheet's top-left corner (margins included). A block's piece is `piece` as given (length along X) when not rotated, swapped when rotated; its column pitch is piece width along X + `gapX`, its row pitch piece height along Y + `gapY`. `count` = Σ columns × rows; `used` = the aprovechamiento percentage.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { nest, sheetLayout, sheetPieces, type SheetInputs } from "../src/visuals/hera/sheetLayout.ts";

const laser: SheetInputs = { sheetLength: 1000, sheetWidth: 500, pieceLength: 120, pieceWidth: 70, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };
const punz: SheetInputs = { ...laser, gapX: 5, gapY: 12, marginX: 45, marginY: 50 };

/** Every piece inside the margins; any two pieces apart by at least gapX along X or gapY along Y. */
function assertValid(i: SheetInputs) {
  const v = nest(i)!;
  const ps = sheetPieces(v);
  expect(ps.length).toBe(v.count);
  const e = 1e-6;
  for (const p of ps) {
    expect(p.x).toBeGreaterThanOrEqual(i.marginX - e);
    expect(p.y).toBeGreaterThanOrEqual(i.marginY - e);
    expect(p.x + p.w).toBeLessThanOrEqual(i.sheetLength - i.marginX + e);
    expect(p.y + p.h).toBeLessThanOrEqual(i.sheetWidth - i.marginY + e);
  }
  for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
    const p = ps[a]!, q = ps[b]!;
    const apartX = p.x + p.w + i.gapX <= q.x + e || q.x + q.w + i.gapX <= p.x + e;
    const apartY = p.y + p.h + i.gapY <= q.y + e || q.y + q.h + i.gapY <= p.y + e;
    expect(apartX || apartY).toBe(true);
  }
}

describe("hera sheet layout", () => {
  test("mixes orientations: 48 on the laser reference (42 all one way)", () => {
    expect(nest(laser)!.count).toBe(48);
    expect(nest(laser)!.used).toBe(81);
    assertValid(laser);
  });
  test("punzonado esq. redondeadas reference: 36", () => {
    expect(nest(punz)!.count).toBe(36);
    assertValid(punz);
  });
  test("decimal millimetres keep a valid layout", () => assertValid({ ...laser, pieceLength: 120.5, pieceWidth: 70.25 }));
  test("an exact fit counts its last piece", () => {
    expect(nest({ sheetLength: 100, sheetWidth: 50, pieceLength: 50, pieceWidth: 25, gapX: 0, gapY: 0, marginX: 0, marginY: 0 })!.count).toBe(4);
  });
  test("a piece bigger than the usable sheet is 0 pieces, not undecided", () => {
    const v = nest({ ...laser, pieceLength: 2000 })!;
    expect(v.count).toBe(0);
    expect(v.blocks).toEqual([]);
  });
  test("nonsense inputs are undecided", () => {
    expect(nest({ ...laser, pieceLength: 0 })).toBeUndefined();
    expect(nest({ ...laser, gapX: -1 })).toBeUndefined();
    expect(nest({ ...laser, sheetWidth: Number.NaN })).toBeUndefined();
  });
  test("big sheets stay within 50 ms", () => {
    const big: SheetInputs = { sheetLength: 3000, sheetWidth: 1500, pieceLength: 40, pieceWidth: 6, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };
    nest(big); // warm the JIT
    const t = performance.now();
    expect(nest(big)!.count).toBeGreaterThanOrEqual(11428);
    expect(performance.now() - t).toBeLessThan(50);
    expect(nest({ ...big, pieceLength: 37, pieceWidth: 23 })!.count).toBeGreaterThanOrEqual(4249);
  });
  test("compute: outputs and view from one run; non-numbers undecided", () => {
    const r = sheetLayout.compute({ ...laser })!;
    expect(r.outputs).toEqual({ piezas: 48, aprovechamiento: 81 });
    expect((r.view as { count: number }).count).toBe(48);
    expect(sheetLayout.compute({ ...laser, pieceLength: "120" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/config-engine/test/visuals-sheet.test.ts`
Expected: FAIL — cannot resolve `../src/visuals/hera/sheetLayout.ts`.

- [ ] **Step 3: Implement `types.ts` and `nest`, `sheetPieces`, `sheetLayout` in `sheetLayout.ts`**

Validity first: every input finite; sheet and piece sizes > 0; gaps and margins ≥ 0 — else `undefined`. The search is a **three-stage guillotine** (strips → columns → stacked pieces), tried along both axes. It matched the full guillotine optimum on both references and 300 random sheets while running the 3000×1500 cases in under 40 ms (planning probe):

```
inflate by the gaps:  X = L − 2·mx + gx,  Y = W − 2·my + gy
                      upright cell (a, b) = (l + gx, w + gy);  rotated cell (c, d) = (w + gx, l + gy)
run(X, Y, a, b, c, d):                     // strips stacked along Y, each spanning X
  H = { k·b ≤ Y } ∪ { k·d ≤ Y }  (k ≥ 1)    // the strip heights worth trying
  value(h) = max over i in 0..⌊X/a⌋ of  i·⌊h/b⌋ + ⌊(X − i·a)/c⌋·⌊h/d⌋     (keep the best i)
  R = sorted { i·b + j·d ≤ Y }               // raster points; ⌊v⌋_R = largest point ≤ v (binary search)
  g(0) = 0;  g(r) = max over h in H, h ≤ r, of value(h) + g(⌊r − h⌋_R)     (keep the choice)
  walk the choices back from g(max R): each strip → an upright block (i columns × ⌊h/b⌋ rows)
  and a rotated block (⌊(X − i·a)/c⌋ columns × ⌊h/d⌋ rows); drop empty blocks
best of run(X, Y, a, b, c, d) and run(Y, X, b, a, d, c) — the second transposed back:
  a block at (u, v) with p columns × q rows becomes (x = v, y = u), q columns × p rows, same `rotated`
offset every block by (mx, my); every ⌊⌋ takes +1e-9 so a decimal exact fit is not lost
```

Use typed arrays and integer indices, not string-keyed maps (the probe's string-keyed full search did not finish in two minutes on 3000×1500). Add `// ponytail: three-stage guillotine — matched the full guillotine search in every probe; a deeper search only if a real quote shows a gap`.

`sheetLayout`: label `"Piezas en formato"`; inputs `sheetLength`, `sheetWidth`, `pieceLength`, `pieceWidth`, `gapX`, `gapY`, `marginX`, `marginY` (all `number`, labels `Largo formato`, `Ancho formato`, `Largo pieza`, `Ancho pieza`, `Paso X`, `Paso Y`, `Margen X`, `Margen Y`); outputs `piezas` (`Piezas por formato`) and `aprovechamiento` (`Aprovechamiento (%)`); `compute` returns `undefined` unless every input is a number, else `{ outputs: { piezas: v.count, aprovechamiento: v.used }, view: v }`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/config-engine/test/visuals-sheet.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/visuals/types.ts packages/config-engine/src/visuals/hera/sheetLayout.ts packages/config-engine/test/visuals-sheet.test.ts
git commit -m "feat(engine): hera sheet layout calculation"
```

---

### Task 2: The visual registry

**Files:**
- Create: `packages/config-engine/src/visuals/index.ts`
- Modify: `packages/config-engine/src/index.ts` (exports)
- Test: `packages/config-engine/test/visuals-registry.test.ts`

**Interfaces:**
- Consumes: `VisualCalc`, `sheetLayout` (Task 1).
- Produces:
  ```ts
  export const VISUALS: Record<string, VisualCalc>;            // { "hera.sheetLayout": sheetLayout }
  export function visualsFor(tenant: string): VisualCalc[];    // the kinds listing that slug
  /** inputs typed per calc.inputs, else undefined; memoized by kind + inputs; a throw is undefined */
  export function computeVisual(calc: VisualCalc, inputs: Record<string, Val | undefined>): VisualResult | undefined;
  ```
  `index.ts` of the package exports `VISUALS`, `visualsFor`, `computeVisual`, `nest`, `sheetPieces` and the types `VisualCalc`, `VisualIO`, `VisualResult`, `SheetView`, `SheetBlock`.

- [ ] **Step 1: Write the failing tests**

```ts
test("visualsFor scopes kinds to their tenants", () => {
  expect(visualsFor("hera").map((v) => v.kind)).toEqual(["hera.sheetLayout"]);
  expect(visualsFor("acme")).toEqual([]);
});
test("computeVisual: undefined for a missing, null or mistyped input", () => {
  const ok = { sheetLength: 1000, sheetWidth: 500, pieceLength: 120, pieceWidth: 70, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };
  const calc = VISUALS["hera.sheetLayout"]!;
  expect(computeVisual(calc, ok)?.outputs.piezas).toBe(48);
  expect(computeVisual(calc, { ...ok, gapX: undefined })).toBeUndefined();
  expect(computeVisual(calc, { ...ok, gapX: null })).toBeUndefined();
  expect(computeVisual(calc, { ...ok, gapX: "3" })).toBeUndefined();
});
test("computeVisual memoizes by inputs and swallows a throw", () => {
  const ok = { sheetLength: 1000, sheetWidth: 500, pieceLength: 120, pieceWidth: 70, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };
  const calc = VISUALS["hera.sheetLayout"]!;
  expect(computeVisual(calc, ok)).toBe(computeVisual(calc, { ...ok }));
  const boom = { ...calc, kind: "test.boom", compute: () => { throw new Error("x"); } };
  expect(computeVisual(boom, ok)).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/config-engine/test/visuals-registry.test.ts`
Expected: FAIL — cannot resolve `../src/visuals/index.ts`.

- [ ] **Step 3: Implement `visuals/index.ts`**

Memo: a `Map` keyed `kind + JSON.stringify(inputs in calc.inputs order)`, cleared when it passes 500 entries (`// ponytail: clear-all memo; an LRU only if a profile shows misses`). Export from the package `index.ts`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/config-engine/test/visuals-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/visuals/index.ts packages/config-engine/src/index.ts packages/config-engine/test/visuals-registry.test.ts
git commit -m "feat(engine): tenant visual registry"
```

---

### Task 3: Visuals in the model — schema, patch, check

**Files:**
- Modify: `packages/config-engine/src/model.ts` (add `VisualZ`, `ModelDefZ.visuals`, `visualOutputKey`)
- Modify: `packages/config-engine/src/model-patch.ts` (`KEYED`, `ModelPatchZ.visuals`)
- Modify: `packages/config-engine/src/check.ts` (`checkModel` third parameter and the visual rules)
- Modify: `packages/config-engine/src/index.ts` (export `VisualZ`, `visualOutputKey`, type `Visual`)
- Modify: `packages/config-engine/test/fixture.ts` (add `SHEET_INPUTS`, `withSheet` — see Test model)
- Test: `packages/config-engine/test/check.test.ts`, `packages/config-engine/test/model-patch.test.ts`

**Interfaces:**
- Consumes: `VISUALS` (Task 2).
- Produces:
  ```ts
  export const VisualZ = z.object({ key: KeyZ, kind: z.string().min(1), title: z.string().optional(), inputs: z.record(z.string(), z.string()) });
  export type Visual = z.infer<typeof VisualZ>;
  // ModelDefZ: visuals: z.array(VisualZ).optional()   — optional like `tables`, no stored model changes
  export const visualOutputKey = (key: string, output: string) => `${key}_${output}`;
  export function checkModel(model: ModelDef, knownTables?: KnownTable[], tenant?: string): Issue[];
  ```
  `tenant` absent (the builder's calls) skips only the tenant rule; the server passes it (Task 5).

- [ ] **Step 1: Write the failing tests** — in `check.test.ts`, with `withSheet`/`SHEET_INPUTS` from the fixture:

```ts
const paths = (m: ModelDef, tenant?: string) => checkModel(m, [], tenant).map((i) => i.path);
const param = (key: string) => ({ key, label: key, type: "number" as const, ui: "input" as const });

test("a placed visual whose outputs a formula reads passes", () => {
  expect(checkModel(withSheet(), [], "hera")).toEqual([]);
  expect(checkModel(withSheet(), [])).toEqual([]); // the builder passes no tenant
});
test("another tenant's or an unknown kind is refused on the kind", () => {
  expect(paths(withSheet(), "acme")).toContain("visuals[0].kind");
  expect(paths(withSheet({ kind: "nope" }), "hera")).toContain("visuals[0].kind");
});
test("inputs: each declared one needs a formula, no extra ones, never its own outputs", () => {
  const { gapX: _g, ...rest } = SHEET_INPUTS;
  expect(paths(withSheet({ inputs: rest }), "hera")).toContain("visuals[0].inputs.gapX");
  expect(paths(withSheet({ inputs: { ...SHEET_INPUTS, foo: "1" } }), "hera")).toContain("visuals[0].inputs.foo");
  expect(paths(withSheet({ inputs: { ...SHEET_INPUTS, sheetLength: "hoja_piezas" } }), "hera")).toContain("visuals[0].inputs.sheetLength");
});
test("keys: the visual's own and its outputs share the formula namespace", () => {
  for (const clash of ["hoja", "hoja_piezas"]) {
    const m = withSheet({}, { parameters: [param("width"), param(clash)] });
    expect(paths(m, "hera")).toContain("visuals[0]");
  }
});
test("structure: a visual is placed at most once, and a group holds at most one", () => {
  const twice = withSheet({}, { structure: { sections: [{ key: "s", title: "S", groups: [
    { key: "g", title: "G", params: ["width", "hoja"] }, { key: "h", title: "H", params: ["hoja"] }, { key: "it", title: "I", params: ["items"] },
  ] }] } });
  expect(paths(twice, "hera")).toContain("structure");
  const two = withSheet({}, {
    visuals: [{ key: "hoja", kind: "hera.sheetLayout", inputs: SHEET_INPUTS }, { key: "hoja2", kind: "hera.sheetLayout", inputs: SHEET_INPUTS }],
    structure: { sections: [{ key: "s", title: "S", groups: [{ key: "g", title: "G", params: ["width", "hoja", "hoja2"] }, { key: "it", title: "I", params: ["items"] }] }] },
  });
  expect(paths(two, "hera")).toContain("structure");
});
```

In `model-patch.test.ts`: `diffModel` of a model gaining the visual yields `{ visuals: { upsert: [visual] } }` (plus the structure change), and `applyModelPatch` of it reproduces the model; removing it yields `visuals.remove: ["hoja"]`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/config-engine/test/check.test.ts packages/config-engine/test/model-patch.test.ts`
Expected: FAIL — `visuals` is not a `ModelDef` field / no issues reported.

- [ ] **Step 3: Implement**

`model-patch.ts`: add `"visuals"` to `KEYED` and `visuals: keyed(VisualZ)` to `ModelPatchZ` (its `_covered` check fails to compile until you do). `check.ts`, before `base` is built (next to the aggregates): each visual's key is checked against parameters, computed values and tables (`visuals[i]`, "A parameter, computed value or table is already called '<key>'."); its kind against `VISUALS` (`visuals[i].kind`, "unknown visual '<kind>'"), and, when `tenant` is given, against `calc.tenants` (`visuals[i].kind`, "This visual is not available in this workspace."); its outputs' `visualOutputKey`s join `base`, collision-checked like aggregates (`visuals[i]`). After `base`: each declared input missing → `visuals[i].inputs.<name>` "Give this input a formula"; each extra → `visuals[i].inputs.<name>` "'<name>' is not an input of this visual"; each formula through `checkExpr` with `base` minus the visual's own outputs. The structure check accepts a visual key once (else "visual '<key>' is placed more than once") and refuses a group listing two (`structure`, "A group shows at most one visual."). An unplaced visual is allowed: its outputs still compute.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/config-engine`
Expected: PASS, the whole engine suite.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/model.ts packages/config-engine/src/model-patch.ts packages/config-engine/src/check.ts packages/config-engine/src/index.ts packages/config-engine/test/check.test.ts packages/config-engine/test/model-patch.test.ts
git commit -m "feat(engine): visuals in the model, checked per tenant"
```

---

### Task 4: Outputs in the calculation, views in the form state

**Files:**
- Modify: `packages/config-engine/src/propagate.ts` (`Bindings.views`, the settle loop, `maxIter`)
- Modify: `packages/config-engine/src/form-state.ts` (`FormState.visuals`)
- Test: `packages/config-engine/test/propagate.test.ts`, `packages/config-engine/test/form-state.test.ts`

**Interfaces:**
- Consumes: `computeVisual`, `VISUALS` (Task 2); `Visual`, `visualOutputKey` (Task 3).
- Produces:
  ```ts
  // Bindings (and so Propagation) gains:
  views: Record<string, unknown>;          // visual key -> its last view; absent key = undecided
  // FormState gains:
  visuals?: Record<string, unknown>;       // placed visuals in a shown section and group, with a view; absent when none
  ```

- [ ] **Step 1: Write the failing tests** — with `withSheet`/`SHEET_INPUTS` from the fixture:

```ts
test("a visual's outputs are values every formula reads", () => {
  const p = propagate(withSheet(), lookups, {});
  expect(p.values.hoja_piezas).toBe(48);
  expect(p.values.hoja_aprovechamiento).toBe(81);
  expect(p.values.perSheet).toBe(48);
  expect((p.views.hoja as { count: number }).count).toBe(48);
});
test("an undecided input leaves the outputs absent and no view", () => {
  // an empty items row (0), several rows (ALUMIGRAF's IF → null), an unbound parameter
  for (const pieceLength of ["0", "null", "width"]) {
    const p = propagate(withSheet({ inputs: { ...SHEET_INPUTS, pieceLength } }), lookups, {});
    expect("hoja_piezas" in p.values).toBe(false);
    expect(p.views.hoja).toBeUndefined();
  }
});
```

In `form-state.test.ts`: for `withSheet()`, `(formState(m, lookups, propagate(m, lookups, {}), {}).visuals!.hoja as { count: number }).count` is 48; `visuals` is `undefined` when group `g` has `visibleWhen: "false"`, and when `hoja` is removed from every group's `params`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/config-engine/test/propagate.test.ts packages/config-engine/test/form-state.test.ts`
Expected: FAIL — `hoja_piezas` undefined / `views` undefined.

- [ ] **Step 3: Implement**

In `settle`'s fixed-point loop, after the table aggregates: for each `model.visuals` entry with a known kind, evaluate each input with `tryEval` (undefined or `null` = undecided), call `computeVisual`; set each output's `visualOutputKey` in `values` (marking `changed` when it differs), or delete those keys when undecided (marking `changed` if one was present); record the view in a local `views` map returned in `Bindings`. Add `(model.visuals?.length ?? 0)` to `maxIter`. Outputs are computed whatever the visual's group visibility — they are calculation, like computed values; only the drawing follows visibility. In `formState`, set `visuals` from `prop.views` for each visual placed in a group whose `structureId(s)` and `structureId(s, g)` are not in `prop.hiddenStructure`, omitting the key entirely when empty (as `hidden` is).

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/config-engine && bunx tsc -p packages/config-engine/tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine/src/propagate.ts packages/config-engine/src/form-state.ts packages/config-engine/test/propagate.test.ts packages/config-engine/test/form-state.test.ts
git commit -m "feat(engine): visual outputs in the calculation, views in the form state"
```

---

### Task 5: Server — the tenant gate, the portal fence, the chat's tools

**Files:**
- Modify: `apps/server/src/orpc/base.ts` (`membershipOf` selects the slug; `userProcedure` adds `tenantSlug` to the context)
- Modify: `apps/server/src/orpc/routers/models.ts` (`assertValid(definition, known, tenantSlug)` in `create` and `save`)
- Modify: `apps/server/src/portal/projection.ts` (`portalStructure` drops visual keys; `toPortalForm` drops `visuals`)
- Modify: `apps/server/src/assistant/tools.ts` (`withoutVisuals`, applied in `procedureTool`)
- Test: `apps/server/test/models.test.ts`, `apps/server/test/projection.test.ts`, `apps/server/test/assistant-tools.test.ts`

**Interfaces:**
- Consumes: `checkModel(model, known, tenant)` (Task 3); `FormState.visuals` (Task 4).
- Produces: `context.tenantSlug: string` on every `userProcedure`/`adminProcedure`; `export function withoutVisuals(out: unknown): unknown` in `assistant/tools.ts` — returns `out` with `form.visuals` removed when `out.form` exists, otherwise `out` unchanged.

- [ ] **Step 1: Write the failing tests**

`models.test.ts`: `models.create` with `TEST_MODEL` plus `visuals: [{ key: "hoja", kind: "hera.sheetLayout", inputs: SHEET_INPUTS }]` and `hoja` added to its first group, under a `makeTenant()` tenant (slug `t…`, never `hera`), is refused `BAD_REQUEST` with an issue at `visuals[0].kind`.
`projection.test.ts` (copy `withSheet` — see Test model):
```ts
test("visuals stay home: no visual in the model, its key out of every group, no view in the form", () => {
  const def = withSheet();
  const m = toPortalModelDef(def);
  expect(m.visuals).toBeUndefined();
  expect(m.structure.sections.flatMap((s) => s.groups.flatMap((g) => g.params))).not.toContain("hoja");
  const form = formState(def, lookups, propagate(def, lookups, {}), {});
  expect(form.visuals?.hoja).toBeDefined();
  expect(toPortalForm(form, true).visuals).toBeUndefined();
});
```
`assistant-tools.test.ts`:
```ts
test("tool results carry no drawing data", () => {
  expect(withoutVisuals({ form: { fields: {}, visuals: { hoja: {} } }, missing: [] })).toEqual({ form: { fields: {} }, missing: [] });
  expect(withoutVisuals({ rows: [] })).toEqual({ rows: [] });
});
```

- [ ] **Step 2: Note the baseline, then run to verify they fail**

First run `bun test apps/server` once and write down the failures already there (memory notes five unrelated ones). Then run: `bun test apps/server/test/models.test.ts apps/server/test/projection.test.ts apps/server/test/assistant-tools.test.ts` (Postgres must be up).
Expected: FAIL — the create succeeds; `hoja` still listed; `withoutVisuals` not exported.

- [ ] **Step 3: Implement** — `membershipOf` selects `organization.slug` too; `userProcedure` passes `tenantSlug: slug`. `procedureTool` returns `withoutVisuals(o.slim ? o.slim(out) : out)`, which covers `configs_get`, `configs_calculate`, `configs_select` and MCP (which reuses these tools). `portalStructure` takes the model's visual keys and filters them out of each group's `params`; `toPortalForm` destructures `visuals` away.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/server && bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: the three files PASS; no failure beyond Step 2's baseline; no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orpc/base.ts apps/server/src/orpc/routers/models.ts apps/server/src/portal/projection.ts apps/server/src/assistant/tools.ts apps/server/test/models.test.ts apps/server/test/projection.test.ts apps/server/test/assistant-tools.test.ts
git commit -m "feat(server): visuals gated per tenant, kept from the portal and the chat"
```

---

### Task 6: The drawing — registry, hera's sheet, the form's half-and-half group

**Files:**
- Create: `packages/ui/src/configurator/visuals/index.tsx`
- Create: `packages/ui/src/configurator/visuals/hera/SheetLayoutView.tsx`
- Modify: `packages/ui/src/configurator/ConfiguratorForm.tsx` (`SectionForm`'s group rendering; skip keys naming nothing)
- Modify: `packages/ui/src/configurator/formHelpers.ts` (`groupVisual`)
- Modify: `packages/ui/src/i18n/parts/ui.{en,es,eu}.properties`
- Test: `packages/ui/src/configurator/visuals/registry.test.ts`, `packages/ui/src/configurator/formHelpers.test.ts`

**Interfaces:**
- Consumes: `VISUALS`, `sheetPieces`, `SheetView` (Tasks 1–2); `Visual` (Task 3); `FormState.visuals` (Task 4).
- Produces:
  ```ts
  export const VISUAL_VIEWS: Record<string, LazyExoticComponent<ComponentType<{ view: unknown }>>>; // React.lazy per kind
  export function VisualPanel({ kind, view }: { kind: string; view: unknown | undefined }): JSX.Element;
  // formHelpers.ts
  export function groupVisual(model: ModelDef, group: Group): Visual | undefined; // the visual this group lists, if any
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// registry.test.ts — every calculation has a drawing and every drawing a calculation
test("drawings and calculations name the same kinds", () => {
  expect(Object.keys(VISUAL_VIEWS).sort()).toEqual(Object.keys(VISUALS).sort());
});
// formHelpers.test.ts (copy `withSheet` — see Test model)
test("groupVisual finds the visual a group lists, not a parameter or table", () => {
  expect(groupVisual(withSheet(), { key: "g", title: "", params: ["width", "hoja"] })?.key).toBe("hoja");
  expect(groupVisual(withSheet(), { key: "it", title: "", params: ["items"] })).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/ui/src/configurator`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`VisualPanel`: `view === undefined` → a `Text` with `UI_VISUAL_EMPTY` in the picture's place; else the kind's lazy component inside `Suspense` (fallback `BusyIndicator active`). `SheetLayoutView`: an `<svg viewBox="0 0 L W" width="100%">` with the sheet (`fill: var(--sapGroup_ContentBackground)`, `stroke: var(--sapGroup_ContentBorderColor)`), the usable area dashed inside the margins (`stroke: var(--sapContent_LabelColor)`), each piece of `sheetPieces(view)` filled `var(--sapChart_OrderedColor_1)` upright or `var(--sapChart_OrderedColor_2)` rotated, and under it `UI_SHEET_CAPTION` with `count` and `used`. In `SectionForm`, a group whose `groupVisual` is placed renders one full-width `FormGroup` (`colSpan={FORM_LAYOUT}`, headed like the group) holding one `FormItem className={TABLE_ITEM} data-param={visual.key}`, whose content is a CSS grid `repeat(auto-fit, minmax(18rem, 1fr))`: a nested `<Form layout="S1 M1 L1 XL1">` with the group's visible parameters (`fieldItem`) on one side and `VisualPanel` (`form.visuals?.[visual.key]`) on the other — two equal halves when wide, stacked when narrow, the picture alone at full width when the group has no visible field. A table the same group lists still breaks out below as today. Any group key naming no parameter, table or visual is skipped (the portal's model no longer lists visuals; this keeps an old cached model from crashing the form).

Texts: `UI_VISUAL_EMPTY` — en `Not enough data to draw yet`, es `Faltan datos para dibujarlo`, eu `Datu gehiago behar dira marrazteko`; `UI_SHEET_CAPTION` — en `{0} pieces per sheet · {1}% used`, es `{0} piezas/formato · {1}% aprovechado`, eu `{0} pieza formatuko · %{1} aprobetxatuta`.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/ui && bunx tsc -p packages/ui/tsconfig.json --noEmit && bunx tsc -p apps/portal/tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/configurator/visuals packages/ui/src/configurator/ConfiguratorForm.tsx packages/ui/src/configurator/formHelpers.ts packages/ui/src/configurator/formHelpers.test.ts packages/ui/src/i18n/parts/ui.en.properties packages/ui/src/i18n/parts/ui.es.properties packages/ui/src/i18n/parts/ui.eu.properties
git commit -m "feat(ui): visuals beside their field group"
```

---

### Task 7: The builder — place a visual and write its inputs

**Files:**
- Modify: `apps/app/src/components/model-builder/structureOps.ts` (`RowRef` visual kind)
- Modify: `apps/app/src/components/model-builder/ParamsTab.tsx` (row, Add kind, open)
- Create: `apps/app/src/features/model/visual.ts`
- Create: `apps/app/src/components/model-builder/VisualPage.tsx`
- Create: `apps/app/src/routes/$slug/models/$id.visual.tsx`, `apps/app/src/routes/$slug/models/new.visual.tsx`
- Modify: `apps/app/src/i18n/parts/model.{en,es,eu}.properties`
- Test: `apps/app/src/components/model-builder/structureOps.test.ts`, `apps/app/src/features/model/visual.test.ts`

**Interfaces:**
- Consumes: `visualsFor`, `VISUALS`, `VisualCalc` (Task 2); `Visual`, `checkModel` (Task 3); `tableSearch`/`TableSearch` (existing `paramRoute.ts`, reused as the visual route's search: a key that exists).
- Produces:
  ```ts
  // structureOps.ts
  export type RowRef = … | { kind: "visual"; key: string };   // row key "v:<key>"
  // features/model/visual.ts
  export function toVisualRecord(v: Visual): Row;                  // { key, title, kind, "inputs.<name>": formula }
  export function fromVisualRecord(r: Row): Visual;
  export function visualSections(t: Translate, calc: VisualCalc | undefined, kinds: VisualCalc[]): Section[];
  export function visualIssues(r: Row, draft: ModelDef, tables: TableCols[], openedAs: string, t: Translate): RecordIssues;
  export function commitVisual(d: ModelDef, openedAs: string, v: Visual): ModelDef; // a rename follows into placement
  ```

- [ ] **Step 1: Write the failing tests**

`structureOps.test.ts` (copy `withSheet` — see Test model):
```ts
test("a visual row round-trips its key", () => {
  expect(rowKeyOf({ kind: "visual", key: "hoja" })).toBe("v:hoja");
  expect(parseRowKey("v:hoja")).toEqual({ kind: "visual", key: "hoja" });
});
test("deleting a visual, or its group, drops its definition", () => {
  expect(deleteNodes(withSheet(), [{ kind: "visual", key: "hoja" }]).visuals).toEqual([]);
  expect(deleteNodes(withSheet(), [{ kind: "group", s: 0, g: 0 }]).visuals).toEqual([]);
});
test("a duplicated group leaves its visual out, and copies avoid visual keys", () => {
  expect(copyKeys(withSheet(), [{ kind: "group", s: 0, g: 0 }]).map((k) => k.from)).not.toContain("hoja");
  const m = withSheet({ key: "width2" }, { structure: { sections: [{ key: "s", title: "S", groups: [
    { key: "g", title: "G", params: ["width", "width2"] }, { key: "it", title: "I", params: ["items"] },
  ] }] } });
  expect(copyKeys(m, [{ kind: "param", key: "width" }])[0]!.key).toBe("width3");
});
```
`visual.test.ts`: `fromVisualRecord(toVisualRecord(v))` equals `v`; `visualIssues` puts a missing input's issue on field `inputs.gapX` and a kind issue on field `kind`; `commitVisual(d, "hoja", { ...v, key: "sheet" })` renames the group entry `hoja` → `sheet`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/app/src/components/model-builder/structureOps.test.ts apps/app/src/features/model/visual.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`structureOps.ts`: `rowKeyOf`/`parseRowKey` handle `v:`; `isLeaf` includes `visual` (moving works as for tables); `deleteNodes` filters `visuals` by the dropped keys; `copyKeys`' `leaf` skips visual keys (a copy leaves the visual out, as it leaves the items grid out); `takenIn("ident")` includes visual keys. `ParamsTab.tsx`: `AddKind` gains `"visual"` (label `MODEL_VISUAL`, icon `"picture"`), addable when a group is targeted and `visualsFor(slug)` is non-empty (slug from `useParams({ from: "/$slug" })`); Add places `{ key: <unique "visual<n>">, kind: visualsFor(slug)[0].kind, inputs: {} }` like `addTable` and opens it; a visual row shows its title or key, detail = its calc's label, and opens `/$slug/models/$id/visual?key=` (`/new/visual` for an unsaved model). `visualSections`: Definition (key `text`, title `text`, kind a dropdown of `kinds` labelled by `calc.label`), Inputs (one field `inputs.<name>` per `calc.inputs`, label from the calc, `controlType: "expr"`, required), Outputs (read-only text listing `<key>_<output>` — what formulas read). `VisualPage.tsx` mirrors `TablePage.tsx`: `ObjectPage alwaysEdit`, `validate` = `visualIssues`, `controls` = `builderControls({ scope: (c) => commitVisual(m.def, initial.key, fromVisualRecord(c.formData)), tables: m.tableCols })` so an input formula resolves against the model with this visual's unsaved edits, `onSave` → `m.saveModel(commitVisual(m.def, initial.key, fromVisualRecord(formData)))`; a key no visual has → `PageError` with `MODEL_MISSING_VISUAL`. Routes mirror `$id.table.tsx`/`new.table.tsx`, rendering `<VisualPage key={search.key} search={search} />`.

Texts (en / es / eu): `MODEL_VISUAL` visual / visual / bisuala; `MODEL_VISUAL_KIND` Visual / Tipo de visual / Bisual mota; `MODEL_VISUAL_INPUTS` Inputs / Entradas / Sarrerak; `MODEL_VISUAL_OUTPUTS` Formulas read / Las fórmulas leen / Formulek irakurtzen dute; `MODEL_MISSING_VISUAL` This visual no longer exists / Este visual ya no existe / Bisual hau ez dago jada.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test apps/app && bun --cwd apps/app build && bunx tsc -p apps/app/tsconfig.json --noEmit`
Expected: PASS; the build regenerates `routeTree.gen.ts` with `/$slug/models/$id/visual`.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/components/model-builder/structureOps.ts apps/app/src/components/model-builder/structureOps.test.ts apps/app/src/components/model-builder/ParamsTab.tsx apps/app/src/components/model-builder/VisualPage.tsx apps/app/src/features/model/visual.ts apps/app/src/features/model/visual.test.ts 'apps/app/src/routes/$slug/models/$id.visual.tsx' 'apps/app/src/routes/$slug/models/new.visual.tsx' apps/app/src/i18n/parts/model.en.properties apps/app/src/i18n/parts/model.es.properties apps/app/src/i18n/parts/model.eu.properties
git commit -m "feat(builder): place a tenant visual and write its inputs"
```

---

### Task 8: ALUMIGRAF on hera, end to end, and the docs

**Files:**
- Modify: `CLAUDE.md` (a paragraph under `packages/config-engine`)
- Data (dev database, through the builder, **only after the user says yes** — hera is their tenant on the real SAP): the ALUMIGRAF model

- [ ] **Step 1: Ask the user** whether to author ALUMIGRAF's changes or leave them to them. If yes, in the builder on `localhost:5173/hera/models/b1b7c86a-9212-4daa-a1fd-8e16640d8874`:
  - add a select parameter `mec_metodo` (label `Método corte`) over the masterdata table `MEC_Metodos`, beside Mecanizado;
  - add a visual `hoja` (kind `hera.sheetLayout`) to the Formato group with inputs `largoFormato`, `anchoFormato`, `IF(items_count == 1, items_salesLength, null)`, `IF(items_count == 1, items_salesWidth, null)`, `mec_metodo_pasox`, `mec_metodo_pasoy`, `mec_metodo_margenx`, `mec_metodo_margeny`;
  - set computed `formato_qty` to `hoja_piezas`; save.

- [ ] **Step 2: Verify in the running app** (`bun run dev`; the headless probe in memory `headless-browser-probe.md`): a hera configuration with one article of 120×70, sheet 1000×500 and *Corte laser fibra* shows the Formato fields and the sheet side by side, captioned `48 piezas/formato · 81% aprovechado`; a second items row turns the picture into the empty state; the same project opened in the portal (`localhost:5180/hera/…`) shows no picture and no error. Screenshot the configurator for the user.

- [ ] **Step 3: Document** in `CLAUDE.md`, under `packages/config-engine`: tenant visuals — the two halves by kind (`config-engine/src/visuals/`, `ui/src/configurator/visuals/`), `tenants` slugs checked by `models.save`, outputs as `<key>_<output>`, views in `FormState.visuals`, staff only (`toPortalForm`), out of tool results (`withoutVisuals`), and the spec's path.

- [ ] **Step 4: Run every gate**

Run: `bun test packages/config-engine && bun test packages/ui && bun test apps/app && bun test apps/server`, then `bunx tsc --noEmit -p` for `packages/config-engine`, `packages/ui`, `apps/server`, `apps/app`, `apps/portal`.
Expected: PASS apart from server failures already present before Task 1 (named in Task 5's baseline).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: tenant visuals"
```
