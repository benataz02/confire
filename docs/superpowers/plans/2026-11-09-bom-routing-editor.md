# BOM and routing editor, with Beas operations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BOM and routing are edited as a summary table plus a line dialog. A routing line can link
to a Beas `OperationsCatalog` operation, whose setup time, run time and rate are read live from the
masterdata cache on every calculation, the way BOM prices are.

**Architecture:**
- **Engine** (`packages/config-engine`): a linked line evaluates its figures with `beasSetup`,
  `beasRun` and `beasRate` from `ResolvedLookups.operations`. A missing operation flags the line
  `uncatalogued` instead of failing.
- **Server:** builds `operations` from the cached rows of `pricing.operationTable`, and serves live
  Beas reads in Beas' filter dialect to two new value helps.
- **Builder:** replaces the two inline grids with `Grid` + `Dialog` templates, following
  `CombinationTables.tsx`.

**Tech Stack:** Bun, TypeScript, zod v4, oRPC v2 beta, UI5 Web Components React, TanStack Query,
`bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-08-bom-routing-editor-design.md`. Read it first: the plan
argues from it and does not repeat its reasons.

## Global Constraints

- **Precondition:** the branch carries uncommitted work that removes BOM/routing line ids (`0023_bom_routing_no_ids.sql` and the files `git status` lists). This plan builds on it. Ask the user to commit it, as its own commit, before Task 1.
- Bun only. Type-checking is the gate, per project: `bunx tsc -p <project>/tsconfig.json --noEmit` for `packages/config-engine`, `packages/b1`, `packages/ui`, `apps/server`, `apps/app`, `apps/portal`.
- Imports carry explicit `.ts`/`.tsx` extensions; `verbatimModuleSyntax` is on, so use `import type` for types.
- No DB migration. Both model additions are optional fields in the jsonb definition.
- Units: Beas times are minutes and rates are per hour, on every installation. No unit field, no conversion.
- `beasRun = ProductionTime / QuantityPer`, where a `QuantityPer` that is null or 0 counts as 1. A null or missing numeric field counts as 0.
- The rate is the operation's `CostRate`. The resource's cost rates are not used.
- Beas strings come padded (`"ACA_ACABADO         "`): trim every string read from Beas.
- Beas filter dialect:
  - Search is `Col like 'term'`, OR'd across the search fields. It matches anywhere in the text and ignores case, no `%` needed.
  - An exact probe is `Col eq 'value'`.
  - `contains()`/`startswith()` are refused.
  - `$top` and `$skip` must be sent together, and only with `$orderby`.
  - `/$count` is refused.
- Live checks against hera (the real SAP, tenant `YX0wGPMjRmpF98L83ai0VOSeQjvKAGpS`) are **GET only**.
- Comments explain *why*. A deliberate shortcut gets a `// ponytail:` comment naming its ceiling.
- UI text goes through i18n keys in `apps/app/src/i18n/parts/{model,config}.{en,es,eu}.properties`, the server's in `apps/server/src/i18n/{en,es,eu}.ts`. English is required; add Spanish and Basque alongside, as every existing key in those files has them.
- Builder value helps over Beas are admin-only.

## Review Focus

1. **Padded or spaced operation codes:**
   - A formula yielding `"ACA_AGUJEROS "` and a cache row whose `OperationId` is padded must still match.
   - Pinned in Task 2 (`computeOutputs trims an evaluated operation code`) and Task 4 (`cachedOperations trims codes and resources`).
2. **Null catalog numbers and `QuantityPer` 0:**
   - Must cost as 0 and as a divisor of 1, never as NaN.
   - Pinned in Task 4 (`null figures read as 0, QuantityPer 0 as 1`).
3. **A workspace without Beas, or Beas down while editing:**
   - The Operation and Resource value helps fail, yet typed text is accepted and a manual line saves.
   - Pinned in Task 6 (`a manual line is complete without an operation`) and checked by hand in Task 8.
4. **A checkModel issue on a line:**
   - The messages popover must lead to that line's dialog, now that there is no grid cell to focus.
   - Pinned in Task 7 (`a line issue is a message anchored on its row`).
5. **A new line with empty figures:**
   - OK stays disabled and the field reads as required, not as a parse error.
   - Pinned in Task 6 (`missingFields names the empty required fields`).

---

### Task 1: Model, checks and the operation codes a model can produce

**Files:**
- Modify: `packages/config-engine/src/model.ts` (`OperationZ` ~line 113, `pricing` ~line 293, `ResolvedLookups` ~line 327)
- Modify: `packages/config-engine/src/check.ts` (routing checks ~line 179, pricing checks ~line 189, `syncTables` ~line 394, `bomItemCodes` ~line 409)
- Modify: `packages/config-engine/src/index.ts`
- Test: `packages/config-engine/test/check.test.ts`

