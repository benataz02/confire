# The assistant as Joule — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One assistant panel that looks and behaves like Joule on SAP for Me: a card from the ShellBar toggle, its chats behind ☰, maximized to the whole window with Joule's animation, draggable; the AI page and every other way into a chat removed; reports become plain pages whose chat is the panel.

**Architecture:** `AssistantPanel` stays shell state under `AssistantProvider`, mounted once and never unmounted. It decides which thread to show (`threadInput`), draws Joule's header, welcome and drawer, and computes its own box (`cardBox`) for card, dragged and maximized states. `ChatView` loses its page mode and reads Joule's palette from `--cf-a-*` custom properties set inline on the panel. `/reports/$id` becomes `ReportPage` (the report alone); the server only adds a timestamp to each stored message.

**Tech Stack:** React 19, UI5 Web Components React 2.27, TanStack Router and Query, oRPC v2 beta, `@tanstack/ai-react`, Bun tests.

**Spec:** `docs/superpowers/specs/2026-11-06-joule-assistant-design.md`

## Global Constraints

- The assistant has no stylesheet: every style is inline. Theme parameters and the panel's `--cf-a-*` custom properties are set on elements; custom properties inherit into UI5's shadow DOM (CLAUDE.md, "The assistant"). `global.css` only loses the search pulse rules.
- Joule's values are copied verbatim from spec §3 (the palette table is in Task 4).
- Typed navigation only: `useNavigate({ from: "/$slug" })` with `to: "/$slug/…"`.
- Every new text goes through `useI18n()`, with keys added to `apps/app/src/i18n/parts/<area>.{en,es,eu}.properties` (English is the base; translate es and eu). A key whose last caller goes is removed from all three files.
- Imports use explicit `.ts`/`.tsx` extensions; types use `import type`.
- The panel's guarantees (spec §6): mounted from the first open and never unmounted after that. An answer keeps streaming through close, maximize, restore, drag and a page change; the `ChatView` element must keep its place in the tree in every state. One thread is live in one place only. `ChatView` keeps writing finished messages into every cached copy of its thread.
- `prefers-reduced-motion: reduce`: no maximize transition and no drawer slide.
- Gates: `bun test apps/app`; `bunx tsc -p apps/app/tsconfig.json --noEmit`; `bun --cwd apps/app build` (regenerates the route tree). `bunx tsc -p packages/ui/tsconfig.json --noEmit` when `packages/ui` changes, and `bunx tsc -p apps/server/tsconfig.json --noEmit` plus the named server tests when the server changes. Server DB tests need Postgres (`docker compose up -d db`, which the user starts) and `DATABASE_URL`; without it they skip, and a skip is not a pass.
- Mark deliberate shortcuts with `// ponytail:` comments. Stage exact paths only: the tree has unrelated untracked files (`.impeccable/config.json` and others).

## Review Focus

1. **The chat's own navigation must not cut an answer:** a general chat's first report sends the user to `/reports/<new id>` mid-answer. The panel must keep the same `ChatView` (same thread id) while the report page loads. *Pinned by Task 2's `threadInput` test "waits while the report loads".*
2. **Deleting a report's chat deletes its report** (DB cascade `assistant_report.thread_id`). On that report's page, the panel must say so before deleting and then go home, not leave a page that errors. *Pinned by Task 5's server test.*
3. **Making the window smaller after a drag** must pull the card back into view. *Pinned by Task 6's `cardBox` test.*
4. **Switching theme with the panel open, or Horizon Auto following the OS,** must recolour the panel: Joule's colours in Horizon and Horizon Dark, and the theme's own parameters in high contrast and Quartz. *Pinned by Task 4's `paletteFor` tests.*
5. **Recent searches stored before this change** (`search.recent.<slug>` in localStorage, scope `chats`, `to` = `/assistant/…` or `/reports/…#chat`) must not show and lead to a dead page. *Pinned by Task 3's `parseRecent` test.*

---

### Task 1: Every stored message carries the time it was stored

**Files:**
- Modify: `apps/server/src/assistant/threads.ts` (`appendMessages` ~l.168, `MessageMeta` ~l.205)
- Modify: `apps/server/src/orpc/routers/assistant.ts:44-49` (the helper that appends and returns UI messages)
- Test: `apps/server/test/assistant-threads.test.ts`

**Interfaces:**
- Produces: `stamped(msgs: ModelMessage[], at: Date): ModelMessage[]`, which sets `metadata.at = at.toISOString()` on each message that has no `at` yet and leaves every other key alone. `appendMessages(threadId, msgs, title?): Promise<ModelMessage[]>` stores `stamped(msgs, new Date())` and returns what it stored. `MessageMeta` gains `at?: string`. The UI messages from `assistant.thread`, `extract` and `start` carry `metadata.at`.

- [ ] **Step 1: Write the failing tests**

At the top level (no DB), beside the file-label test:

```ts
test("each stored message carries when it was stored, on the message, never on a part", () => {
  const at = new Date("2026-11-06T13:34:00Z");
  const [u, a] = stamped([
    { role: "user", content: [{ type: "text", content: "hi" }] },
    { role: "assistant", content: "ok", metadata: { prefix: "p" } },
  ], at);
  expect(u!.metadata).toEqual({ at: "2026-11-06T13:34:00.000Z" });
  expect(a!.metadata).toEqual({ prefix: "p", at: "2026-11-06T13:34:00.000Z" });
  expect((u!.content as { metadata?: unknown }[])[0]!.metadata).toBeUndefined();
  expect(stamped([u!], new Date("2026-11-07T00:00:00Z"))[0]!.metadata).toEqual({ at: "2026-11-06T13:34:00.000Z" });
});
```

In the DB test "append-only; files are stored as references…", after `stored` is read:

```ts
expect(stored.messages.every((m) => typeof (m.metadata as { at?: unknown } | undefined)?.at === "string")).toBe(true);
const ui = await call(router.assistant.thread, { id: t.id }, { context: { headers: tenantHeaders(w.slug, w.a.cookie) } });
expect(ui.messages.every((m) => typeof m.metadata?.at === "string")).toBe(true); // survives modelMessagesToUIMessages
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/server/test/assistant-threads.test.ts`
Expected: FAIL, `stamped` is not exported.

- [ ] **Step 3: Implement `stamped`, and make `appendMessages` store and return stamped messages**

