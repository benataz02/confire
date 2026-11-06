# Client Project Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project with a portal client opens, in both apps, on a page showing an iconed progress bar and a chaptered timeline; its configuration form moves to `…/configuration`.

**Architecture:** The server adds `journey: { step, next }` (from the existing `journeyOf`) to both `get`s. `@confire/ui` gains the pure chapter rule, chapters in `ProjectTimeline`, an iconed `JourneyBar`, a config-summary helper and one shared `ProjectOverview` page component. Each app's routes become thin: the portal splits `projects/$id.tsx` in two, and the staff app routes `/configs/$id` to the overview for a client request and to today's `ConfigProcessPage` otherwise.

**Tech Stack:** Bun, React, UI5 Web Components for React 2.x (Horizon), TanStack Router/Query, oRPC v2 beta, bun:test.

**Spec:** `docs/superpowers/specs/2026-11-06-client-project-page-design.md` (read it with this plan; mockup layout C in `.superpowers/brainstorm/611794-1793980676/content/project-overview.html`).

## Global Constraints

- Only projects with `portalCardCode` set change. An internal configuration's page is unchanged in every way.
- `ProjectTimeline` with none of the new props renders exactly as today.
- Every colour is a theme variable (`var(--sap…)`), no raw colours. The current-step pulse only under `prefers-reduced-motion: no-preference`.
- The server decides `step`/`next` (`journeyOf`); no journey logic in a browser beyond drawing.
- A client's Accept/Decline must not depend on the live SAP documents read.
- Chapters move forward only and each appears at most once; entries stay in time order.
- UI texts go through i18n: en, es, eu for every new key (`@confire/ui`'s `ui.*.properties`, the portal's `portal.*.properties`, the app's `config.*.properties`).
- Imports use explicit `.ts`/`.tsx` extensions; `import type` for types.
- Typecheck is per project: `bunx tsc -p <project>/tsconfig.json --noEmit` for `packages/ui`, `apps/server`, `apps/app`, `apps/portal`; `bun --cwd apps/app build` and `bun --cwd apps/portal build` regenerate the route trees.

## Review Focus

1. **A same-day turnaround** (submitted, accepted and quoted on one day with the quotation document dated that day) must still show Sent, Review and Quoted chapters → test in Task 2.
2. **A declined quote and re-quote** must not open a second Quoted or Review chapter → test in Task 2.
3. **SAP down:** the documents read fails, and the quotation entry still carries Accept/Decline and the overview still renders → Task 6 Step 4 checks it by hand (fixture the `timeline/documents` and `projects/quotation` RPCs to fail).
4. **An internal configuration at `/configs/<id>`** still renders today's `ConfigProcessPage`, and `/configs/<id>/configuration` redirects to it → Task 7 Step 5.
5. **A project with no events beyond `created`** (a fresh portal draft) renders one "Draft" chapter, not an empty timeline or an empty group → test in Task 2 (`chaptersOf` of one `created` event).

---

### Task 1: Journey on both `get`s

**Files:**
- Modify: `apps/server/src/portal/orpc/projects.ts` (`payload`, ~line 60–90) or `apps/server/src/portal/projection.ts`, wherever the `project` object is built
- Modify: `apps/server/src/orpc/routers/configs.ts:105-136` (`requestOf` and its return)
- Test: `apps/server/test/portal-projects.test.ts`

**Interfaces:**
- Consumes: `journeyOf(p: { status; quoteResponse; sapStep }): { step: number; next: Next }` from `apps/server/src/portal/journey.ts`.
- Produces: portal `projects.get` payload gains top-level `journey: { step: number; next: Next }`. Staff `configs.get`'s `request` (non-null only for a client request) gains `journey: { step: number; next: Next }`. Nothing else changes.

- [ ] **Step 1: Write the failing test** in `portal-projects.test.ts`, inside the existing "quote, decline, re-quote…" test (it already has `s`, `id`, `s.portal`, `s.staff`):

```ts
// after submit + acceptAndPick:
expect((await call(portalRouter.projects.get, { id }, s.portal)).journey).toEqual({ step: 1, next: "review" });
expect((await call(router.configs.get, { id }, s.staff)).request?.journey).toEqual({ step: 1, next: "review" });
// after `const first = await quote(s, id);`
expect((await call(portalRouter.projects.get, { id }, s.portal)).journey).toEqual({ step: 2, next: "answer" });
```

Plus, in any test that creates an internal configuration via `router.configs.create` (e.g. `config-process.test.ts`), assert `(await call(router.configs.get, { id }, s.ctx)).request` is `null` (unchanged behaviour, guards the scope).

- [ ] **Step 2: Run** `bun test apps/server/test/portal-projects.test.ts` from the repo root (never `cd apps/server`: the root `bunfig.toml` preload drops mail/AI/CF keys). Expected: FAIL, `journey` undefined.
- [ ] **Step 3: Implement.** Portal: `journey: journeyOf(p)` on the payload (the row has `status`, `quoteResponse`, `sapStep`). Staff: `requestOf` returns `{ cardCode, cardName, assigneeName, journey: journeyOf(row) }`. Add above it: `// ponytail: sapStep is refreshed only by the portal home's home.progress; staff may see a stale SAP step until a client opens home. Upgrade: run the same walk for this one project off the request path.`
- [ ] **Step 4: Run** the test again → PASS. Run `bunx tsc -p apps/server/tsconfig.json --noEmit` → no errors.
- [ ] **Step 5: Commit** `feat(server): projects.get and a request's configs.get carry the journey`.

---

### Task 2: The chapter rule (pure)

**Files:**
- Create: `packages/ui/src/timeline/chapters.ts`
- Create: `packages/ui/src/timeline/chapters.test.ts`
- Modify: `packages/ui/src/timeline/ProjectTimeline.tsx` (move its `Entry` type and the merge/sort `useMemo` body into `mergeEntries`, call it)

**Interfaces:**
- Produces:
  ```ts
  export type Entry =
    | { at: number; kind: "event"; e: TimelineEvent }
    | { at: number; kind: "doc"; d: TimelineDoc; superseded: boolean };
  /** today's merge and sort; `docsAfterDay` sorts a document after the last event of its day (end of docDate) instead of its start */
  export function mergeEntries(events: TimelineEvent[] | undefined, documents: TimelineDocuments | undefined, opts?: { docsAfterDay?: boolean }): Entry[];
  export type Chapter = { step: number; entries: Entry[] };   // step 0..5 = sent·review·quoted·ordered·delivered·invoiced
  /** entries oldest first in, non-empty chapters out, ascending, each step at most once */
  export function chaptersOf(entries: Entry[]): Chapter[];
  ```
- Milestones (exact): event `submitted`→0, `accepted`→1, `quoted`→2; doc `Quotations`→2, `Orders`→3, `DeliveryNotes`→4, `Invoices`→5. Running step starts at 0 and becomes `max(running, milestone)`. Every other entry takes the running step.

- [ ] **Step 1: Write the failing tests** (`chapters.test.ts`; build events with a small `ev(kind, iso)` helper and docs with `doc(entity, docDate)`):
  - `"milestones open their chapter, everything else stays"`: created, comment, submitted, accepted, comment, quoted → `chaptersOf(...).map(c => [c.step, c.entries.map(kindOf)])` equals `[[0,["created","comment","submitted"]],[1,["accepted","comment"]],[2,["quoted"]]]`.
  - `"forward only: rework, withdraw and a declined quote never repeat a chapter"`: submitted, withdrawn, submitted, accepted, returned, resubmitted, accepted, quoted, quote_declined, comment, quoted → steps `[0,1,2]`; chapter 2 holds `["quoted","quote_declined","comment","quoted"]`.
  - `"same-day documents sort after the day's events"`: submitted 2026-11-04T09:00Z, accepted 10:00Z, quoted 11:00Z, a Quotations doc docDate `2026-11-04`; `chaptersOf(mergeEntries(events, docs, { docsAfterDay: true }))` steps equal `[0,1,2]` and the doc is the last entry of chapter 2.
  - `"without docsAfterDay a document sorts at its day's start"`: the same input via `mergeEntries(events, docs)` puts the doc first (today's behaviour, unchanged).
  - `"SAP documents are their steps"`: quoted, Orders doc, DeliveryNotes doc, Invoices doc → steps `[2,3,4,5]`.
  - `"a fresh draft is one chapter"`: one `created` event → `[{ step: 0, entries: [created] }]`; no events → `[]`.
- [ ] **Step 2: Run** `bun test packages/ui/src/timeline/chapters.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `mergeEntries` and `chaptersOf` in `chapters.ts`; make `ProjectTimeline` use `mergeEntries(events, documents)` (no option → identical order).
- [ ] **Step 4: Run** `bun run test:ui` → PASS; `bunx tsc -p packages/ui/tsconfig.json --noEmit` → clean.
- [ ] **Step 5: Commit** `feat(ui): the timeline's chapter rule`.

---

### Task 3: Chapters, entry actions and anchors in `ProjectTimeline`

**Files:**
- Modify: `packages/ui/src/timeline/ProjectTimeline.tsx`
- Modify: `packages/ui/src/i18n/parts/ui.{en,es,eu}.properties`

**Interfaces:**
- Consumes: `mergeEntries`, `chaptersOf`, `Chapter` (Task 2).
- Produces, new optional props on `ProjectTimeline` (absent = today's render):
  ```ts
  /** group entries into the journey's chapters; labels are the six step names */
  chapters?: { labels: string[]; draft: boolean };
  /** extra controls under one event's content (the portal's decisions, Withdraw) */
  entryActions?: (e: TimelineEvent) => ReactNode;
  ```
- Also exports the component's props type: `export type ProjectTimelineProps = Parameters<typeof ProjectTimeline>[0]` (Task 5 uses it).
- Each chapter renders as `<TimelineGroupItem groupName={title} data-chapter={step}>`; outside code scrolls with `root.querySelector('[data-chapter="<step>"]')?.scrollIntoView({ block: "start" })`.
- Title: `UI_CHAPTER_TITLE={0} · {1}` (name, date range `d MMM – d MMM` via `formatLocale()`, one date if the chapter spans one day). Chapter 0's name is `UI_CHAPTER_DRAFT` when `chapters.draft`.
- New keys: `UI_CHAPTER_TITLE`, `UI_CHAPTER_DRAFT` (en "Draft", es "Borrador", eu "Zirriborroa").

- [ ] **Step 1: Implement.** With `chapters`, entries come from `mergeEntries(events, documents, { docsAfterDay: true })` and are drawn inside one `TimelineGroupItem` per `chaptersOf` chapter, all expanded; the item rendering is the existing code, extracted to a local `renderEntry(x)` used by both paths. `entryActions(e)` renders below an event's existing content when it returns non-null.
- [ ] **Step 2: Verify the staff/internal path is unchanged:** `bunx tsc -p packages/ui/tsconfig.json --noEmit`, `bun run test:ui` → clean/PASS. Read the diff: with `chapters` undefined, the JSX tree is the same as before.
- [ ] **Step 3: Check the group look.** If `TimelineGroupItem` cannot be scrolled to (its host collapses) or hides the `data-mine` bubble CSS, fall back to a plain heading row between items with the same `data-chapter` attribute, and say so in the commit message.
- [ ] **Step 4: Commit** `feat(ui): ProjectTimeline chapters and entry actions`.

---

### Task 4: `JourneyBar` and its ring rule

**Files:**
- Create: `packages/ui/src/journey/ring.ts`, `packages/ui/src/journey/ring.test.ts`
- Create: `packages/ui/src/journey/JourneyBar.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type JourneyNext = "finish" | "review" | "changes" | "answer" | "awaitOrder" | "delivery" | "invoice" | "done" | "declined";
  export type Side = "internal" | "external";
  export type Ring = "Critical" | "Negative" | "Neutral" | "Information";
  export function ringOf(next: JourneyNext, side: Side): Ring;
  export const JOURNEY_ICONS = ["paper-plane", "inspection", "sales-quote", "sales-order", "shipping-status", "receipt"] as const;
  export function JourneyBar(props: {
    step: number; next: JourneyNext; side: Side;
    labels: string[];                       // six step names
    dates: (string | undefined)[];          // per step, shown under done steps
    nextText: string;                       // under the current step, in the ring's colour
    ariaLabel: string;
    onStep?: (step: number) => void;        // done steps (i < step) are buttons when given
  }): JSX.Element;
  ```
- `JourneyNext` must stay equal to the server's `Next` (`apps/server/src/portal/journey.ts`); Tasks 6–7 pass the payload's `next` straight in, so a drift is a type error there.

- [ ] **Step 1: Write the failing test** `ring.test.ts` — the spec's table, all 18 cells:
  ```ts
  expect(ringOf("review", "internal")).toBe("Critical");
  expect(ringOf("review", "external")).toBe("Information");
  expect(ringOf("answer", "external")).toBe("Critical");
  expect(ringOf("answer", "internal")).toBe("Information");
  expect(ringOf("changes", "external")).toBe("Critical");
  expect(ringOf("awaitOrder", "internal")).toBe("Critical");
  expect(ringOf("declined", "internal")).toBe("Negative");
  expect(ringOf("finish", "external")).toBe("Neutral");
  // and delivery/invoice/done → "Information" on both sides
  ```
- [ ] **Step 2: Run** `bun test packages/ui/src/journey/ring.test.ts` → FAIL.
- [ ] **Step 3: Implement** `ringOf`, then `JourneyBar` from the mockup's `.jr/.st/.nd` CSS as inline styles (as `apps/portal/src/components/Journey.tsx` does: one grid column per step, the line as two halves; node 2.75rem, icon via UI5 `Icon` with `@ui5/webcomponents-icons/dist/<name>.js` imports; done = `--sapPositiveColor` fill + `--sapButton_Emphasized_TextColor` icon; current = `--sapList_Background` with `box-shadow: 0 0 0 .1875rem <ring>, 0 0 0 .5625rem color-mix(in srgb, <ring> 14%, transparent)`, ring colours `--sapCriticalColor`/`--sapNegativeColor`/`--sapNeutralBorderColor`/`--sapInformativeColor`; upcoming = `--sapNeutralBackgroundColor`, `--sapContent_NonInteractiveIconColor`). The pulse is one `@keyframes` injected once, inside `@media (prefers-reduced-motion: no-preference)`. Under 30rem of its own width (container query or `ResizeObserver`), non-current labels/dates hide. The portal home's `Journey.tsx` is not touched.
- [ ] **Step 4: Run** `bun run test:ui`, `bunx tsc -p packages/ui/tsconfig.json --noEmit` → PASS/clean.
- [ ] **Step 5: Commit** `feat(ui): JourneyBar, the iconed progress bar`.

---

### Task 5: Config summary and the shared `ProjectOverview`

**Files:**
- Create: `packages/ui/src/configurator/summary.ts`, `packages/ui/src/configurator/summary.test.ts`
- Create: `packages/ui/src/project/ProjectOverview.tsx`

**Interfaces:**
- Consumes: `JourneyBar`, `ringOf`, `JourneyNext`, `Side` (Task 4); `ProjectTimeline` props incl. `chapters`/`entryActions` (Task 3); `PageMessages` (`@confire/ui/PageMessages.tsx`).
- Produces:
  ```ts
  /** "500 · 1,000 pcs" first (batches, `formatLocale()`), then up to `max` "Label: value" of visible fields with a value, in model.parameters order; an option's label, not its raw value */
  export function configSummary(model: ModelDef, form: FormState, batches: number[], max?: number /* 3 */): string[];

  export function ProjectOverview(props: {
    side: Side;
    title: string; subtitle: string;                    // project name, model name
    breadcrumbs: ReactNode; tags: ReactNode;            // the app's PageBreadcrumbs, status/answer Tags
    subHeader?: ReactNode;                              // staff: client and assignee; the quote-answer strip
    actions: ReactNode;                                 // ToolbarButtons after the messages button
    messages: PageMessage[]; openMessagesOn?: unknown;  // passed to PageMessages
    journey: { step: number; next: JourneyNext; labels: string[]; nextText: string; ariaLabel: string };
    config: { summary: string[]; text: string; emphasized: boolean; onOpen: () => void };
    upcoming: { sentence: string | null };              // the first not-reached step's sentence; names come from journey.labels
    timeline: Omit<ProjectTimelineProps, "chapters">;   // export ProjectTimeline's props type as ProjectTimelineProps in Task 3's file
  }): JSX.Element;
  ```
- `ProjectOverview` derives the bar's `dates` from `chaptersOf(mergeEntries(..., { docsAfterDay: true }))` (first entry of each chapter) and passes `chapters={{ labels, draft: journey.next === "finish" }}` to `ProjectTimeline`; `onStep` scrolls to `[data-chapter]`. "What comes next" (faded names of steps ≥ `journey.step`, the first with `upcoming.sentence`) renders after the timeline and is hidden for `next` `done`/`declined`. One `ObjectPage` (`hidePinButton`), the bar in the title area, the config line as a `Card` row, the timeline as the one section.

- [ ] **Step 1: Write the failing test** `summary.test.ts`: a two-parameter `ModelDef` fixture (`material` dropdown with option `{ value: "alu", label: "Aluminium 6082" }`, `ports` number) and a `FormState` with both visible → `configSummary(model, form, [500, 1000])` equals `["500 · 1,000", "Material: Aluminium 6082", "Ports: 6"]` under locale `en`; a hidden field and an unset field are skipped; `max: 1` keeps one field.
- [ ] **Step 2: Run** `bun test packages/ui/src/configurator/summary.test.ts` → FAIL.
- [ ] **Step 3: Implement** `configSummary`, then `ProjectOverview`.
- [ ] **Step 4: Run** `bun run test:ui`; `bunx tsc -p packages/ui/tsconfig.json --noEmit` → PASS/clean.
- [ ] **Step 5: Commit** `feat(ui): ProjectOverview, the shared client project page`.

---

### Task 6: Portal — split the project page

**Files:**
- Modify: `apps/portal/src/routes/$slug/projects/$id.tsx` (becomes the overview)
- Create: `apps/portal/src/routes/$slug/projects/$id_.configuration.tsx` (today's page, trimmed)
- Modify: `apps/portal/src/routes/$slug/projects/new.tsx:35` (navigate to `/$slug/projects/$id/configuration`)
- Modify: `apps/portal/src/i18n/parts/portal.{en,es,eu}.properties`

**Interfaces:**
- Consumes: `ProjectOverview`, `configSummary` (Task 5); `payload.journey` (Task 1).
- New keys (en shown; es/eu translated): `PORTAL_CONFIGURATION=Configuration`, `PORTAL_CONTINUE_CONFIGURING=Continue configuring`, `PORTAL_MAKE_CHANGES=Make the changes`, `PORTAL_OPEN=Open`, `PORTAL_NEXT_SENTENCE_FINISH=Once you send it, {0} reviews your request`, `PORTAL_NEXT_SENTENCE_REVIEW={0} is preparing your quote`, `PORTAL_NEXT_SENTENCE_ANSWER=Once you accept, {0} turns the quote into an order`, `PORTAL_NEXT_SENTENCE_AWAITORDER={0} turns the quote into an order`, `PORTAL_NEXT_SENTENCE_DELIVERY={0} delivers the order`, `PORTAL_NEXT_SENTENCE_INVOICE={0} invoices the delivery`. (`changes` uses `…_FINISH`'s meaning with "resend": `PORTAL_NEXT_SENTENCE_CHANGES=Once you resend it, {0} reviews it again`.)

- [ ] **Step 1: Configuration route.** Move today's `ProjectPage` into `$id_.configuration.tsx` (`createFileRoute("/$slug/projects/$id_/configuration")`, keep the `loader` prefetch). Remove: the timeline section and its queries (`timeline`, `documents`, `comment`), the `submitted` footer (Withdraw) and the `answerable` footer (Accept/Decline) and their mutations. `submit`/`resubmit` `onSuccess` also `navigate({ to: "/$slug/projects/$id", params: { id } })`. Breadcrumbs: Projects / *name* (to `/projects/$id`) / Configuration.
- [ ] **Step 2: Overview route.** `$id.tsx` renders `ProjectOverview side="external"` with: tags as today; actions = Delete (buyer, draft, as today); journey from `p.journey`, labels `PORTAL_HOME_STEP_*`, `nextText` = `PORTAL_HOME_NEXT_<NEXT>` with the supplier name; config line per the spec's portal rules (`finish` → Continue configuring, emphasized; `changes` → Make the changes, emphasized; else Open) navigating to the configuration route; `upcoming.sentence` = `PORTAL_NEXT_SENTENCE_<NEXT>` with the supplier (null for `done`/`declined`); timeline props as today's; `entryActions`: on the **latest** `quoted` event when `answerable` → the quotation's figures (`projects.quotation`: total, validity, `PrintActions` preview; on error `PORTAL_QUOTE_UNAVAILABLE`) plus today's Accept/Decline buttons with `promptNote`; on the latest `submitted`/`resubmitted` event when buyer and `status === "submitted"` → Withdraw. Messages: the failures of accept/decline/withdraw/delete/comment.
- [ ] **Step 3: Build and typecheck:** `bun --cwd apps/portal build`, `bunx tsc -p apps/portal/tsconfig.json --noEmit` → clean.
- [ ] **Step 4: Look at it** (headless probe per memory `headless-browser-probe`: a test tenant's portal at `localhost:5180/<slug>/projects/<id>`): a quoted project shows the bar on Quoted with the Critical ring, chapters Sent/Review/Quoted, Accept/Decline on the quotation entry; with `**/rpc/timeline/documents**` and `**/rpc/projects/quotation**` routed to a 503, the page still renders and Accept/Decline are still there. A draft shows one "Draft" chapter and Continue configuring. Fix what one look shows before the next.
- [ ] **Step 5: Commit** `feat(portal): the project page shows progress and the conversation; configuration on its own page`.

---

### Task 7: Staff app — split a client request

**Files:**
- Modify: `apps/app/src/routes/$slug/configs/$id.tsx`
- Create: `apps/app/src/routes/$slug/configs/$id_.configuration.tsx`
- Create: `apps/app/src/components/configurator/RequestOverview.tsx`
- Modify: `apps/app/src/components/configurator/ConfigProcessPage.tsx` (drop the timeline section, `RequestTimeline`, Reassign, Attach and their state; breadcrumbs gain the project page when `request`)
- Modify: `apps/app/src/i18n/parts/config.{en,es,eu}.properties`

**Interfaces:**
- Consumes: `ProjectOverview` (Task 5), `view.request.journey` (Task 1).
- New keys (en shown): `CONFIG_STEP_SENT=Sent` … `CONFIG_STEP_INVOICED=Invoiced` (six), `CONFIG_NEXT_REVIEW=Review it`, `CONFIG_NEXT_CHANGES=With {0} for changes`, `CONFIG_NEXT_ANSWER=Waiting for {0}'s answer`, `CONFIG_NEXT_AWAITORDER=Make the order`, `CONFIG_NEXT_DELIVERY=Delivery next`, `CONFIG_NEXT_INVOICE=Invoice next`, `CONFIG_NEXT_DONE=Done`, `CONFIG_NEXT_DECLINED=Declined`, `CONFIG_REVIEW_REQUEST=Review the request`, `CONFIG_CONFIGURATION=Configuration`, and `CONFIG_NEXT_SENTENCE_<NEXT>` for review/changes/answer/awaitOrder/delivery/invoice ({0} = the client's card name).

- [ ] **Step 1: Routing.** `$id.tsx`'s component reads `orpc.configs.get` (the loader already warms it): `request` non-null → `<RequestOverview id={id} />`, else `<ConfigProcessPage id={id} />` as today. `$id_.configuration.tsx` (`createFileRoute("/$slug/configs/$id_/configuration")`): `beforeLoad`/component redirects to `/$slug/configs/$id` when the loaded `request` is null; otherwise `<ConfigProcessPage key={id} id={id} />`.
- [ ] **Step 2: Move the request extras.** Into `RequestOverview`: `RequestTimeline`'s queries and comment/upload (now `ProjectOverview`'s `timeline` props, `side="internal"`), Reassign (dialog and mutation, unchanged), Attach (hidden file input and mutation, unchanged), Open quotation when `quotationHere`. Out of `ConfigProcessPage`: the timeline section, `RequestTimeline`, Reassign, Attach. Both pages keep the client/assignee subheader and the quote-answer Tag. `ProcessFooter` (Accept, Send back, Decline, quote) stays on the configuration page unchanged.
- [ ] **Step 3: Overview content.** `side="internal"`; labels `CONFIG_STEP_*`; `nextText` = `CONFIG_NEXT_<NEXT>` with the client's name; config line: `next === "review"` → `CONFIG_REVIEW_REQUEST`, emphasized; else `CONFIG_OPEN…` (reuse an existing "Open" key if the bundle has one) → `/$slug/configs/$id/configuration`; no `entryActions`.
- [ ] **Step 4: Build and typecheck:** `bun --cwd apps/app build`, `bunx tsc -p apps/app/tsconfig.json --noEmit` → clean.
- [ ] **Step 5: Look at it** (headless probe, staff `localhost:5173/<slug>/configs/<id>`): a submitted client request shows the bar on Review with the Critical ring and "Review the request" emphasized; its configuration page has no timeline and still shows Accept/Send back/Decline; an internal configuration's `/configs/<id>` is today's page and `/configs/<id>/configuration` lands back on it.
- [ ] **Step 6: Commit** `feat(app): a client request opens on its progress and conversation; configuration on its own page`.

---

### Task 8: Whole-branch gate

- [ ] **Step 1:** `bun run test:ui`; `bun test apps/server/test/portal-projects.test.ts apps/server/test/portal-journey.test.ts apps/server/test/config-process.test.ts` (Postgres up) → PASS.
- [ ] **Step 2:** `bunx tsc --noEmit -p` each of `packages/ui`, `apps/server`, `apps/app`, `apps/portal` → clean.
- [ ] **Step 3:** `"<impeccable skill dir>/scripts/impeccable" detect --json packages/ui/src/journey packages/ui/src/project apps/portal/src/routes/$slug/projects apps/app/src/components/configurator/RequestOverview.tsx` → fix any finding that applies.
- [ ] **Step 4:** Update `CLAUDE.md`'s portal-projects paragraph in one or two sentences: a client project opens on its progress and chaptered timeline (`@confire/ui/project/ProjectOverview.tsx`), its form at `…/configuration`. Commit `docs: the client project page`.