**Interfaces:**
- Produces:
  - `OperationZ` with `operationId?: string` and `resource?: string` (now optional). The other fields are unchanged.
  - `ModelDef["pricing"]["operationTable"]?: string`.
  - `export const OPERATION_VARS = ["beasSetup", "beasRun", "beasRate"] as const;` (model.ts).
  - `export type CatalogOperation = { desc: string; resource: string; setupMin: number; runMinPerUnit: number; ratePerHour: number };` (model.ts).
  - `ResolvedLookups.operations?: Record<string, CatalogOperation>`.
  - `export function routingOperationIds(model: ModelDef, domains?: Record<string, { value: unknown }[]>): string[]` (check.ts): trimmed and deduplicated.
  - `syncTables(model)` now also includes `pricing.operationTable`.
  - All of these are exported from `index.ts`.

- [ ] **Step 1: Write the failing tests** in `check.test.ts`. Add `{ name: "ops", columns: [] }` to a local copy of the table list (`const OPS = [...PRICES, { name: "ops", columns: [] }]`). Add `export const linkedModel = (): ModelDef => …` to `test/fixture.ts` (Task 2 uses it too): the fixture with one extra routing line `{ operationId: '"ACA_AGUJEROS"', setupMin: "beasSetup", runMinPerUnit: "beasRun * section", ratePerHour: "beasRate" }` and `pricing.operationTable: "ops"`. In the tests, `const linked = linkedModel()`.

```ts
describe("Beas operations", () => {
  test("a linked line may use the catalog names", () => {
    expect(checkModel(linked, OPS)).toEqual([]);
  });
  test("a Beas name is refused on a line with no operation", () => {
    const m = structuredClone(model);
    m.routing[0]!.runMinPerUnit = "beasRun";
    const issue = checkModel(m, PRICES).find((i) => i.path === "routing[0].runMinPerUnit");
    expect(issue?.message).toBe("unknown identifier 'beasRun'");
  });
  test("the condition never gets them, linked or not", () => {
    const m = structuredClone(linked);
    m.routing[2]!.condition = "beasSetup > 0";
    expect(checkModel(m, OPS).map((i) => i.path)).toContain("routing[2].condition");
  });
  test("a linked line needs an operations source, and a known one", () => {
    const none = { ...linked, pricing: { ...linked.pricing, operationTable: undefined } };
    expect(checkModel(none, OPS).find((i) => i.path === "pricing.operationTable")?.message)
      .toBe("a routing line linked to a Beas operation needs an operations masterdata query");
    const unknown = { ...linked, pricing: { ...linked.pricing, operationTable: "nope" } };
    expect(checkModel(unknown, OPS).find((i) => i.path === "pricing.operationTable")?.message).toBe("unknown table 'nope'");
  });
  test("routingOperationIds: literals and a parameter's domain, trimmed, once each", () => {
    const m = structuredClone(linked);
    m.routing.push({ operationId: 'coated ? "ACA_AGUJEROS " : material', setupMin: "0", runMinPerUnit: "0", ratePerHour: "0" });
    expect(routingOperationIds(m, { material: [{ value: "steel" }, { value: "alu" }] }).sort())
      .toEqual(["ACA_AGUJEROS", "alu", "steel"]);
  });
  test("syncTables keeps the operations source fresh", () => {
    expect(syncTables(linked).has("ops")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/config-engine/test/check.test.ts`
Expected: FAIL (`routingOperationIds` is not exported, and `operationId` is not on `OperationZ`).

- [ ] **Step 3: Implement**
  - Apply the model changes above, keeping the field comments from the spec's model block.
  - In `checkModel`:
    - Check `o.operationId` with `withQty`.
    - Check setup/run/rate with `withOps = new Set([...withQty, ...OPERATION_VARS])` when `o.operationId` is set, else with `withQty`.
    - Check the condition with `withQty` always.
  - Add the `pricing.operationTable` rule beside the `itemTable` rule, with the two messages the test pins.
  - Pull `bomItemCodes`' AST walk out into a private `codesOf(exprs: string[], domains, trim: boolean): string[]`. `bomItemCodes` calls it with `trim: false`, which leaves its behaviour unchanged. `routingOperationIds` calls it over each line's `operationId` with `trim: true`.

- [ ] **Step 4: Run the tests**