The stamp goes on the message, never on a part. The Anthropic adapter copies a *part's* metadata onto Claude's block, and Claude refuses unknown keys with a 400 (see the file-label test). It never reads a *message's* `metadata` (checked in `@tanstack/ai-anthropic` 1.0.0, `adapters/text.js`). That is also where `prefix` already lives, so the stamp never reaches the prompt or `prefixHash`. Write that reason as the comment on `stamped`. The router helper returns `modelMessagesToUIMessages(await appendMessages(…))`, so `extract` and `start` answer stamped messages too.

- [ ] **Step 4: Run the assistant's server tests**

Run: `bun test apps/server/test/assistant-threads.test.ts apps/server/test/assistant-router.test.ts apps/server/test/assistant-route.test.ts apps/server/test/reports.test.ts apps/server/test/b1-tools.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit`
Expected: PASS. If a test compares stored messages whole, make it ignore `metadata.at`, not drop the stamp.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/assistant/threads.ts apps/server/src/orpc/routers/assistant.ts apps/server/test/assistant-threads.test.ts
git commit -m "feat(assistant): stamp each stored message with when it was stored"
```

---

### Task 2: Reports are pages; the panel is their chat

**Files:**
- Modify: `apps/app/src/assistant/routeContext.ts`, `routeContext.test.ts`
- Modify: `apps/app/src/assistant/useAssistant.ts` (`useAssistantThread`)
- Modify: `apps/app/src/assistant/AssistantProvider.tsx`
- Modify: `apps/app/src/assistant/AssistantPanel.tsx`
- Modify: `apps/app/src/assistant/ChatView.tsx:45-46` (`kindOf`)
- Create: `apps/app/src/reports/ReportPage.tsx`
- Modify: `apps/app/src/routes/$slug/reports/$id.tsx`
- Modify: `apps/app/src/i18n/parts/report.{en,es,eu}.properties`

**Interfaces:**
- Produces, in `routeContext.ts`:
  - `export const REPORT_ROUTE = "/$slug/reports/$id"`
  - `export type ThreadInput = { id: string } | { projectId: string } | Record<string, never>`
  - `export function threadInput(s: { picked: string | null; projectId: string | null; reportId: string | null; reportThread: string | null | undefined }): ThreadInput | null`. Here `reportThread` is `undefined` while the report loads and `null` when it can't be read; `null` as the result means wait.
- Produces: `useAssistantThread(input: ThreadInput | null)`, with `enabled: !!input`, `placeholderData: keepPreviousData` and `staleTime: Infinity`.
- Produces, on `AssistantShell`: `openChat(text?: string): void`, which mounts and opens the panel on the page's own chat, the text (if any) put in its box; and `asked: { text?: string; at: number } | null`.
- Produces: `export function ReportPage({ id }: { id: string })`.
- Produces: `kindOf` returns `"report"` on `REPORT_ROUTE`.

- [ ] **Step 1: Write the failing tests** in `routeContext.test.ts`

```ts
test("a chat picked in the drawer wins over the page's", () => {
  expect(threadInput({ picked: "t9", projectId: "p1", reportId: null, reportThread: undefined })).toEqual({ id: "t9" });
});
test("a configuration's page opens its configuration's chat", () => {
  expect(threadInput({ picked: null, projectId: "p1", reportId: null, reportThread: undefined })).toEqual({ projectId: "p1" });
});
test("a report's page opens its report's chat, and waits while the report loads", () => {
  expect(threadInput({ picked: null, projectId: null, reportId: "r1", reportThread: "t1" })).toEqual({ id: "t1" });
  expect(threadInput({ picked: null, projectId: null, reportId: "r1", reportThread: undefined })).toBeNull();
});
test("a report that cannot be read, or any other page, opens the latest general chat", () => {
  expect(threadInput({ picked: null, projectId: null, reportId: "r1", reportThread: null })).toEqual({});
  expect(threadInput({ picked: null, projectId: null, reportId: null, reportThread: undefined })).toEqual({});
});
```

In "lists and the model builder carry none", replace the two `/$slug/assistant/…` lines with `expect(routeContext([m("/$slug/reports/$id", { id: "r1" })]).projectId).toBeNull();`.

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/app/src/assistant/routeContext.test.ts`
Expected: FAIL, `threadInput` is not exported.

- [ ] **Step 3: Implement `threadInput`, `REPORT_ROUTE`, the new `useAssistantThread` signature and `kindOf`'s report case**

- [ ] **Step 4: Run them and see them pass**

