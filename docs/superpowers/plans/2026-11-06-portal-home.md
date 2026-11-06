# Portal home redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the portal's four-card landing page with `/<slug>/home`. The page shows a HeroBanner with three to-do figures and *New project*, the customer's open inquiries with their six-step journey and personal pins, and the latest SAP documents.

**Architecture:** One pure server module (`portal/journey.ts`) decides each project's step, "next" and sort rank. The browser only draws what it says. The journey past *Quoted* is stored on `config_project` (`sap_step`, `sap_step_at`). `home.progress` refreshes that column from SAP with one batched chain walk (`furthestSteps` in `doc-chain.ts`). `home.overview` reads Postgres only, so SAP down costs the SAP parts, never the page. Pins are per-user `ui_user_state` rows, written by a small `home.pin` procedure that owns the key and the company fence.

**Tech Stack:** Bun, Drizzle (Postgres), oRPC v2 beta, React + TanStack Router/Query, UI5 Web Components for React 2.27.

**Spec:** `docs/superpowers/specs/2026-11-06-portal-home-design.md`

## Global Constraints

- **Precondition:** the working tree carries uncommitted document-mail work (`doc-chain.ts`' `quotationsBehind`, the schema's `document_sent`, migration `0017_document_mail`). Land it before Task 1. This plan's migration is `0018`.
- Every colour is a Horizon theme variable (`--sapPositiveColor`, `--sapInformativeColor`, `--sapCriticalColor`, `--sapNegativeColor`, `--sapNeutralBorderColor`, …). No raw colours.
- A schema change ships as a migration: `bun run db:push` (dev), then `bun run db:generate`, and commit the SQL. New schema exports go through `packages/db/src/schema/index.ts`.
- Imports use explicit `.ts`/`.tsx` extensions, and `import type` for types (`verbatimModuleSyntax`).
- Run tests from the repo root (`bun test <path>`): the root `bunfig.toml` preload drops mail, Anthropic and Cloudflare keys.
- Type-checking is per project: `bunx tsc -p <project>/tsconfig.json --noEmit` for every project a task touches.
- UI texts in `apps/portal/src/i18n/parts/portal.{en,es,eu}.properties`, all three languages. Use English exactly as given here, and translate es/eu.
- Deliberate shortcuts get a `// ponytail:` comment naming the ceiling and the upgrade path.