Run: `bun run test:engine`
Expected: PASS, all of config-engine (the fixture still checks clean).

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine
git commit -m "feat(engine): routing lines may link a Beas operation"
```

### Task 2: `computeOutputs` reads the catalog

**Files:**
- Modify: `packages/config-engine/src/output.ts` (`OpResult`, the routing loop)
- Test: `packages/config-engine/test/output.test.ts`

**Interfaces:**
- Consumes: `OPERATION_VARS`, `CatalogOperation` and `ResolvedLookups.operations` (Task 1).
- Produces: `OpResult` gains `operationId?: string` and `uncatalogued?: true`. `resource` and `desc` fall back to the catalog's.

- [ ] **Step 1: Write the failing tests.** Use `linkedModel()` from Task 1's fixture. Lookups: `{ ...lookups, operations: { ACA_AGUJEROS: { desc: "AGUJEROS", resource: "ACA_ACABADO", setupMin: 5, runMinPerUnit: 0.1, ratePerHour: 21 } } }`.

```ts
test("a linked line costs from the catalog, and its formula may scale a catalog figure", () => {
  const o = computeOutputs(linkedModel(), withOps, full, 100); // full.section = 16
  const op = o.ops[2]!;
  expect(op.operationId).toBe("ACA_AGUJEROS");
  expect(op.resource).toBe("ACA_ACABADO"); // the line's resource is empty
  expect(op.desc).toBe("AGUJEROS");
  expect(op.setupMin).toBe(5);
  expect(op.runMinPerUnit).toBeCloseTo(1.6); // beasRun * section
  expect(op.ratePerHour).toBe(21);
  expect(op.cost).toBeCloseTo(((5 + 1.6 * 100) / 60) * 21);
  expect(op.uncatalogued).toBeUndefined();
});
test("the line's own resource and description win over the catalog's", () => { /* resource "SAW2", desc "x" -> both kept */ });
test("an operation missing from the catalog is flagged and its names count as 0", () => {
  const o = computeOutputs(linkedModel(), lookups, full, 100); // no `operations`
  expect(o.ops[2]!.uncatalogued).toBe(true);
  expect(o.ops[2]!.cost).toBe(0);
});
test("computeOutputs trims an evaluated operation code", () => {
  const m = linkedModel(); m.routing[2]!.operationId = '"ACA_AGUJEROS  "';
  expect(computeOutputs(m, withOps, full, 100).ops[2]!.uncatalogued).toBeUndefined();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/config-engine/test/output.test.ts`
Expected: FAIL (`operationId` undefined on `OpResult`).

- [ ] **Step 3: Implement** in the routing loop of `computeOutputs`, for a line with `operationId`:
  1. Evaluate it to a string and trim it.
  2. Take `cat = lookups.operations?.[id]`.
  3. Evaluate the three figures with `numeric` against `{ ...scope, vars: { ...scope.vars, beasSetup: cat?.setupMin ?? 0, beasRun: cat?.runMinPerUnit ?? 0, beasRate: cat?.ratePerHour ?? 0 } }`. `numeric` today closes over `scope`, so give it a scope parameter.
  4. Push `operationId`, `uncatalogued: true` when `!cat` (spread, like `unpriced`), `resource: o.resource || cat?.resource || ""` and `desc: o.desc || cat?.desc || ""`.

  Lines without `operationId` are computed exactly as today. Error labels stay `Routing line N`.

- [ ] **Step 4: Run the tests**

Run: `bun run test:engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config-engine
git commit -m "feat(engine): routing figures from the Beas catalog, a missing operation flagged"
```

### Task 3: Beas reads that Beas accepts

**Files:**
- Modify: `packages/b1/src/query.ts:84-88` (`queryString`)
- Modify: `apps/server/src/b1.ts:169-192` (`runnerFor`)
- Modify: `apps/server/src/lookups.ts:152-159` (`withSearch`)
- Modify: `apps/server/src/orpc/routers/masterdata.ts:265-288` (`queryPage`), and the other `withSearch` callers (`grep -rn withSearch apps/server/src`)
- Test: `packages/b1/test/paging.test.ts`, `apps/server/test/lookups.test.ts`

**Interfaces:**
- Produces:
  - `withSearch(query: ODataQuery, cols: string[], q: string, target: "b1" | "beas"): ODataQuery`.
  - `masterdata.queryPage` input gains `match?: { col: string; value: string | number }`. The answer is unchanged: `{ columns, rows, nextSkip? }`.
  - `runnerFor` behaviour for target `beas`:
    - **With `query.orderby`:** pages with `top: size, skip: opts?.skip ?? 0, orderby`, and no `maxPageSize`. There is more (`nextSkip`) when `rows.length === size`.
    - **Without it:** one read, no paging, which is today's behaviour.
    - Either way, string values in the rows come back trimmed.

- [ ] **Step 1: Write the failing tests**

```ts
// paging.test.ts
test("a $top always carries its $skip, 0 included — Beas refuses either alone", async () => {
  const { calls, t } = spy();
  await t.readEntitySet("OperationsCatalog", { top: 50, skip: 0, orderby: "OperationId" });
  expect(calls[0]!.path).toContain("$top=50");
  expect(calls[0]!.path).toContain("$skip=0");
});
test("a bare $skip=0 is still not sent", async () => {
  const { calls, t } = spy();
  await t.readEntitySet("Items", { skip: 0 });
  expect(calls[0]!.path).not.toContain("$skip");
});
// lookups.test.ts
test("withSearch speaks each target's dialect", () => {
  const q = { entitySet: "OperationsCatalog" };
  expect(withSearch(q, ["OperationId", "Description"], "aguj", "beas").filter)
    .toBe("OperationId like 'aguj' or Description like 'aguj'");
  expect(withSearch(q, ["ItemName"], "it's", "b1").filter).toBe("contains(ItemName,'it''s')");
});
```

  Check what `andFilter` does to a single group and adjust the expected string to it; the dialect is what the test pins.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/b1/test/paging.test.ts apps/server/test/lookups.test.ts`
Expected: FAIL (no `$skip=0`; `withSearch` has no target).

- [ ] **Step 3: Implement**
  - **`queryString`:** send `$skip` when it is non-zero, or when `$top` is sent. Keep the Beas error text from the existing comment, and add the second one verified on 2026-11-08: "only allowed, if an $orderby is defined".
  - **`withSearch`:** emits `Col like 'term'` for `beas` and `contains(Col,'term')` for `b1`, both through `escapeLiteral`.
  - **`runnerFor`:** add the Beas branch described above.
  - **`masterdata.queryPage`:** ANDs `match` as `<col> eq <literal>`. The column goes through `assertName` and the value through `escapeLiteral` (a number stays bare), the same composition `withSearch` uses. Pass `input.target` to `withSearch`.

- [ ] **Step 4: Run the tests, then check live (GET only)**
  - Run: `bun run test:server && bun test packages/b1`. Expected: PASS.
  - Then run a throwaway script outside the repo. Import `tenantConnector` and `runnerFor` by absolute path and call:

```ts
runnerFor(conn)("beas", { entitySet: "OperationsCatalog", orderby: "OperationId", filter: "Description like 'ciza'" }, [], { top: 2 })
```

  - Run it from the repo root with `set -a; . ./.env; set +a; bun /tmp/x/probe.ts`.
  - Expected: 2 trimmed rows and a `nextSkip` of 2. Calling again with `skip: 2` answers 200.

- [ ] **Step 5: Commit**

```bash
git add packages/b1 apps/server
git commit -m "fix(server): Beas reads in Beas' dialect — like, \$top with \$skip and \$orderby, trimmed"
```

### Task 4: The server resolves operations; the process page warns

**Files:**
- Modify: `apps/server/src/lookups.ts` (`cachedPrices` ~line 224, `resolveLookups` ~line 297, `bindEntryValues` ~line 349)
- Modify: `apps/server/src/config-view.ts:66-74`
- Modify: `apps/server/src/i18n/{en,es,eu}.ts`
- Modify: `apps/app/src/components/configurator/configMessages.ts:131-135`
- Modify: `apps/app/src/i18n/parts/config.{en,es,eu}.properties`
- Test: `apps/server/test/lookups.test.ts`

**Interfaces:**
- Consumes: `routingOperationIds` and `CatalogOperation` (Task 1).
- Produces:
  - `async function cachedOperations(model: ModelDef, rows: MasterdataRow[], domains: ResolvedLookups["domains"], cache: RowCache): Promise<Record<string, CatalogOperation>>`.
  - `resolveLookups` and `bindEntryValues` return `operations`. `bindEntryValues` merges `{ ...canonical.operations, ...fresh }` just as it merges `prices`.
  - The view's issue `{ code: "uncatalogued", params: [operationId] }`.

- [ ] **Step 1: Write the failing tests** in `lookups.test.ts`, with `cacheOf` (an `ops` masterdata row of target `beas`, and the model's `pricing.operationTable: "ops"`):

```ts
const CATALOG_ROWS = [
  { OperationId: "ACA_AGUJEROS", Description: "AGUJEROS", ResourceId: "ACA_ACABADO         ", SetupTime: 5, ProductionTime: 0.1, QuantityPer: 1, CostRate: 21 },
  { OperationId: "PAD", Description: null, ResourceId: null, SetupTime: null, ProductionTime: 3, QuantityPer: 0, CostRate: null },
  { OperationId: "UNUSED", SetupTime: 1, ProductionTime: 1, QuantityPer: 1, CostRate: 1 },
];
test("cachedOperations trims codes and resources, reading only the model's operations", async () => {
  const log: string[] = [];
  const l = await resolveLookups(linked /* this file's own model, routing lines '"ACA_AGUJEROS"' and '"PAD"', pricing.operationTable "ops" */, rows, cacheOf({ ops: CATALOG_ROWS }, log));
  expect(l.operations?.ACA_AGUJEROS).toEqual({ desc: "AGUJEROS", resource: "ACA_ACABADO", setupMin: 5, runMinPerUnit: 0.1, ratePerHour: 21 });
  expect(l.operations?.UNUSED).toBeUndefined();
});
test("null figures read as 0, QuantityPer 0 as 1", async () => {
  const l = await resolveLookups(linked, rows, cacheOf({ ops: CATALOG_ROWS }));
  expect(l.operations?.PAD).toEqual({ desc: "", resource: "", setupMin: 0, runMinPerUnit: 3, ratePerHour: 0 });
});
test("a model with no linked line reads no operations", async () => { /* model without operationId -> operations {} and no `ops` read in log */ });
```

  The cache filter matches `OperationId` exactly. Rows synced after Task 3 are trimmed, so read by
  the trimmed codes and trim again in the readout. A cache synced earlier with a padded *key* is only
  found after its next sync: mark that with a `// ponytail:` at the read. That is why the padding
  test sits on `ResourceId`.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/server/test/lookups.test.ts`
Expected: FAIL (`operations` undefined).

- [ ] **Step 3: Implement**
  - **`cachedOperations`:** next to `cachedPrices`. Hardcode the Beas field names as consts (`OperationId`, `Description`, `ResourceId`, `SetupTime`, `ProductionTime`, `QuantityPer`, `CostRate`), for the reason `ITEM_CODE` gives. Apply the number rules from Global Constraints.
  - Wire it into both `resolveLookups` and `bindEntryValues`.
  - **`config-view.ts`:** collect `outputs.ops.filter((o) => o.uncatalogued)` across the stored candidates, as `unpriced` does. Push `{ code: "uncatalogued", params: [id], message: t("NOTICE_UNCATALOGUED", id) }`. English: `Operation {0} is not in the operations source: its Beas figures counted as 0`.
  - **`configMessages.ts`:** add a `case "uncatalogued"` (Critical, `...candidates`), with `CONFIG_UNCATALOGUED`, "Operation {0} is not in the operations source", and `CONFIG_UNCATALOGUED_DETAIL`, "Its setup, run time and rate count as 0 until the operation is in the Beas query and the data is synced."

- [ ] **Step 4: Run the tests and type-check**

Run: `bun run test:server && bunx tsc -p apps/server/tsconfig.json --noEmit && bunx tsc -p apps/app/tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server apps/app/src/components/configurator apps/app/src/i18n
git commit -m "feat(server): operations from the cached Beas catalog; uncatalogued warning"
```

### Task 5: A Beas value-help source

**Files:**
- Modify: `packages/ui/src/types.ts:89-92` (`CflSource`)
- Modify: `packages/ui/src/cfl/cfl-provider.ts` (`fetchPage`, `sourceKey`)
- Modify: `packages/ui/src/cfl/CflDialog.tsx:45,110` and `packages/ui/src/cfl/CflField.tsx:140` (the `kind === "entity"` / `"masterdata"` tests)
- Modify: `packages/ui/src/source.tsx` (`UiSource.client`)
- Modify: `packages/ui/src/cfl/cfl-configs.ts` (two factories)
- Modify: `apps/app/src/main.tsx` (provide `masterdata`)
- Test: `packages/ui/src/cfl/cfl.test.ts`

**Interfaces:**
- Consumes: `masterdata.queryPage` with `match` (Task 3).
- Produces:
  - `CflSource` gains `| { kind: "beas"; entitySet: string; orderby: string; filter?: string }`. `filter` is a fixed OData filter declared in code, never user input.
  - `UiSource.client.masterdata?: Pick<Client["masterdata"], "queryPage">`. Optional: the portal provides none, and `fetchPage` throws for a `beas` source without it.
  - `cfl.beasOperations(o?: Overrides): CflDialogConfig`:
    - title "Beas operation", source `{ kind: "beas", entitySet: "OperationsCatalog", orderby: "OperationId" }`, keyField `OperationId`.
    - columns `OperationId` (160), `Description`, `ResourceId`, `SetupTime`, `ProductionTime`, `CostRate`.
    - searchFields `["OperationId", "Description"]`.
  - `cfl.beasResources(o?: Overrides): CflDialogConfig`:
    - title "Beas resource", source `{ kind: "beas", entitySet: "Resource", orderby: "ResourceId", filter: "Active eq true" }`, keyField `ResourceId`.
    - columns `ResourceId` (160), `ResourceDescription`, `ResourceGroup`.
    - searchFields `["ResourceId", "ResourceDescription"]`.

- [ ] **Step 1: Write the failing test**

```ts
test("a Beas source pages masterdata.queryPage: search, exact probe, offset cursor", async () => {
  const calls: unknown[] = [];
  const client = { masterdata: { queryPage: async (i: unknown) => { calls.push(i); return { columns: ["OperationId"], rows: [["A"]], nextSkip: 50 }; } } } as unknown as UiSource["client"];
  const src = cfl.beasOperations().source;
  const page = await fetchPage(client, src, { search: "aguj", searchFields: ["OperationId"], cursor: 50 });
  expect(page).toEqual({ rows: [{ OperationId: "A" }], next: 50, columns: ["OperationId"] });
  expect(calls[0]).toEqual({ target: "beas", query: { entitySet: "OperationsCatalog", orderby: "OperationId" }, search: "aguj", searchCols: ["OperationId"], cursor: 50 });
  await fetchPage(client, cfl.beasResources().source, { filter: [{ field: "ResourceId", op: "eq", value: "ACA" }] });
  expect(calls[1]).toMatchObject({ query: { entitySet: "Resource", orderby: "ResourceId", filter: "Active eq true" }, match: { col: "ResourceId", value: "ACA" } });
  expect(sourceKey(src)).toBe("beas:OperationsCatalog");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/ui/src/cfl/cfl.test.ts`
Expected: FAIL (`beasOperations` is not a function).

- [ ] **Step 3: Implement**
  - **`fetchPage`:** add a `beas` branch shaped like the masterdata branch. It passes `columns` from `req.select` when given, and drops any filter but one `eq` (that becomes `match`).
  - **`CflDialog`/`CflField`:** `src.kind !== "entity"` wherever "masterdata" stood for "not an entity". A Beas source has no metadata and no count.
  - **`apps/app/src/main.tsx`:** add `masterdata: { queryPage: (i) => client.masterdata.queryPage(i) }`, wrapped in a plain function (memory: an oRPC proxy handed down as a value issues `<proc>/valueOf` requests).

- [ ] **Step 4: Run the tests and type-check**

Run: `bun run test:ui && bunx tsc -p packages/ui/tsconfig.json --noEmit && bunx tsc -p apps/app/tsconfig.json --noEmit && bunx tsc -p apps/portal/tsconfig.json --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ui apps/app/src/main.tsx
git commit -m "feat(ui): a value-help source over Beas"
```

### Task 6: The line rules, as pure helpers

**Files:**
- Create: `apps/app/src/components/model-builder/lines.ts`
- Modify: `apps/app/src/components/model-builder/controls.tsx` (move `LITERAL`/`asCode` out, import them back)
- Test: `apps/app/src/components/model-builder/lines.test.ts`

**Interfaces:**
- Consumes: `OPERATION_VARS` (Task 1); the `Row` type from `@confire/ui/types.ts`.
- Produces (all exported from `lines.ts`):
  - `type BomLine = ModelDef["bom"][number]`; `type OpLine = ModelDef["routing"][number]`.
  - `asCode(expr: string): string | undefined`. Moved unchanged.
  - `const FIGURES = ["setupMin", "runMinPerUnit", "ratePerHour"] as const`.
  - `isReplaceable(expr: string | undefined): boolean`: true for empty, a plain number, or exactly one of `OPERATION_VARS`.
  - `withCatalogFigures(line: OpLine): OpLine`: each replaceable figure becomes its catalog name (`setupMin` → `beasSetup`, `runMinPerUnit` → `beasRun`, `ratePerHour` → `beasRate`).
  - `pickOperation(line: OpLine, row: Row): OpLine`:
    - `operationId` = the JSON literal of the trimmed `row.OperationId`.
    - `desc` = trimmed `row.Description` (when present).
    - `resource` = trimmed `row.ResourceId` (when present).
    - then `withCatalogFigures`.
  - `newBomLine(): BomLine` = `{ itemCode: "", qty: "1" }`.
  - `newOpLine(): OpLine` = `{ setupMin: "", runMinPerUnit: "", ratePerHour: "" }`.
  - `missingFields(kind: "bom" | "routing", line: BomLine | OpLine): string[]`: the empty required keys. `itemCode` and `qty` for the BOM; the three figures for routing (`operationId` and `resource` are optional).

- [ ] **Step 1: Write the failing tests**

```ts
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
test("missingFields names the empty required fields", () => {
  expect(missingFields("routing", newOpLine())).toEqual(["setupMin", "runMinPerUnit", "ratePerHour"]);
  expect(missingFields("bom", newBomLine())).toEqual(["itemCode"]);
});
test("a manual line is complete without an operation", () => {
  expect(missingFields("routing", { resource: "SAW", setupMin: "10", runMinPerUnit: "0.5", ratePerHour: "60" })).toEqual([]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test apps/app/src/components/model-builder/lines.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lines.ts`** to the signatures above. Move `asCode` from `controls.tsx` and import it back there.

- [ ] **Step 4: Run the tests**

Run: `bun run test:app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/components/model-builder
git commit -m "feat(app): the BOM/routing line rules as pure helpers"
```

### Task 7: Builder wiring — settings, record, preview lookups, messages

**Files:**
- Modify: `apps/app/src/features/model/model.ts` (Pricing fields; the `bom`/`routing` subsections)
- Modify: `apps/app/src/features/model/record.ts:13` (`PRICING`)
- Modify: `apps/app/src/components/model-builder/usePreviewLookups.ts` (`lookupSkeleton`)
- Modify: `apps/app/src/components/model-builder/builderMessages.ts` (`CELL` handling in `modelIssues`)
- Modify: `apps/app/src/i18n/parts/model.{en,es,eu}.properties`
- Test: `apps/app/src/components/model-builder/builderMessages.test.ts`

**Interfaces:**
- Produces:
  - **The record:** the flat key `pricing.operationTable`.
  - **The Settings field:** `{ key: "pricing.operationTable", label: t("MODEL_OP_SOURCE"), controlType: "masterdataQuery", help: t("MODEL_OP_SOURCE_HELP") }` after `pricing.itemTable`. Not `required`: checkModel requires it only once a line is linked.
  - **The subsections:** `bom` and `routing` stay in the `outputs` section with their labels and **no `table`**. They are drawn by templates in Task 8.
  - **Line issues:** an issue on `bom[i].*` / `routing[i].*` becomes an `other` message:

    ```ts
    { id, text: issueText(...), detail: t("MODEL_LINE_AT", t(table === "bom" ? "MODEL_BOM" : "MODEL_ROUTING"), String(i + 1)), section: "outputs", anchor: `[data-line="${table}:${i}"]` }
    ```

    `history.mappings` keeps its cell handling.
  - **`lookupSkeleton`:**
    - carries `routing: d.routing.flatMap((o) => (o.operationId ? [{ operationId: o.operationId, setupMin: "0", runMinPerUnit: "0", ratePerHour: "0" }] : []))`;
    - carries `pricing.operationTable`.

- [ ] **Step 1: Write the failing test** in `builderMessages.test.ts`:

```ts
test("a line issue is a message anchored on its row", () => {
  const r = recordOf(withRouting /* a model whose routing[1].setupMin is "nope" */);
  const out = modelIssues(r, checkModel(defOf(r)), t);
  expect(out.cells.routing).toBeUndefined();
  expect(out.other).toContainEqual(expect.objectContaining({ section: "outputs", anchor: '[data-line="routing:1"]' }));
});
```

  Use the file's existing helpers to build the record. The point is the shape.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test apps/app/src/components/model-builder/builderMessages.test.ts`
Expected: FAIL (the issue lands in `cells.routing`).

- [ ] **Step 3: Implement** the changes above. Add these keys to `model.en.properties`, with Spanish and Basque alongside:

```
MODEL_OP_SOURCE=Operations source (Beas)
MODEL_OP_SOURCE_HELP=A Beas masterdata query over OperationsCatalog. Declare no columns, or at least OperationId, Description, ResourceId, SetupTime, ProductionTime, QuantityPer and CostRate.
MODEL_LINE_AT={0}, line {1}
```

- [ ] **Step 4: Run the tests and type-check**

Run: `bun run test:app && bunx tsc -p apps/app/tsconfig.json --noEmit`
Expected: PASS. The type-check passes here because `subsectionTemplates` without a `bom`/`routing` entry simply renders an empty subsection until Task 8.

- [ ] **Step 5: Commit**

```bash
git add apps/app/src/features/model apps/app/src/components/model-builder apps/app/src/i18n
git commit -m "feat(app): operations source setting; line issues point at their row"
```

### Task 8: The tables and the line dialog

**Files:**
- Create: `apps/app/src/components/model-builder/LineTables.tsx`
- Modify: `apps/app/src/components/model-builder/ModelBuilderPage.tsx` (`subsectionTemplates`, ~line 100)
- Modify: `apps/app/src/components/model-builder/controls.tsx` (delete the `itemCode` control if nothing names it any more)
- Modify: `apps/app/src/i18n/parts/model.{en,es,eu}.properties`

**Interfaces:**
- Consumes:
  - from Task 6: `asCode`, `FIGURES`, `pickOperation`, `withCatalogFigures`, `newBomLine`, `newOpLine`, `missingFields`;
  - from Task 5: `cfl.beasOperations()`, `cfl.beasResources()`, and the existing `cfl.items()`;
  - from Task 1: `OPERATION_VARS`, `bomItemCodes`, `routingOperationIds`, `checkModel`;
  - from Task 4: `ResolvedLookups.operations`.
- Produces:

  ```ts
  export function LineTables(p: {
    kind: "bom" | "routing";
    draft: ModelDef;
    lookups?: ResolvedLookups;
    tables: TableCols[];
    update: (fn: (d: ModelDef) => ModelDef) => void;
  }): ReactElement
  ```

  `ModelBuilderPage` renders it for `bom` and `routing` exactly as it renders `CombinationTables`.

- [ ] **Step 1: Build the table**
  - `GridForm` + `Grid`, `selectionMode="Multiple"`, `fill={false}`, `showSettings={false}`, `onRowClick` opens the dialog.
  - Toolbar: **Add line** (`icon="add"`), which opens the dialog on `newBomLine()`/`newOpLine()` with no index, and **Delete**, which removes the selected lines, then `sel.clear()` (positions shift).
  - Columns:

    | List | Columns |
    |---|---|
    | BOM | `#`, Item, When, Qty per unit |
    | Routing | `#`, Operation, When, Setup min, Run min/unit, Rate /h |

  - `cellTemplates`:
    - **Item / Operation:** the code (`asCode`) in bold with the description under it (routing: "description · resource"). A non-literal expression shows in monospace with `MODEL_N_ITEMS` / `MODEL_N_OPS` and the count from `bomItemCodes`/`routingOperationIds` for that one line, using `lookups.domains`.
      - This cell's root carries `data-line="<kind>:<i>"` and `tabIndex={-1}`.
      - It opens the dialog `onFocus`. Only the messages popover focuses it, since it is out of the tab order. Comment why.
    - **When:** a chip, `MODEL_ALWAYS` when empty, otherwise the condition in monospace.
    - **Figures:** the expression as written, in monospace.

- [ ] **Step 2: Build the dialog**
  - Like `FormulaDialog`: buffer and commit, `Form layout="S1 M1 L1 XL1"`, footer OK / Cancel.
  - Header: `MODEL_LINE_MATERIAL`/`MODEL_LINE_OPERATION` with the position, or `MODEL_NEW_MATERIAL`/`MODEL_NEW_OPERATION` when there is no index.
  - **The check:**
    - `scope` = the draft with the buffered line spliced in at its index (appended when new).
    - The issues are `checkModel(scope, tables)` filtered to `^(bom|routing)\[i\]\.`.
    - Each `ExprInput` gets its field's issue, except a required field that is empty: it shows required (`Label required`, valueState Negative, no parse message).
    - OK is disabled while issues or `missingFields` remain.
  - **Item\* / Operation:**
    - A `SegmentedButton` (Pick | Formula). It starts on Pick when the expression is empty or `asCode` reads it.
    - Switching to Pick with a non-literal expression empties the field (Cancel undoes it).
    - Under Formula, `MODEL_CAN_GIVE` lists the codes `bomItemCodes`/`routingOperationIds` give for this line.
    - Pick, BOM: `CflField` over `cfl.items()`. It writes the JSON literal and fills `desc` from `ItemName`, which is today's `itemCode` control.
    - Pick, routing: `CflField` over `cfl.beasOperations()`, with `onRowSelect` = `setLine(pickOperation(line, row))` and `mustExist={false}`. Formula mode applies `withCatalogFigures` on change.
  - **Fields:**
    - Description: `Input`.
    - Resource (routing only): `CflField` over `cfl.beasResources()` with `mustExist={false}`, storing the key as plain text. Placeholder `MODEL_RESOURCE_FROM_OP` when an operation is set.
    - Only when: optional `ExprInput`.
    - Qty per unit\* (BOM): `ExprInput` with `extraVars={["qty"]}`.
    - The three figures\* (routing): `ExprInput` with `extraVars={["qty", ...(line.operationId ? OPERATION_VARS : [])]}`.
  - **The catalog hint:** under each figure, when the line has a literal operation:
    - `MODEL_FROM_BEAS` with `lookups.operations?.[code]?.<figure>` when the operation is found;
    - `MODEL_NOT_IN_OPS` when it is not;
    - nothing for a formula operation, or before lookups load.
  - Keys, English (add Spanish and Basque alongside):

```
MODEL_ADD_LINE=Add line
MODEL_LINE_MATERIAL=Material {0}
MODEL_LINE_OPERATION=Operation {0}
MODEL_NEW_MATERIAL=New material
MODEL_NEW_OPERATION=New operation
MODEL_OPERATION=Operation
MODEL_PICK=Pick
MODEL_ALWAYS=Always
MODEL_CAN_GIVE=Can give: {0}
MODEL_N_ITEMS={0} possible items
MODEL_N_OPS={0} possible operations
MODEL_FROM_BEAS=Beas: {0}
MODEL_NOT_IN_OPS=Not in the operations source: its Beas figures count as 0
MODEL_RESOURCE_FROM_OP=from the operation
```

  Reuse existing keys where they exist (`MODEL_FORMULA`, `MODEL_DESC`, `MODEL_CONDITION`, `MODEL_QTY_PER`, `MODEL_SETUP`, `MODEL_RUN`, `MODEL_RATE`, `MODEL_RESOURCE`, `MODEL_ITEM`, `MODEL_OK`, `MODEL_CANCEL`, `MODEL_DELETE`).

- [ ] **Step 3: Wire it** into `ModelBuilderPage`'s `subsectionTemplates`, passing `lookups.data` and `m.tableCols`. Remove the `itemCode` control from `controls.tsx` if nothing names it.

- [ ] **Step 4: Verify: types, every test, the detector, and the running app**
  - Run: `for p in packages/config-engine packages/b1 packages/ui apps/server apps/app apps/portal; do bunx tsc -p $p/tsconfig.json --noEmit || break; done && bun run test:engine && bun run test:server && bun run test:ui && bun run test:app`. Expected: no type errors, all PASS.
  - Run: `/home/benataz02/.claude/plugins/cache/impeccable/impeccable/4.8.0/skills/impeccable/scripts/impeccable detect --json apps/app/src/components/model-builder/LineTables.tsx`. Fix real findings.
  - With `bun run dev`, open a model on tenant hera in the builder (headless playwright-core per the memory note, or the user's browser). Check:
    - Add line → pick `ACA_AGUJEROS` fills the description, `ACA_ACABADO`, `beasSetup`/`beasRun`/`beasRate` and `Beas: 5`/`0.1`/`21`.
    - Typing `beasRun * 2` and re-picking keeps it.
    - A manual line with a typed resource saves.
    - A broken formula's message jumps to its line and opens the dialog.
    - The process page of a configuration over that model prices the operation, and shows the `uncatalogued` warning for an operation removed from the query.

- [ ] **Step 5: Commit**

```bash
git add apps/app
git commit -m "feat(app): BOM and routing as a table and a line dialog, operations picked from Beas"
```