Run: `bun test apps/app/src/assistant/routeContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Provider and panel**

Provider:
- `openChat` sets mounted, open, and `asked = { text, at: Date.now() }`.
- The panel is drawn everywhere but the AI page: the `onAiPage` check keeps only `/$slug/assistant` (Task 3 removes it).

Panel:
- `reportId = route.routeId === REPORT_ROUTE ? route.params.id : null`, with its `reports.get` query enabled only then. `reportThread` is `report.data?.threadId`, `null` on `report.error`, `undefined` while loading.
- `const [picked, setPicked] = useState<string | null>(null)`. Set it to `null` when the route changes to a page with its own chat (`route.projectId || reportId`), and when `shell.asked?.at` changes. The thread is `useAssistantThread(threadInput({ picked, projectId: route.projectId, reportId, reportThread }))`.
- Pass `ChatView` `prefill={shell.asked?.text ? { text: shell.asked.text, at: shell.asked.at } : undefined}`.
- `kind` is `"configure"` with a configuration, else `"report"` when `thread.data?.reportId`, else `kindOf(route)`.
- Pass `ChatView` `onTool(name)`. On `report_set`, invalidate `orpc.reports.get.key()`, `orpc.reports.tiles.key()` and `orpc.assistant.threads.key()`. If the shown thread has no `reportId` yet (a general chat's first report), read it past the cache: `client.assistant.thread({ id })`. When that has a `reportId`, seed `orpc.assistant.thread.queryKey({ input: { id } })` with it, then `navigate({ to: "/$slug/reports/$id", params: { id: reportId } })`.

The seeded copy and `keepPreviousData` keep the same thread id on screen while the report loads, so `ChatView` (keyed by thread id) does not remount.

- [ ] **Step 6: `ReportPage`, moved out of `AssistantPage`**

Keep `AssistantPage.tsx` itself until Task 3; `/assistant/$id` still uses it.
- Move over the live run as it is: `live`, `busy`, `failed`, `generation`, `filters`, `runLive`. It runs once on the first definition.
- A later definition, which the panel's invalidation brings in after a `report_set`, increments `generation`, clears `filters`, `live` and `failed`, and does not run again: `report_set` stored its run. Detect "later" by reference. TanStack Query's structural sharing keeps the definition's reference until it really changes; say so in a comment.
- `ReportView` gets `actions`:
  - `REPORT_EDIT`, Emphasized, NeverOverflow: `shell.openChat()`.
  - Rename and Delete as `AssistantPage`'s `renameReport`/`removeReport`. Delete still removes the thread's cached copies and goes to `/$slug`.
- `onChip={(label) => shell.openChat(t("REPORT_CHANGE_CHIP", label))}`.
- `onSave` and `onFilter` as today.
- With no definition, open the panel once (`openChat()`) and draw an Information `MessageStrip` with `REPORT_NOTHING_YET` = "Nothing drafted yet. Ask the assistant for this report." (es, eu translated).
- On an error, a Negative `MessageStrip` with `refusalText`; while loading, a centred `BusyIndicator`.
- The route renders `<ReportPage key={id} id={id} />`, and the head's fallback title is `t("HOME_REPORTS")`.

- [ ] **Step 7: Gates and a manual check**

Run: `bun test apps/app && bunx tsc -p apps/app/tsconfig.json --noEmit && bun --cwd apps/app build`
Expected: PASS.

Manual (`bun run dev`, a tenant with a saved report):
- Opened from home, the report shows alone with the panel closed.
- *Edit* opens the panel on the report's chat.
- A chip opens it with "change this" text in the box.
- Asking the panel to change the report updates the page, and no second chat appears.
- On home, a general chat asked for a report moves to `/reports/<new id>`; the answer keeps streaming in the same panel.

- [ ] **Step 8: Commit**

```bash
git add apps/app/src/assistant/routeContext.ts apps/app/src/assistant/routeContext.test.ts apps/app/src/assistant/useAssistant.ts apps/app/src/assistant/AssistantProvider.tsx apps/app/src/assistant/AssistantPanel.tsx apps/app/src/assistant/ChatView.tsx apps/app/src/reports/ReportPage.tsx apps/app/src/routes/\$slug/reports/\$id.tsx apps/app/src/i18n/parts/report.*.properties
git commit -m "feat(app): a report is a page and the panel is its chat"
```

---

### Task 3: The AI page and every way into it go

**Files:**
- Delete: `apps/app/src/assistant/AssistantPage.tsx`, `apps/app/src/assistant/WavingDots.tsx`, `apps/app/src/routes/$slug/assistant/index.tsx`, `apps/app/src/routes/$slug/assistant/$id.tsx`
- Create: `apps/app/src/assistant/RenameField.tsx` (`AssistantPage.tsx:344-358` moved as is, exported; Task 5 uses it)
- Create: `apps/app/src/components/searchRecent.ts`, `searchRecent.test.ts`
- Modify: `apps/app/src/assistant/AssistantProvider.tsx`, `apps/app/src/assistant/ChatView.tsx`, `apps/app/src/components/AppShell.tsx`, `apps/app/src/components/GlobalSearch.tsx`, `apps/app/src/routes/$slug/index.tsx`, `packages/ui/src/global.css:227-237`
- Modify: `apps/app/src/i18n/parts/{assistant,report,shell}.{en,es,eu}.properties`

**Interfaces:**
- Produces: `export type Recent = SearchHit & { scope: string }`, `recentKey(slug: string): string` and `parseRecent(raw: string | null): Recent[]` in `searchRecent.ts`. `GlobalSearch` reads `parseRecent(localStorage.getItem(recentKey(slug)))`. Import `SearchHit` with `import type` from `./GlobalSearch.tsx`.
- Produces: `ChatView` has no `page` prop.

- [ ] **Step 1: Write the failing test** `searchRecent.test.ts`

```ts
test("recent hits from the removed Chats scope are dropped", () => {
  const raw = JSON.stringify([
    { text: "Cabinet", icon: "ai", to: "/assistant/t1", scope: "chats" },
    { text: "Sales", icon: "business-objects-experience", to: "/reports/r1#chat", scope: "chats" },
    { text: "Quotations", icon: "sales-quote", to: "/b1/Quotations", scope: "pages" },
  ]);
  expect(parseRecent(raw).map((r) => r.to)).toEqual(["/b1/Quotations"]);
});
test("broken JSON or a broken entry reads as nothing", () => {
  expect(parseRecent("{")).toEqual([]);
  expect(parseRecent(JSON.stringify([{ text: 1 }]))).toEqual([]);
  expect(parseRecent(null)).toEqual([]);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test apps/app/src/components/searchRecent.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `searchRecent.ts`**

It is `GlobalSearch`'s `recentKey`/`readRecent` moved, plus dropping `scope === "chats"`.

- [ ] **Step 4: Remove the page and its ways in**

- `AssistantProvider`: draws `{mounted ? <AssistantPanel /> : null}`; no route check, and its comment no longer mentions the AI page.
- `AppShell`:
  - The AI side-nav group exists only for admins; its one item is *AI usage*. Remove the `ASSISTANT_PAGE_TITLE` entry and `onAiPage`.
  - The toggle becomes `pressed={assistant.open}`, `disabled={toggle.disabled}`, `expanded: assistant.open`. Remove the comment about the AI page.
- Home (`routes/$slug/index.tsx`): remove the *AI assistant* and *New report* tiles and their comments. Leave out a section that has no tiles, as Reports will for a user with no saved report.
- `GlobalSearch`:
  - Remove the `chats` scope, the `chats` and `latestChats` queries, `chatHit`, `onAiPage` with its scope effect, and the pulse class.
  - The empty field's list is `recent` filtered by scope, as for every other scope. Update the header comment, which ends "and the user's own chats", and the `busy` list.
- `global.css`: remove the `confire-search-pulse` keyframes and rules.
- `ChatView`:
  - Remove `page` with everything only it used: `HeroBanner`, `BANNER`, `BOX`, `WavingDots`, the page composer branch and the page prompts (`REPORT_PROMPT_*`).
  - `begin` becomes `setBegun(true); step()`.
  - `onStarted` always navigates, and the focus effect depends on `shell.open` only.
  - Keep `READING`, `BARE_FIELD` and `FOCUS`: Tasks 4 and 6 use them.
- i18n: remove `ASSISTANT_PAGE_TITLE`, `ASSISTANT_PAGE_SUB`, `REPORT_DONE`, `REPORT_PROMPT_PIPELINE`, `REPORT_PROMPT_OVERDUE`, `HOME_NEW_REPORT`, `HOME_NEW_REPORT_SUB`, `SHELL_SEARCH_CHATS` and `SHELL_SEARCH_RECENT_CHATS` from en, es and eu.

- [ ] **Step 5: Gates and the leftovers check**

Run: `bun test apps/app && bunx tsc -p apps/app/tsconfig.json --noEmit && bunx tsc -p packages/ui/tsconfig.json --noEmit && bun --cwd apps/app build`
Expected: PASS.

Run: `grep -rnE '"/assistant|\$slug/assistant|AssistantPage|onAiPage|WavingDots|search-pulse|ASSISTANT_PAGE_|REPORT_DONE|HOME_NEW_REPORT|SEARCH_CHATS|SEARCH_RECENT_CHATS|REPORT_PROMPT_' apps/app/src packages/ui/src --include=*.ts --include=*.tsx --include=*.css --include=*.properties | grep -v routeTree.gen`
Expected: no output.

Manual:
- A non-admin's side nav has no AI group.
- Home has no AI tile and no *New report* tile.
- The search has no Chats scope, and an old recent chat hit is gone.
- `/<slug>/assistant` shows the app's "page not found".
- The ShellBar toggle opens and closes the panel everywhere.

- [ ] **Step 6: Commit**

```bash
git add -A apps/app/src/assistant apps/app/src/routes/\$slug/assistant apps/app/src/components apps/app/src/routes/\$slug/index.tsx apps/app/src/i18n/parts packages/ui/src/global.css
git commit -m "feat(app): the ShellBar toggle is the assistant's only way in"
```

---

### Task 4: Joule's colours and the chat's look

**Files:**
- Create: `apps/app/src/assistant/palette.ts`, `palette.test.ts`
- Create: `apps/app/src/assistant/stamp.ts`, `stamp.test.ts`
- Modify: `apps/app/src/assistant/ChatView.tsx`, `apps/app/src/assistant/AssistantPanel.tsx`
- Modify: `apps/app/src/i18n/parts/assistant.{en,es,eu}.properties`

**Interfaces:**
- Produces, in `palette.ts` (pure, no UI5 import, so Bun can test it):
  - `export type Palette = "light" | "dark" | null`
  - `export function paletteFor(theme: string, osDark: boolean): Palette`
  - `export function paletteVars(p: Palette): CSSProperties`, the 18 `--cf-a-*` properties below.
- Produces, in `AssistantPanel.tsx`: a local `usePalette(): Palette` over `getTheme()` (`@ui5/webcomponents-base/dist/config/Theme.js`), `attachThemeLoaded`/`detachThemeLoaded` (`@ui5/webcomponents-base/dist/Theming.js`) and `matchMedia("(prefers-color-scheme: dark)")` change events. `getTheme()` answers `sap_horizon_auto` for Horizon Auto, and that theme follows the OS.
- Produces, in `stamp.ts`:
  - `timeOf(m: { metadata?: Record<string, unknown>; createdAt?: Date | number | string }): Date | null`: the server's `metadata.at`, else a live message's `createdAt`; `null` when neither parses.
  - `stampText(at: Date, now: Date, locale: string, t: (key: string, ...a: string[]) => string): string`: `ASSISTANT_TODAY`/`ASSISTANT_YESTERDAY` with `Intl.DateTimeFormat(locale, { timeStyle: "short" })`, else `Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })`.
- Produces: `ChatView` takes `welcome?: ReactNode`, drawn centred while the chat is empty.

The palette (spec §3; *muted*, *text* and *mark* come from the inspection mockups):

| `--cf-a-…` | dark | light | other themes |
|---|---|---|---|
| `head` (header bar, welcome) | `#140069` | `#f4f2ff` | `var(--sapAssistant_BackgroundGradient)` |
| `head-text` | `#f5f6f7` | `#000` | `var(--sapAssistant_TextColor)` |
| `head-hover` | `#4db1ff` | `#5d36ff` | `var(--sapAssistant_Hover_TextColor)` |
| `head-active` | `#4db1ff` | `#a100c2` | `var(--sapAssistant_Active_TextColor)` |
| `page` (conversation, drawer) | `#1d232a` | `#fff` | `var(--sapBackgroundColor)` |
| `text` | `#f5f6f7` | `#131e29` | `var(--sapTextColor)` |
| `question` | `#12171c` | `#eae5ff` | `var(--sapAssistant_Question_Background)` |
| `accent` (composer border, New chat, badge text, selected bar) | `#4db1ff` | `#5d36ff` | `var(--sapLinkColor)` |
| `accent-soft` (selected row, badge) | `#1d2d3e` | `rgba(116,88,255,.06)` | `var(--sapList_SelectionBackgroundColor)` |
| `more` (a row's •••) | `#f5f6f7` | `#5d36ff` | `var(--sapButton_Lite_TextColor)` |
| `send` | `#0070f2` | `#5d36ff` | `var(--sapButton_Emphasized_Background)` |
| `send-empty` | `rgba(0,112,242,.5)` | `#beafff` | `var(--sapButton_Emphasized_Background)` |
| `send-text` | `#fff` | `#fff` | `var(--sapButton_Emphasized_TextColor)` |
| `focus` | `#9ad3ff` | `#5d36ff` | `var(--sapContent_FocusColor)` |
| `hover-shadow` | `0 4px 8px #1B90FF29, 0 0 2px #1B90FF29` | `0 0 2px #5d36ff` | `none` |
| `muted` (stamps, disclaimer off the welcome) | `#8396a8` | `#556b82` | `var(--sapContent_LabelColor)` |
| `mark` (welcome icon) | `#f5f6f7` | `#5d36ff` | `var(--sapAssistant_TextColor)` |
| `shadow` (card) | `2px 2px 8px rgba(93,54,255,.16)` | same | `var(--sapContent_Shadow2)` |

- [ ] **Step 1: Write the failing tests**

`palette.test.ts`:

```ts
test("Horizon is Joule's light, Horizon Dark its dark, Horizon Auto follows the OS", () => {
  expect(paletteFor("sap_horizon", true)).toBe("light");
  expect(paletteFor("sap_horizon_dark", false)).toBe("dark");
  expect(paletteFor("sap_horizon_auto", false)).toBe("light");
  expect(paletteFor("sap_horizon_auto", true)).toBe("dark");
});
test("high contrast and Quartz keep the theme's own parameters", () => {
  for (const th of ["sap_horizon_hcb", "sap_horizon_hcw", "sap_horizon_hc_auto", "sap_fiori_3", "sap_fiori_3_dark"]) expect(paletteFor(th, true)).toBeNull();
});
test("every palette sets the same properties; Joule's values are SAP for Me's", () => {
  const keys = (p: Palette) => Object.keys(paletteVars(p)).sort();
  expect(keys("light")).toEqual(keys("dark"));
  expect(keys(null)).toEqual(keys("dark"));
  expect(keys("dark")).toHaveLength(18);
  expect(paletteVars("dark")).toMatchObject({ "--cf-a-head": "#140069", "--cf-a-question": "#12171c", "--cf-a-accent": "#4db1ff", "--cf-a-send": "#0070f2" });
  expect(paletteVars("light")).toMatchObject({ "--cf-a-head": "#f4f2ff", "--cf-a-question": "#eae5ff", "--cf-a-accent": "#5d36ff", "--cf-a-send-empty": "#beafff" });
});
```

`stamp.test.ts`:

```ts
const t = (k: string, ...a: string[]) => `${k} ${a.join(",")}`;
test("today and yesterday by the calendar day, then the date", () => {
  const now = new Date(2026, 10, 6, 18, 0);
  expect(stampText(new Date(2026, 10, 6, 13, 34), now, "es", t)).toBe("ASSISTANT_TODAY 13:34");
  expect(stampText(new Date(2026, 10, 5, 23, 59), now, "es", t)).toBe("ASSISTANT_YESTERDAY 23:59");
  expect(stampText(new Date(2026, 9, 31, 9, 5), new Date(2026, 10, 1, 8, 0), "es", t)).toBe("ASSISTANT_YESTERDAY 9:05");
  const old = new Date(2026, 10, 4, 9, 5);
  expect(stampText(old, now, "es", t)).toBe(new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(old));
});
test("the server's stamp first, a live turn's own time next, else none", () => {
  expect(timeOf({ metadata: { at: "2026-11-06T13:34:00.000Z" }, createdAt: new Date(0) })?.toISOString()).toBe("2026-11-06T13:34:00.000Z");
  expect(timeOf({ createdAt: 1_700_000_000_000 })?.getTime()).toBe(1_700_000_000_000);
  expect(timeOf({})).toBeNull();
  expect(timeOf({ metadata: { at: "garbage" } })).toBeNull();
});
```

(If Bun's `es` short time is `09:05`, assert `"ASSISTANT_YESTERDAY " + new Intl.DateTimeFormat("es", { timeStyle: "short" }).format(...)` in the month-boundary case instead of hard-coding it.)

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/app/src/assistant/palette.test.ts apps/app/src/assistant/stamp.test.ts`
Expected: FAIL, the modules are missing.

- [ ] **Step 3: Implement `palette.ts` and `stamp.ts`**

- [ ] **Step 4: Run them and see them pass**

Run: `bun test apps/app/src/assistant/palette.test.ts apps/app/src/assistant/stamp.test.ts`
Expected: PASS.

- [ ] **Step 5: Restyle `ChatView` on the `--cf-a-*` properties**

- Root: `background` and `color` are `var(--cf-a-head)`/`var(--cf-a-head-text)` while empty, else `var(--cf-a-page)`/`var(--cf-a-text)`.
- The user's bubble: `maxWidth: "85%"`, `padding: "0.5rem 1rem"`, `borderRadius: "8px 8px 0 8px"`, `background: var(--cf-a-question)`, no border, `whiteSpace: pre-wrap`, `overflowWrap: anywhere`.
- The answer: no bubble. No background, border or padding; `alignSelf: flex-start`; keep the markdown block margins.
- A stamp above each turn: `stampText(timeOf(first message of the turn), new Date(), formatLocale(), t)`, centred, `0.75rem`, `var(--cf-a-muted)`, and nothing when `timeOf` is null. Carry the turn's first message in the `turns` reduce. Do **not** change the merged `m` (`{ ...m, parts }`): its `id` is the last message's, which the live-turn checks compare.
- `ASSISTANT_BUTTONS`: Emphasized background, border and their hover variants are `var(--cf-a-send)`; the text is `var(--cf-a-send-text)`.
- Composer: a pill around attach, the auto toggle, the field (`BARE_FIELD` merged over `ROW_FIELD`), an × clear button (`decline`, `ASSISTANT_CLEAR`, shown while there is text) and send.
  - Pill style: `minHeight: 2.25rem`, `borderRadius: 1.25rem`, `border: 1px solid var(--cf-a-accent)`, `background: var(--cf-a-page)`.
  - Hovered: `boxShadow: var(--cf-a-hover-shadow)`. Focused: `outline: 0.125rem solid var(--cf-a-focus)`.
  - Tokens stay above the pill.
  - Send is round: `--sapButton_BorderCornerRadius: 50%`, 1.75rem if the host's size takes (else UI5's size, noted in a comment). Its `--sapButton_Emphasized_Background` is `var(--cf-a-send-empty)` while there is nothing to send and `--sapContent_DisabledOpacity: 1`, else `var(--cf-a-send)`.
- The foot: `padding: 0.5rem 1rem 0.625rem` and no top border. Then, only while empty, the quick prompts (moved out of the scroller), centred. Then the disclaimer: `ASSISTANT_DISCLAIMER`, centred, `0.6875rem`, `var(--cf-a-head-text)` while empty, else `var(--cf-a-muted)`. Joule's `rgba(245,246,247,.3)` is too faint to read.
- `welcome` is drawn in the scroller while empty, centred, after `notices`.

- [ ] **Step 6: The panel's frame, header and welcome**

- The aside's style starts with `...paletteVars(usePalette())`. `borderRadius: 1rem`, `boxShadow: var(--cf-a-shadow)`, `background: var(--cf-a-page)`, `width: min(26rem, 100vw - 2rem)`, `insetInlineEnd: 1rem`, `bottom: 1rem`; the top stays measured under the ShellBar (+0.5rem).
- Header bar instead of `HEAD` and `hero()`: `height: 2.625rem`, `background: var(--cf-a-head)`, `color: var(--cf-a-head-text)`, the title `1rem` bold with ellipsis. On it: `--sapButton_Lite_TextColor: var(--cf-a-head-text)`, `--sapButton_Lite_Hover_TextColor: var(--cf-a-head-hover)`, `--sapButton_Active_TextColor: var(--cf-a-head-active)`, and transparent Lite backgrounds and borders for normal, hover and active. Keep the title and subtitle and the `+`/expand/close buttons for now; Tasks 5 and 6 replace them.
- `welcome`: the `ai` icon at `4rem` in `var(--cf-a-mark)`; `ASSISTANT_HELLO` at `1rem` bold; then `ASSISTANT_WELCOME_CONFIGURE` for a configuration's chat, else `ASSISTANT_WELCOME_START`. That sentence names reports, and the panel is now the only place to ask for one. Plain elements, so the colour is inherited.
- i18n: add `ASSISTANT_DISCLAIMER` = "The assistant uses AI. Verify results.", `ASSISTANT_TODAY` = "Today {0}", `ASSISTANT_YESTERDAY` = "Yesterday {0}" and `ASSISTANT_CLEAR` = "Clear" (es, eu translated). Remove `ASSISTANT_WELCOME_GENERAL`.

- [ ] **Step 7: Gates and a look in three themes**

Run: `bun test apps/app && bunx tsc -p apps/app/tsconfig.json --noEmit && bun --cwd apps/app build`
Expected: PASS.

Manual, in Evening Horizon, Morning Horizon and High Contrast Black:
- Check against spec §3: the header `#140069`/`#f4f2ff`; the welcome fills the card; the pill border `#4db1ff`/`#5d36ff`; send `#0070f2`/`#5d36ff`; the question bubble with its square bottom-right corner; the answer as plain text; "Today hh:mm" above new messages and none on old ones; the 11 px disclaimer.
- High Contrast Black keeps its own colours.
- A theme picked in the user menu while the panel is open recolours it without a reload. On Horizon Auto, the OS's dark switch does the same.

- [ ] **Step 8: Commit**

```bash
git add apps/app/src/assistant/palette.ts apps/app/src/assistant/palette.test.ts apps/app/src/assistant/stamp.ts apps/app/src/assistant/stamp.test.ts apps/app/src/assistant/ChatView.tsx apps/app/src/assistant/AssistantPanel.tsx apps/app/src/i18n/parts/assistant.*.properties
git commit -m "feat(app): the assistant in Joule's colours, with stamped messages"
```

---

### Task 5: The chat drawer and the header's menu

**Files:**
- Create: `apps/app/src/assistant/ChatDrawer.tsx`
- Modify: `apps/app/src/assistant/AssistantPanel.tsx`
- Test: `apps/server/test/reports.test.ts`
- Modify: `apps/app/src/i18n/parts/assistant.{en,es,eu}.properties`

**Interfaces:**
- Consumes: `RenameField` (Task 3), `useAssistantThread`/`threadInput`/`picked` (Task 2), the `--cf-a-*` properties (Task 4).
- Produces, in `ChatDrawer.tsx`:
  - `export type ChatRow = Awaited<ReturnType<typeof client.assistant.threads>>[number]`
  - `export function useChats(): { rows: ChatRow[]; label(r: ChatRow): string; pin(r: ChatRow): Promise<void>; rename(r: ChatRow, title: string | null): void; remove(r: ChatRow): Promise<boolean> }`. This is `AssistantPage`'s `act`/`rename`/`remove` logic, over `orpc.assistant.threads.queryOptions({ input: undefined })`. `label` is `title || reportTitle || projectName || ASSISTANT_UNTITLED`. `remove` confirms with `ASSISTANT_DELETE_REPORT_CONFIRM` for a report's chat (its report goes too), else with `ASSISTANT_DELETE_CONFIRM`. It deletes, removes every cached copy of the thread, invalidates `threads` (and `reports.tiles`/`reports.get` for a report's chat), and answers whether it deleted.
  - `export function ChatDrawer(p: { open: boolean; mode: "card" | "sidebar"; openId: string | null; onPick(r: ChatRow): void; onNew(): void; onHide(): void })`. Task 6 adds the sidebar mode's layout; this task draws `mode="card"`.

- [ ] **Step 1: Write the failing server test** in `reports.test.ts`, inside `describe("reports")`

```ts
test("deleting a report's chat deletes its report", async () => {
  const w = await world();
  await call(router.assistant.deleteThread, { id: w.r.threadId }, w.staff);
  expect(await code(call(router.reports.get, { id: w.r.id }, w.staff))).toBe("NOT_FOUND");
});
```

- [ ] **Step 2: Run it**

Run: `bun test apps/server/test/reports.test.ts`
Expected: PASS already, through the DB cascade. The test pins the cascade that the panel's confirm text and "go home" rely on; if it fails, stop and report, since the spec's delete behaviour depends on it.

- [ ] **Step 3: `ChatDrawer`** (spec §3 "Chat drawer", §5.3)

- `<nav aria-label={ASSISTANT_CHATS}>`, `16rem` wide, `background: var(--cf-a-page)`, `color: var(--cf-a-text)`, `fontFamily: var(--sapFontFamily)`.
- From the top:
  - ☰ (`menu2`, `onHide`, `accessibleName` `ASSISTANT_CHATS`, `accessibilityAttributes.expanded`) and `ASSISTANT_TITLE` bold.
  - *New chat* (`add`, `ASSISTANT_NEW_CHAT`): outlined with `--sapButton_Background: transparent`, `--sapButton_BorderColor` and `--sapButton_TextColor` `var(--cf-a-accent)`, `--sapButton_BorderCornerRadius: 0.5rem`.
  - Up to two groups, *Pinned* (`ASSISTANT_PINNED`, only when a row is pinned) and *Chats* (`ASSISTANT_CHATS`). Each header is a native `<button aria-expanded>` with the name, a count badge (`var(--cf-a-accent)` on `var(--cf-a-accent-soft)`, radius 0.5rem) and a chevron (`slim-arrow-down`/`slim-arrow-right`), collapsed in local state.
  - Rows: a `<ul>` of `<li>`, each a native `<button>` (the label, ellipsis) plus a Transparent `overflow` Button (`ASSISTANT_CHAT_ACTIONS`, colour `var(--cf-a-more)`). The button opens a `Menu` with Pin/Unpin, Rename and Delete. As in `AssistantPage`'s `onMenuClosed`, act once the menu has closed, because it hands focus back to its opener.
  - Rows are `2rem` tall with `borderRadius: 0.375rem`. The open row's background is `linear-gradient(to right, var(--cf-a-accent) 0.188rem, var(--cf-a-accent-soft) 0.188rem)`. Rename swaps the label for `RenameField`.
- No footer.
- Card mode:
  - `position: absolute`, `insetBlock: 0`, `insetInlineStart: 0`, `zIndex: 1`, `boxShadow: 2px 0 8px rgba(0,0,0,.1)`.
  - Slides with `transform: translateX(-100%)` → `none` over `0.2s ease-out` (none with reduced motion), with `visibility` hidden after it closes.
  - `inert` while closed. Escape inside it calls `onHide` and stops propagation, so the panel stays open.

- [ ] **Step 4: Wire the panel**

- Header: ☰ toggles `drawer` (local state) · the title · ••• (`overflow`, only when the chat is not empty) · the size button · ✕.
- Title: `ASSISTANT_TITLE` while the chat is empty, else `label` of the row whose id is the shown thread's (if there is no such row, `ASSISTANT_TITLE`). Remove the subtitle and `ASSISTANT_GENERAL`.
- The header's ••• opens a `Menu`: Pin/Unpin, Rename (the title becomes `RenameField`), Delete, and `ASSISTANT_OPEN_CONFIG` (`sales-quote`, `useOpenForm()(projectId)`).
  - Open configuration is listed only for a configuration's chat whose form is not on screen. Its form route is `/$slug/configs/$id` for an internal configuration (`view.request === null`), else `/$slug/configs/$id_/configuration`.
- *New chat* (`onNew`): `client.assistant.newThread({})`. Seed `orpc.assistant.thread.queryKey({ input: { id } })` with `{ id, projectId: null, reportId: null, messages: [] }`, then `setPicked(id)`. A failure goes to the existing error strip. Remove the panel's `+` button and its `newChat` with the confirm.
- `onPick(r)`: a report's chat (`r.reportId`) calls `setPicked(null)` and navigates to `/$slug/reports/$id`; any other calls `setPicked(r.id)`. In card mode the drawer closes after a pick or *New chat*.
- After `remove` of the shown chat: `setPicked(null)`. If the route is that chat's report's page, navigate to `/$slug`.
- i18n: add `ASSISTANT_CHATS` = "Chats", `ASSISTANT_PINNED` = "Pinned", `ASSISTANT_DELETE_REPORT_CONFIRM` = "Delete this chat and the report it made?" (es, eu translated). Remove `ASSISTANT_GENERAL` and `ASSISTANT_NEW_CHAT_CONFIRM`.

- [ ] **Step 5: Gates and a manual check**

Run: `bun test apps/app && bunx tsc -p apps/app/tsconfig.json --noEmit && bun --cwd apps/app build`
Expected: PASS.

Manual:
- ☰ slides the drawer over the card.
- *New chat* shows the welcome with "Assistant" as the title.
- Picking a configuration's chat on home stays on home, and ••• offers *Open configuration*. Picking a report's chat opens its report page.
- On a configuration's page, a picked general chat stays until you open another configuration.
- Pin moves a row under *Pinned*. Rename works in the row and in the header.
- Deleting the open configuration's chat shows a fresh one. Deleting a report's chat on its page asks, then goes home.
- Escape closes the drawer first, then the panel.

- [ ] **Step 6: Commit**

```bash
git add apps/app/src/assistant/ChatDrawer.tsx apps/app/src/assistant/AssistantPanel.tsx apps/server/test/reports.test.ts apps/app/src/i18n/parts/assistant.*.properties
git commit -m "feat(app): the assistant's chats behind a drawer, as Joule's"
```

---

### Task 6: Maximize, its animation, and dragging

**Files:**
- Create: `apps/app/src/assistant/geometry.ts`, `geometry.test.ts`
- Modify: `apps/app/src/assistant/AssistantPanel.tsx`, `apps/app/src/assistant/ChatDrawer.tsx` (sidebar mode), `apps/app/src/assistant/ChatView.tsx` (`wide`)
- Modify: `apps/app/src/i18n/parts/assistant.{en,es,eu}.properties`

**Interfaces:**
- Produces, in `geometry.ts`:
  - `export type Pos = { x: number; y: number }`
  - `export type Box = { left: number; top: number; width: number; height: number; radius: number }`
  - `export function cardBox(s: { maximized: boolean; pos: Pos | null; vw: number; vh: number; top: number }): Box`. `top` is the card's undragged top (the ShellBar's bottom + 8). The card is `min(416, vw − 32)` wide and `vh − top − 16` tall, `left = vw − 16 − width`, radius 16, or at `clampPos(pos)`. Maximized it is `{ 0, 0, vw, vh, radius: 0 }`.
  - `export function clampPos(p: Pos, size: { width: number; height: number }, vw: number, vh: number): Pos`, clamped to `[0, vw − width] × [0, vh − height]`.
- Produces: `ChatView` takes `wide?: boolean`; wide, the scroller's and the foot's inline padding is `READING` (a centred 48 rem column; Joule's is ~784 px).

- [ ] **Step 1: Write the failing tests** `geometry.test.ts`

```ts
test("Joule's spot: 416 wide, 16 px from the right and bottom, under the ShellBar", () => {
  expect(cardBox({ maximized: false, pos: null, vw: 1440, vh: 900, top: 60 })).toEqual({ left: 1008, top: 60, width: 416, height: 824, radius: 16 });
});
test("maximized is the whole window with square corners, wherever the card was", () => {
  expect(cardBox({ maximized: true, pos: { x: 10, y: 10 }, vw: 1440, vh: 900, top: 60 })).toEqual({ left: 0, top: 0, width: 1440, height: 900, radius: 0 });
});
test("a narrow window narrows the card", () => {
  expect(cardBox({ maximized: false, pos: null, vw: 400, vh: 800, top: 60 }).width).toBe(368);
});
test("a dragged card stays where it was put, inside the window, over the ShellBar too", () => {
  expect(cardBox({ maximized: false, pos: { x: 200, y: 0 }, vw: 1440, vh: 900, top: 60 })).toMatchObject({ left: 200, top: 0 });
  expect(clampPos({ x: -50, y: 2000 }, { width: 416, height: 824 }, 1440, 900)).toEqual({ x: 0, y: 76 });
});
test("a window made smaller pulls a dragged card back into view", () => {
  expect(cardBox({ maximized: false, pos: { x: 1000, y: 40 }, vw: 1000, vh: 700, top: 60 })).toMatchObject({ left: 584, top: 40 });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/app/src/assistant/geometry.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement `geometry.ts`**

- [ ] **Step 4: Run them and see them pass**

Run: `bun test apps/app/src/assistant/geometry.test.ts`
Expected: PASS.

- [ ] **Step 5: The panel's box, maximize and its animation**

- State, local to the panel: `maximized`, `pos: Pos | null`, `animating`, `sidebar` (default true), `{ vw, vh }` from a `resize` listener, and `top` measured as today. Local state is enough: the panel never unmounts once mounted (Task 3), so it survives restore and close/reopen and is lost on reload, as spec §5.7 asks.
- The aside is `position: fixed` at `cardBox(…)`'s `left`/`top`/`width`/`height`/`borderRadius`, in px, so card ↔ window can animate. `zIndex: 4`, over NavigationLayout's ShellBar at 3. UI5 popups render in the top layer, so menus and dialogs opened from the panel still show above it. Replace the stacking comment with that reason.
- The size button: `full-screen`/`exit-full-screen`, `ASSISTANT_MAXIMIZE`/`ASSISTANT_RESTORE`. It sets `animating` and flips `maximized`. While `animating` (and without reduced motion) the aside has `transition: all 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)`. `transitionend` on the aside itself clears it, with a 600 ms timeout as a fallback.
- Back to the card: when the route changes and the panel is maximized, animate back. That one effect covers every navigation by the chat (first report, Create, *Open configuration*, a report's chat picked); spec §5.4. Closing (`!shell.open`) sets `maximized` false without animation.
- Layout:
  - The aside is a row: `ChatDrawer` first, then a column (`flex: 1`, `minWidth: 0`) holding `ChatView`, whose `head` draws the header. Both are always rendered, so `ChatView` keeps its place in every state.
  - Maximized, `ChatDrawer` gets `mode="sidebar"`: static, `16rem`, shown while `sidebar`, its ☰ hides it, with `borderInlineEnd: 1px solid var(--sapGroup_TitleBorderColor)` and no slide.
  - The header's ☰ is drawn only when not maximized or when the sidebar is hidden.
  - `ChatView wide={maximized}`. The welcome grows when maximized: icon `6rem`, greeting `1.5rem`.

- [ ] **Step 6: Dragging**

- On the header bar, not maximized: `onPointerDown`. Ignore buttons other than the main one, and targets inside `ui5-button, ui5-toggle-button, ui5-input, button, input`.
- Then keep the pointer's offset from the aside's rect and `setPointerCapture`. `onPointerMove` does `setPos(clampPos(pointer − offset, rect size, vw, vh))`; `onPointerUp`/`onPointerCancel` end the drag.
- The header gets `cursor: move` (`default` when maximized), `touchAction: none` and `userSelect: none`.
- A drag never sets `animating`.
- `// ponytail: drag by pointer only; arrow keys on the header if someone needs to move it without a mouse.`
- i18n: add `ASSISTANT_MAXIMIZE` = "Maximize" and `ASSISTANT_RESTORE` = "Restore" (es, eu translated). Remove `ASSISTANT_EXPAND` and `ASSISTANT_COLLAPSE`.

- [ ] **Step 7: Gates and a manual check**

Run: `bun test apps/app && bunx tsc -p apps/app/tsconfig.json --noEmit && bun --cwd apps/app build`
Expected: PASS.

Manual:
- Ask a question with a long answer. While it streams, maximize, restore, drag the card over the ShellBar, close and reopen: the answer goes on from where it was and never restarts.
- Maximized covers the ShellBar with square corners. The sidebar is shown, its ☰ hides it, and the header's ☰ brings it back.
- Restore returns to the dragged spot.
- Make the window smaller: a dragged card stays in view.
- With "reduce motion" on in the OS, maximize is instant.
- A `•••` menu and the delete confirm open above the maximized panel.
- *Create* on a read request while maximized opens the form with the panel back as a card.

- [ ] **Step 8: Commit**

```bash
git add apps/app/src/assistant/geometry.ts apps/app/src/assistant/geometry.test.ts apps/app/src/assistant/AssistantPanel.tsx apps/app/src/assistant/ChatDrawer.tsx apps/app/src/assistant/ChatView.tsx apps/app/src/i18n/parts/assistant.*.properties
git commit -m "feat(app): the assistant maximizes to the window and drags, as Joule"
```

---

### Task 7: The server drops the start-over path

**Files:**
- Modify: `apps/server/src/assistant/threads.ts` (delete `clearThread`)
- Modify: `apps/server/src/orpc/routers/assistant.ts:100-106`
- Test: `apps/server/test/assistant-threads.test.ts`

**Interfaces:**
- Produces: `assistant.newThread` with input `z.object({}).optional()`, answering `{ id }` of `blankThread`. Nothing calls it with `projectId` since Task 5 (`grep -rn "newThread(" apps/app/src` shows only `{}`).

- [ ] **Step 1: Remove the test** "a configuration's chat starts over…" (l.58-76) and `clearThread` from the import. The lease is still pinned by "one run per thread".
- [ ] **Step 2: Delete `clearThread`, and the `projectId` branch and input of `newThread`**
- [ ] **Step 3: Gates**

Run: `bun test apps/server/test/assistant-threads.test.ts apps/server/test/assistant-router.test.ts && bunx tsc -p apps/server/tsconfig.json --noEmit && bunx tsc -p apps/app/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/assistant/threads.ts apps/server/src/orpc/routers/assistant.ts apps/server/test/assistant-threads.test.ts
git commit -m "refactor(assistant): no configuration chat start-over; Delete does it"
```

---

### Task 8: The docs say what was built

**Files:**
- Modify: `CLAUDE.md` ("The assistant": the panel and AI page paragraph, the *Reports* bullet, the colours sentence)
- Modify: `docs/superpowers/specs/2026-10-24-ai-assistant-design.md` (§4.2), `docs/superpowers/specs/2026-11-03-assistant-reports-design.md` (§6.2)
- Modify: comments that still name the AI page (`grep -rn "AI page" apps packages --include=*.ts --include=*.tsx`)

- [ ] **Step 1: CLAUDE.md**

- Replace the panel/AI page paragraph: one panel from the ShellBar toggle (the only way in), Joule's card, ☰ drawer, maximized to the window (`cardBox`), draggable, and which chat it shows (`threadInput`).
- Reports: `/reports/$id` is `ReportPage`, and its chat is the panel (*Edit*, chips through `openChat`, a first `report_set` navigates there). Remove read mode and `#chat`.
- Colours: Joule's palette in Horizon and Horizon Dark (`palette.ts`, `--cf-a-*` set inline), the theme's `--sapAssistant_*` elsewhere.
- Messages carry `metadata.at` (`stamped`). It is message-level, never part-level, so it never reaches the model.

- [ ] **Step 2: Add one line under each superseded spec section:** "Superseded by `2026-11-06-joule-assistant-design.md`."
- [ ] **Step 3: Fix each comment the grep finds** (`useAssistantInvalidate`, `threads.ts`' `blankThread`/`listThreads`, the router's `threads`) so it names the panel's drawer instead.

Run: `grep -rn "AI page\|AssistantPage" apps packages CLAUDE.md --include=*.ts --include=*.tsx --include=*.md | grep -v docs/superpowers`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-10-24-ai-assistant-design.md docs/superpowers/specs/2026-11-03-assistant-reports-design.md apps/app/src/assistant/useAssistant.ts apps/server/src/assistant/threads.ts apps/server/src/orpc/routers/assistant.ts
git commit -m "docs: the assistant is one Joule panel"
```