**Deviations from the spec (builder's calls, flagged to the user):**
- Pins are written by a new `home.pin` procedure, not `views.setState`. The server then owns the key and checks the company fence on write.
- There is no *All documents ›* link, because the portal has no all-documents page. The side nav's Documents group is next to the section.

## Review Focus

1. **Garbage in the pins row:** non-uuid strings, numbers or a non-array in `ui_user_state` `portal:homePins` must not 500 the overview, since `id = ANY(...)` on a uuid column throws on a bad string. Pinned in Task 4.
2. **A pinned project that left the fence** (deleted, or another company's id) is silently skipped, never shown. Pinned in Task 4.
3. **Mock and real SAP return documents outside the asked-for set.** The mock crossjoin ignores `$filter`. Attribution must use only line bases that point into the source set. Pinned in Task 2.
4. **Another SAP company:** a project quoted in company A is never walked while the agent is on B, and keeps its stored step. Pinned in Task 3.
5. **An invoiced project is never read again.** A second `progress` with only invoiced projects makes no crossjoin call. Pinned in Task 3.

---

### Task 1: The journey rule and its stored SAP step

**Files:**
- Modify: `packages/db/src/schema/configurator.ts` (add next to `QuoteResponse`, and two columns on `configProject` after `quotedAt`)
- Create: `packages/db/drizzle/0018_*.sql` (generated)
- Create: `apps/server/src/portal/journey.ts`
- Test: `apps/server/test/portal-journey.test.ts`

**Interfaces:**
- Produces (`@confire/db`): `SAP_STEPS = ["ordered", "delivered", "invoiced"] as const`; `type SapStep`; columns `configProject.sapStep: text("sap_step").$type<SapStep>()` (nullable) and `configProject.sapStepAt: date("sap_step_at", { mode: "string" })` (nullable, B1's `DocDate` of the step's document). Comment on the columns: written only by `home.progress`, forward only, never bumps `updated_at`.
- Produces (`portal/journey.ts`):
  - `type Next = "finish" | "review" | "changes" | "answer" | "awaitOrder" | "delivery" | "invoice" | "done" | "declined"`
  - `type JourneyInput = { status: ProjectStatus; quoteResponse: QuoteResponse | null; sapStep: SapStep | null }`
  - `journeyOf(p: JourneyInput): { step: number; next: Next }`. `step` is the current step's index in sent(0) · review(1) · quoted(2) · ordered(3) · delivered(4) · invoiced(5). 6 = all done.
  - `rankOf(next: Next): 0 | 1 | 2 | 3`. 0 is the customer's move (`changes`, `answer`). 1 is the supplier's (`review`, `awaitOrder`, `delivery`, `invoice`). 2 is a draft (`finish`). 3 is finished (`done`, `declined`).
  - `isFinished(p: Pick<JourneyInput, "status" | "sapStep">): boolean`, true when `status === "declined"` or `sapStep === "invoiced"`.
  - `figuresOf(nexts: Next[]): { needAnswer: number; withSupplier: number; inDelivery: number }`. `needAnswer` counts `changes`+`answer`, `withSupplier` counts `review`+`awaitOrder`, and `inDelivery` counts `delivery`+`invoice`.

- [ ] **Step 1: Write the failing test** `apps/server/test/portal-journey.test.ts`

```ts
import { expect, test } from "bun:test";
import { figuresOf, isFinished, journeyOf, rankOf } from "../src/portal/journey.ts";

const j = (status: any, quoteResponse: any = null, sapStep: any = null) => journeyOf({ status, quoteResponse, sapStep });

test("journeyOf: every state of the spec's table", () => {
  expect(j("draft")).toEqual({ step: 0, next: "finish" });
  expect(j("submitted")).toEqual({ step: 1, next: "review" });
  expect(j("in_review")).toEqual({ step: 1, next: "review" });
  expect(j("returned")).toEqual({ step: 1, next: "changes" });
  expect(j("declined")).toEqual({ step: 1, next: "declined" });
  expect(j("quoted")).toEqual({ step: 2, next: "answer" });
  expect(j("quoted", "accepted")).toEqual({ step: 3, next: "awaitOrder" });
  expect(j("quoted", null, "ordered")).toEqual({ step: 4, next: "delivery" }); // SAP outranks an unanswered quote
  expect(j("quoted", "accepted", "delivered")).toEqual({ step: 5, next: "invoice" });
  expect(j("quoted", "accepted", "invoiced")).toEqual({ step: 6, next: "done" });
});

test("rank, finished and figures", () => {
  expect(["answer", "changes", "review", "awaitOrder", "delivery", "invoice", "finish", "done", "declined"].map((n) => rankOf(n as any)))
    .toEqual([0, 0, 1, 1, 1, 1, 2, 3, 3]);
  expect(isFinished({ status: "declined", sapStep: null })).toBe(true);
  expect(isFinished({ status: "quoted", sapStep: "invoiced" })).toBe(true);
  expect(isFinished({ status: "quoted", sapStep: "delivered" })).toBe(false);
  expect(figuresOf(["answer", "changes", "review", "awaitOrder", "delivery", "invoice", "finish"]))
    .toEqual({ needAnswer: 2, withSupplier: 2, inDelivery: 2 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/test/portal-journey.test.ts`
Expected: FAIL, cannot find module `../src/portal/journey.ts`.

- [ ] **Step 3: Add `SAP_STEPS`/`SapStep` and the two columns in `configurator.ts`, then write `journey.ts`** with the signatures above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/server/test/portal-journey.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Migration and type-check**

Run: `bun run db:push && bun run db:generate && grep -l 'sap_step' packages/db/drizzle/0018_*.sql && bunx tsc -p packages/db/tsconfig.json --noEmit && bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: a `0018_*.sql` file adding both columns. Both type-checks pass.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/configurator.ts packages/db/drizzle apps/server/src/portal/journey.ts apps/server/test/portal-journey.test.ts
git commit -m "portal home: the journey rule and config_project.sap_step"
```

---

### Task 2: One batched chain walk for many quotations

**Files:**
- Modify: `apps/server/src/doc-chain.ts` (append after `documentChain`)
- Test: `apps/server/test/doc-chain.test.ts` (new, pure: a fake transport, no server)

**Interfaces:**
- Consumes: `SapStep` (Task 1); the file's own `chainQuery`, `baseClause`, `ChainEntity`.
- Produces: `furthestSteps(b1: Pick<B1Transport, "crossJoin">, quotations: number[]): Promise<Map<number, { step: SapStep; at: string }>>`. It returns a key for each quotation that has at least an order. `at` is the latest `DocDate` among that quotation's documents of its furthest step.

- [ ] **Step 1: Write the failing test** `apps/server/test/doc-chain.test.ts`

The fake answers like `mock-agent.ts`' `/cross-join`: every document of the lead entity paired with each of its lines, **ignoring the filter**. It counts calls.

```ts
import { expect, test } from "bun:test";
import { furthestSteps } from "../src/doc-chain.ts";

const doc = (DocEntry: number, DocDate: string, bases: [number, number][]) =>
  ({ DocEntry, DocNum: DocEntry, DocDate, DocTotal: 0, DocumentStatus: "bost_Open", CardCode: "C1",
     DocumentLines: bases.map(([BaseType, BaseEntry]) => ({ BaseType, BaseEntry })) });
const STORE: Record<string, ReturnType<typeof doc>[]> = {
  Orders: [doc(10, "2026-10-01", [[23, 1]]), doc(11, "2026-10-02", [[23, 2]]), doc(12, "2026-10-03", [[23, 3]]), doc(19, "2026-10-09", [[23, 99]])],
  DeliveryNotes: [doc(20, "2026-10-05", [[17, 10]])],
  Invoices: [doc(30, "2026-10-07", [[15, 20]]), doc(31, "2026-10-08", [[17, 12]])],
};
const fake = () => {
  let calls = 0;
  return {
    get calls() { return calls; },
    crossJoin: async (spec: { entities: string[] }) => {
      calls++;
      const lead = spec.entities[0]!;
      return { data: { value: (STORE[lead] ?? []).flatMap((d) => d.DocumentLines.map((l) => ({ [lead]: d, [`${lead}/DocumentLines`]: l }))) } };
    },
  };
};

test("furthestSteps: invoiced via delivery, via order directly, ordered only, nothing", async () => {
  const b1 = fake();
  const r = await furthestSteps(b1 as any, [1, 2, 3, 4]);
  expect(Object.fromEntries(r)).toEqual({
    1: { step: "invoiced", at: "2026-10-07" },
    2: { step: "ordered", at: "2026-10-02" },
    3: { step: "invoiced", at: "2026-10-08" },
  });
  expect(b1.calls).toBe(3); // exactly three keys above: order 19 (base 99, never asked for) is attributed to nothing
});

test("furthestSteps: no quotations, no SAP call", async () => {
  const b1 = fake();
  expect((await furthestSteps(b1 as any, [])).size).toBe(0);
  expect(b1.calls).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/test/doc-chain.test.ts`
Expected: FAIL, `furthestSteps` is not exported.

- [ ] **Step 3: Implement `furthestSteps` in `doc-chain.ts`**

Up to three hops, as `documentChain` does but over sets: Orders (`baseClause(…, 23, quotations)`), then DeliveryNotes (17, the orders found), then Invoices (17 orders ∪ 15 deliveries). Skip a hop whose source set is empty. Read each hop's pairs keeping every line's `BaseType`/`BaseEntry` (`flattenChain` drops them, so write a sibling that keeps them, deduped by `DocEntry`). Attribute each document back to a quotation only through a base that is in the previous hop's set. Chunk the quotations, 25 per walk, with `top` 1000 pairs per hop, behind a `// ponytail:` comment: `$top` counts document–line pairs (see `chainQuery`), so raise it if a chunk's orders carry more lines.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/server/test/doc-chain.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/doc-chain.ts apps/server/test/doc-chain.test.ts
git commit -m "doc-chain: furthestSteps, one walk for a set of quotations"
```

---

### Task 3: `home.progress`, which refreshes the stored step from SAP

**Files:**
- Modify: `apps/server/src/portal/orpc/home.ts`
- Test: `apps/server/test/portal-notify.test.ts` (`describe("settings and home")`)

**Interfaces:**
- Consumes: `furthestSteps` (Task 2), `SAP_STEPS`/`configProject.sapStep`/`sapStepAt` (Task 1), `tenantConnector`, `viaB1`.
- Produces: `home.progress: portalMemberProcedure` with no input, returning `{ changed: number }`.

Selection: the company's projects (`tenantId`, `portalCardCode = cardCode`) with `status = 'quoted'`, `b1DocEntry` not null, `b1Company = connector.companyDb`, and `sap_step is distinct from 'invoiced'`. If none, return `{ changed: 0 }` without walking. Otherwise call `viaB1(() => furthestSteps(b1, docEntries))`. Write `sapStep`/`sapStepAt` only where the found step's index in `SAP_STEPS` is greater than the stored one's. Set those two columns only (no `updatedAt`), guarded on the stored value (`sap_step is not distinct from <read value>`) so a concurrent run cannot move a step backwards.

- [ ] **Step 1: Write the failing test** (in `describe("settings and home")`)

```ts
test("home.progress: stores the furthest SAP step, forward only, in the agent's company only", async () => {
  const s = await setup();
  const [m] = await db.select().from(configModel).where(eq(configModel.tenantId, s.tenantId));
  const quoted = (b1DocEntry: number, b1Company: string) => ({
    tenantId: s.tenantId, modelId: m!.id, name: `Q${b1DocEntry}`, createdBy: s.buyer.userId,
    portalCardCode: s.company.cardCode, status: "quoted" as const, b1DocEntry, b1Company, quotedAt: new Date(),
  });
  const [here, there] = await db.insert(configProject).values([quoted(501, agent.company.db), quoted(502, "OTHER")]).returning();
  const line = (BaseType: number, BaseEntry: number) => ({ BaseType, BaseEntry });
  agent.store.Orders = [
    { DocEntry: 610, DocNum: 610, DocDate: "2026-11-01", CardCode: s.company.cardCode, DocumentLines: [line(23, 501)] },
    { DocEntry: 611, DocNum: 611, DocDate: "2026-11-01", CardCode: s.company.cardCode, DocumentLines: [line(23, 502)] },
  ];
  try {
    expect(await call(portalRouter.home.progress, undefined, s.on(s.viewer.cookie))).toEqual({ changed: 1 });
    const rows = await db.select().from(configProject).where(inArray(configProject.id, [here!.id, there!.id]));
    expect(rows.find((r) => r.id === here!.id)).toMatchObject({ sapStep: "ordered", sapStepAt: "2026-11-01" });
    expect(rows.find((r) => r.id === there!.id)!.sapStep).toBeNull(); // quoted in another company

    expect(await call(portalRouter.home.progress, undefined, s.on(s.viewer.cookie))).toEqual({ changed: 0 });

    // Invoiced is final: never walked again.
    await db.update(configProject).set({ sapStep: "invoiced" }).where(eq(configProject.id, here!.id));
    const before = agent.calls.filter((c) => c.route === "/cross-join").length;
    await call(portalRouter.home.progress, undefined, s.on(s.viewer.cookie));
    expect(agent.calls.filter((c) => c.route === "/cross-join").length).toBe(before);
  } finally {
    delete agent.store.Orders;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test apps/server/test/portal-notify.test.ts -t "home.progress"`
Expected: FAIL, `portalRouter.home.progress` is undefined.

- [ ] **Step 3: Implement `progress` in `home.ts`** as described above.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/server/test/portal-notify.test.ts -t "home.progress"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/portal/orpc/home.ts apps/server/test/portal-notify.test.ts
git commit -m "portal home: home.progress stores how far SAP has taken each quotation"
```

---

### Task 4: `home.overview` rows, figures and pins; `home.pin`; latest documents

**Files:**
- Modify: `apps/server/src/portal/orpc/home.ts`
- Modify: `apps/server/src/ui-views.ts:48` (export `setUserState`)
- Test: `apps/server/test/portal-notify.test.ts` (replace the old `home.overview` test; keep `home.documents`' test and adjust it if needed)

**Interfaces:**
- Consumes: `journeyOf`, `rankOf`, `isFinished`, `figuresOf` (Task 1), `getUserState`/`setUserState` (`ui-views.ts`).
- Produces:
  - `home.overview` → `{ figures: { needAnswer: number; withSupplier: number; inDelivery: number }; inquiries: HomeInquiry[] }`
  - `type HomeInquiry = { id: string; name: string; pinned: boolean; step: number; next: Next; at: string /* ISO */; quotedValue: number | null }`. The portal imports server types only through `PortalRouter`, so the page derives the type: `Awaited<ReturnType<typeof client.home.overview>>["inquiries"][number]`, as `projects/$id.tsx` does for `Payload`.
  - `home.pin: portalMemberProcedure.input(z.object({ id: z.uuid(), pinned: z.boolean() }))` → `{ pins: string[] }`. Key `"portal:homePins"`, value a uuid array. Refuse `NOT_FOUND` when the project is not the company's.
  - `home.documents` → `{ recent: Doc[] }` (the existing `doc` shape). There are four reads (Quotations, Orders, DeliveryNotes, Invoices), each the company's newest 5 (`DocDate desc,DocEntry desc`, same fence, `ALWAYS` fields). They are merged newest first and cut to 5. `openInvoices` is gone.

Overview rules:
- **Rows:** the company's projects that are not `isFinished`, plus the user's pinned ids that are still the company's (read the pins row, keep only `z.uuid()` strings, ignore anything else).
- **Order:** pinned first, then `rankOf(next)`, then `updatedAt` desc.
- **`at`:** `createdAt` for a draft; `updatedAt` for submitted/in_review/returned/declined; `quoteRespondedAt ?? quotedAt` while quoted with no SAP step; `sapStepAt` once there is one.
- **Figures:** `figuresOf` over the rows that are not finished. A pinned finished row never counts.
- `// ponytail:` no row cap. Cap the rows if a big customer's open list makes the page long.

- [ ] **Step 1: Write the failing tests** (replace the old `home.overview` test)

```ts
test("home.overview: open inquiries with their journey and figures, fenced, finished ones only when pinned", async () => {
  const s = await setup();
  const [m] = await db.select().from(configModel).where(eq(configModel.tenantId, s.tenantId));
  const t0 = Date.now();
  const p = (name: string, v: Partial<typeof configProject.$inferInsert>, ago = 0) => ({
    tenantId: s.tenantId, modelId: m!.id, name, createdBy: s.buyer.userId, portalCardCode: s.company.cardCode,
    updatedAt: new Date(t0 - ago * 60_000), ...v,
  });
  const ids = Object.fromEntries((await db.insert(configProject).values([
    p("draft", {}),
    p("sent", { status: "submitted" }, 5),
    p("returned", { status: "returned" }, 1),
    p("answer", { status: "quoted", quotedAt: new Date(), quotedValue: "6950" }, 2),
    p("accepted", { status: "quoted", quoteResponse: "accepted", quoteRespondedAt: new Date() }, 3),
    p("ordered", { status: "quoted", sapStep: "ordered", sapStepAt: "2026-11-01" }, 4),
    p("invoiced", { status: "quoted", sapStep: "invoiced", sapStepAt: "2026-11-02" }),
    p("declined", { status: "declined" }),
    p("elsewhere", { portalCardCode: "OTHER" }),
  ]).returning()).map((r) => [r.name, r.id]));

  const o = await call(portalRouter.home.overview, undefined, s.on(s.viewer.cookie));
  expect(o.figures).toEqual({ needAnswer: 2, withSupplier: 2, inDelivery: 1 });
  expect(o.inquiries.map((r) => r.name)).toEqual(["returned", "answer", "accepted", "ordered", "sent", "draft"]);
  expect(o.inquiries.find((r) => r.name === "answer")).toMatchObject({ step: 2, next: "answer", quotedValue: 6950, pinned: false });

  // A pin is the user's own and keeps a finished project on top.
  await call(portalRouter.home.pin, { id: ids.invoiced!, pinned: true }, s.on(s.viewer.cookie));
  const pinned = await call(portalRouter.home.overview, undefined, s.on(s.viewer.cookie));
  expect(pinned.inquiries[0]).toMatchObject({ name: "invoiced", pinned: true, step: 6, next: "done" });
  expect(pinned.figures).toEqual(o.figures);
  expect((await call(portalRouter.home.overview, undefined, s.on(s.buyer.cookie))).inquiries.map((r) => r.name)).not.toContain("invoiced");

  // Another company's project cannot be pinned.
  expect(await codeOf(call(portalRouter.home.pin, { id: ids.elsewhere!, pinned: true }, s.on(s.viewer.cookie)))).toBe("NOT_FOUND");
});

test("home.overview: a pins row holding garbage or a deleted project is ignored", async () => {
  const s = await setup();
  await db.insert(uiUserState).values({ tenantId: s.tenantId, userId: s.viewer.userId, key: "portal:homePins", value: ["not-a-uuid", 5, crypto.randomUUID()] });
  expect((await call(portalRouter.home.overview, undefined, s.on(s.viewer.cookie))).inquiries).toEqual([]);
});
```

(`codeOf` and `uiUserState` come from the file's existing imports or `@confire/db`. Add `inArray` to the `drizzle-orm` import for Task 3's test.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test apps/server/test/portal-notify.test.ts -t "home.overview"`
Expected: FAIL. `figures` is undefined (the old shape) and `home.pin` does not exist.

- [ ] **Step 3: Implement `overview`, `pin` and `documents` in `home.ts`, and export `setUserState`**, following the rules above.

- [ ] **Step 4: Run the home tests to verify they pass**

Run: `bun test apps/server/test/portal-notify.test.ts -t "home\."`
Expected: PASS for `home.overview` (2), `home.progress` and `home.documents`.

- [ ] **Step 5: Type-check and commit**

Run: `bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: no errors. Ignore `apps/portal` errors from the old page until Task 6.

```bash
git add apps/server/src/portal/orpc/home.ts apps/server/src/ui-views.ts apps/server/test/portal-notify.test.ts
git commit -m "portal home: overview rows with journey, figures and pins; latest documents across four types"
```

---

### Task 5: Move the staff home's `Tile` into `@confire/ui`

**Files:**
- Create: `packages/ui/src/Tile.tsx` (the `Tile` component and `TileProps` from `apps/app/src/routes/$slug/index.tsx`, unchanged)
- Create: `packages/ui/src/tile.css` (the contents of `apps/app/src/routes/$slug/-home.css`; keep its header comment, minus the `-` prefix sentence)
- Delete: `apps/app/src/routes/$slug/-home.css`
- Modify: `apps/app/src/routes/$slug/index.tsx` (import `Tile`/`TileProps` from `@confire/ui/Tile.tsx`, drop the local copy and the CSS import)

**Interfaces:**
- Produces: `import { Tile, type TileProps } from "@confire/ui/Tile.tsx"`. `Tile.tsx` imports `./tile.css` itself.

- [ ] **Step 1: Move the code and CSS** as listed. No behaviour change.

- [ ] **Step 2: Verify that both projects type-check and the staff app builds**

Run: `bunx tsc -p packages/ui/tsconfig.json --noEmit && bunx tsc -p apps/app/tsconfig.json --noEmit && bun --cwd apps/app build`
Expected: all three succeed.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/Tile.tsx packages/ui/src/tile.css apps/app/src/routes/\$slug/index.tsx apps/app/src/routes/\$slug/-home.css
git commit -m "ui: the launchpad Tile moves to @confire/ui for the portal home"
```

---

### Task 6: The page: `/<slug>/home`

**Files:**
- Create: `apps/portal/src/routes/$slug/home.tsx`
- Modify: `apps/portal/src/routes/$slug/index.tsx` (becomes only `beforeLoad: ({ params }) => { throw redirect({ to: "/$slug/home", params }); }`)
- Create: `apps/portal/src/components/Journey.tsx`
- Modify: `apps/portal/src/components/PortalShell.tsx:110` (`go("/home")`), `:177` (`data-to="/home"`, `selected={pathname === "/home"}`)
- Modify: `apps/portal/src/i18n/parts/portal.{en,es,eu}.properties`

**Interfaces:**
- Consumes: `home.overview`, `home.progress`, `home.pin`, `home.documents` (Tasks 3–4); `Tile` (Task 5); `meQuery`, `client` (`../orpc.ts`), `DOC_PAGES`, `money`, `formatLocale`. Types are derived, never imported from the server: `type HomeInquiry = Awaited<ReturnType<typeof client.home.overview>>["inquiries"][number]`, `type Next = HomeInquiry["next"]`.
- Produces: `Journey({ step, next, labels, ariaLabel }: { step: number; next: Next; labels: string[]; ariaLabel: string })`. It draws six dots joined by lines. Dots before `step` are done (`--sapPositiveColor`). The current dot is ringed in the tone of `next`: Critical for `answer`/`changes`, Negative for `declined`, neutral border for `finish`, Informative otherwise. Labels go under the dots. It is `role="img"` with `aria-label`. Inline styles only.

Page, top to bottom (UI5 components per the spec's table):
1. `HeroBanner`. `overlineText` is `PORTAL_HOME_OVERLINE` (long weekday date, `me.company.cardName`, `me.tenant.name`). `headerText` is the hour-based greeting with the first name (as the staff home: `<12` morning, `<18` afternoon, else evening). `actions` holds `Button icon="add"` → `/$slug/projects/new`, only when `me.company.role` is `owner` or `buyer`. The body is three wide `Tile`s with no `to`: `needAnswer` (`state="Critical"` when not zero), `withSupplier` (title with the tenant name), and `inDelivery`. Each shows the skeleton while loading.
2. A `MessageStrip design="Critical"` with `PORTAL_HOME_SAP_DOWN` when `home.progress` errors (`retry: false`). When `progress.data.changed > 0`, invalidate `home.overview`.
3. A `Title level="H4"` *Open inquiries*, with a `Link` *All projects* → `/$slug/projects`. Then a `Table` with `rowActionCount={1}` and `onRowClick` → `/$slug/projects/$id`. Each `TableRow` has `rowKey={id}`, `interactive`, and `actions={<TableRowActionNavigation />}`. Cells:
   - The pin: `Button design="Transparent"`, `icon` `pushpin-on`/`pushpin-off`, `accessibleName`/`tooltip` `PORTAL_HOME_PIN`/`UNPIN`. Its click calls `e.stopPropagation()` and then `home.pin`, and invalidates the overview on success.
   - The name, with the sub-line `PORTAL_HOME_SINCE_<NEXT>` and the date. For `answer` with a `quotedValue`, append ` · ` + `money(quotedValue, me.currency)`.
   - `Journey`.
   - `Tag`: design `Critical` for `answer`/`changes`, `Negative` for `declined`, `Positive` for `done`, `Neutral` for `finish`, else `Information`. Text `PORTAL_HOME_NEXT_<NEXT>`.
   - With no rows: `IllustratedMessage name="NoEntries"` with the existing `PORTAL_HOME_NO_PROJECTS`/`_SUB` texts, plus the New project button for buyers.
4. A `Title level="H4"` *Latest documents*. Then a `List` of `ListItemStandard type="Navigation"`, as the old page's recent card: an open invoice (`entity === "Invoices" && status === "bost_Open"`) gets `additionalTextState="Critical"`. SAP down shows the same strip text. Empty shows `PORTAL_HOME_NO_DOCUMENTS`.

English texts (`portal.en.properties`). Add these. Delete `PORTAL_HOME_WELCOME`, `_SUBTITLE`, `_REQUESTS`, `_BY_STATUS`, `_AWAITING`, `_QUOTED`, `_NOTHING_WAITING`, `_RECENT`, `_RECENT_SUB`, `_OPEN_INVOICES` and `_NO_OPEN_INVOICES` from all three files. Keep `_SAP_DOWN`, `_NO_PROJECTS`, `_NO_PROJECTS_SUB` and `_NO_DOCUMENTS`.

```properties
PORTAL_HOME_TITLE=Home
PORTAL_HOME_GREETING_MORNING=Good morning, {0}
PORTAL_HOME_GREETING_AFTERNOON=Good afternoon, {0}
PORTAL_HOME_GREETING_EVENING=Good evening, {0}
PORTAL_HOME_OVERLINE={0} · {1} at {2}
PORTAL_HOME_NEW_PROJECT=New project
PORTAL_HOME_NEED_ANSWER=Need your answer
PORTAL_HOME_WITH_SUPPLIER=With {0}
PORTAL_HOME_IN_DELIVERY=Ordered, not yet invoiced
PORTAL_HOME_INQUIRIES=Open inquiries
PORTAL_HOME_ALL_PROJECTS=All projects
PORTAL_HOME_COL_INQUIRY=Inquiry
PORTAL_HOME_COL_PROGRESS=Progress
PORTAL_HOME_COL_NEXT=Next
PORTAL_HOME_PIN=Pin to the top
PORTAL_HOME_UNPIN=Unpin
PORTAL_HOME_STEP_SENT=Sent
PORTAL_HOME_STEP_REVIEW=Review
PORTAL_HOME_STEP_QUOTED=Quoted
PORTAL_HOME_STEP_ORDERED=Ordered
PORTAL_HOME_STEP_DELIVERED=Delivered
PORTAL_HOME_STEP_INVOICED=Invoiced
PORTAL_HOME_JOURNEY_ARIA=Step {0} of 6: {1}
PORTAL_HOME_NEXT_FINISH=Finish and send
PORTAL_HOME_NEXT_REVIEW={0} reviews
PORTAL_HOME_NEXT_CHANGES=Make the changes
PORTAL_HOME_NEXT_ANSWER=Answer the quote
PORTAL_HOME_NEXT_AWAITORDER=Waiting for the order
PORTAL_HOME_NEXT_DELIVERY=Delivery next
PORTAL_HOME_NEXT_INVOICE=Invoice next
PORTAL_HOME_NEXT_DONE=Done
PORTAL_HOME_NEXT_DECLINED=Declined
PORTAL_HOME_SINCE_FINISH=Draft · started {0}
PORTAL_HOME_SINCE_REVIEW=Sent {0}
PORTAL_HOME_SINCE_CHANGES=Returned {0}
PORTAL_HOME_SINCE_ANSWER=Quoted {0}
PORTAL_HOME_SINCE_AWAITORDER=Accepted {0}
PORTAL_HOME_SINCE_DELIVERY=Ordered {0}
PORTAL_HOME_SINCE_INVOICE=Delivered {0}
PORTAL_HOME_SINCE_DONE=Invoiced {0}
PORTAL_HOME_SINCE_DECLINED=Declined {0}
PORTAL_HOME_LATEST=Latest documents
```

- [ ] **Step 1: Write `Journey.tsx`, `home.tsx`, the redirect, the shell changes and the texts** as specified.

- [ ] **Step 2: Build and type-check**

Run: `bun --cwd apps/portal build && bunx tsc -p apps/portal/tsconfig.json --noEmit`
Expected: the build regenerates the route tree with `/$slug/home`, and both commands succeed.

- [ ] **Step 3: Check in the browser** (memory: the browser MCPs are broken here, so use the playwright-core probe with the test tenant)

With `bun run dev` and a seeded tenant (`bun run seed:portal`), open `http://localhost:5180/<slug>/`. Expected:
- It lands on `/<slug>/home`, and the side nav's Home is selected.
- The figures, the table and the documents render, and nothing reads as a raw key.
- Pin and unpin reorder the table, and clicking the pin does not open the project.
- A row click opens the project.
- As a viewer, there is no New project button.

Take one screenshot in light theme and one in dark (Horizon Dark via the user menu).

- [ ] **Step 4: Commit**

```bash
git add apps/portal/src
git commit -m "portal: home at /<slug>/home — open inquiries with their journey, pins, latest documents"
```
