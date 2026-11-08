# The assistant as Joule: one panel, its chats inside, maximized to the whole window

Status: design, 2026-11-06. Supersedes the AI page of the assistant spec
(`2026-10-24-ai-assistant-design.md` §4.2: `AssistantPage`, `/assistant`, `/assistant/$id`) and the
docked-chat layout of the reports spec (`2026-11-03-assistant-reports-design.md` §6.2). The server,
the tools, the threads and everything the chat draws inside itself are unchanged unless named here.

## 1. Intent

The user wants the assistant to behave and look **exactly** like Joule on SAP for Me (the reference:
`me.sap.com/softwarecenter`, inspected live on 2026-11-06, values in §3). Today Confire has two
assistants that half-overlap: a floating panel, and a separate AI page with its own chat list reached
from the side nav, a home tile, the shell search and the *New report* tile. Joule has one: a card that
opens from the ShellBar, keeps its chats behind a ☰ drawer, and maximizes to the whole window. The
user's words: emulate "its colors, how to open chats, how it expands and takes the whole page", then
"add maximize animation, same it does currently" and "the assistant can be draggable when non full
page".

Success: a user who knows Joule finds Confire's assistant behaves the same way. There is one place
chats live, and one way in.

## 2. Goals, non-goals, anti-goals

Goals (the user's):
- The ShellBar's assistant toggle is **the only access point**. The AI page goes, with its side-nav
  entry, its home tile, the home tile *New report* and the shell search's *Chats* scope.
- The panel copies Joule: card, colours, header, welcome, ☰ chat drawer, maximize to the whole window
  with Joule's animation, and dragging by the header when not maximized.
- A report is a page (`/reports/$id`) and the panel is its chat, as a configuration's page is today.

Non-goals:
- No change to the server's assistant (`route.ts`, skills, tools, auto mode, metering, MCP), apart
  from the message timestamp (§5.9).
- No change to what the chat draws inside: step folds, decision cards, question and candidates cards,
  file drops, quick prompts and suggestion chips stay. They sit in the new frame and take its colours
  *(my call: the user did not answer whether they stay)*.
- No change to the portal (it has no assistant).
- No resizing of the card (Joule has none).

Anti-goals (would make it a failure even if it works):
- A second way into a chat. Every route to `/assistant`, the Chats search scope and the home tiles
  must be gone, not just hidden.
- Breaking what the panel guarantees today: an answer streaming when the panel closes keeps streaming
  (the panel stays mounted); one thread is never live in two places; a configuration's page still
  opens its configuration's chat.
- A light theme drawn in dark Joule colours, or a high-contrast theme drawn in Joule's palette.

## 3. The reference, measured

All values were read off Joule's DOM and stylesheet (`.cui_theme_purple`, SAP for Me's own palette).
Joule does **not** use the theme's `--sapAssistant_*` parameters: in Horizon Light
`--sapAssistant_Active_Background` is `#fff`, in the high-contrast themes brown or orange.

### Card (not maximized)
- `position: fixed`, 416 px wide, 1 rem from the window's right and bottom edges, top just under the
  ShellBar (`max-height: 90%`). Corner radius 16 px (`1rem`). Shadow `2px 2px 8px rgba(93,54,255,.16)`.
- Header bar 42 px (`2.625rem`): ☰ · title · [`•••` once a chat is open] · ⤢ · ✕. The title is
  "Joule" (ours: the assistant's name) on the welcome screen and the chat's name once one is open.
- Welcome screen (a chat with no messages): the header's colour fills the whole card. Centred: the
  assistant mark large (Joule's diamond with sparkles, which animate), "Hello <first name> and
  welcome!" (16 px bold), one paragraph. Composer at the foot, then a disclaimer line, 11 px:
  "Joule uses AI. Verify results."
- Conversation: the page colour (`#1d232a` dark). A centred timestamp (small, grey) above each message.
  The user's message is a bubble on the right: `#12171c` in dark, radius `8px 8px 0 8px` (the square
  corner is the tail), padding 8 × 16 px. The assistant's answer is plain text on the left, no bubble,
  with a *Sources* list when there is one. While it works: italic "Thinking…" with animated dots.
- Composer: a pill (radius 20 px, 36 px tall) holding the text field and a round 28 px send button.
  An × clear button appears once there is text.

### Palette

| | Horizon Dark | Horizon (Light) |
|---|---|---|
| Header bar | `#140069` over `rgba(116,88,255,.08)` | `#f4f2ff` |
| Welcome screen | `#140069`, text `#f5f6f7` | `#f4f2ff`, text `#000` |
| Header buttons | `#f5f6f7`, hover/active `#4db1ff` | `#000`, hover `#5d36ff`, active `#a100c2` |
| Composer border | `#4db1ff`; hover shadow `0 4px 8px #1B90FF29, 0 0 2px #1B90FF29`; focus outline `.125rem solid #9ad3ff` | `#5d36ff`; hover shadow `0 0 2px #5d36ff`; focus outline `.125rem solid #5d36ff` |
| Send button | `#0070f2`, empty `rgba(0,112,242,.5)` | `#5d36ff`, empty `#beafff` |
| Drawer / sidebar background | `#1d232a` | `#f4f2ff` (sidebar header) |
| *New chat*, count badge | `#4db1ff` | `#5d36ff` |
| Selected chat | `linear-gradient(to right, #4db1ff .188rem, #1d2d3e .188rem)` | `linear-gradient(to right, #5d36ff .188rem, rgba(116,88,255,.06) .188rem)` |
| List item `•••` | `#f5f6f7` | `#5d36ff` |
| Disclaimer | `#f5f6f7` on the welcome, else `rgba(245,246,247,.3)` | `#131e29` on the welcome |
| Card shadow | `2px 2px 8px rgba(93,54,255,.16)` | same |

The light question bubble was not inspected (only Dark could be opened). *My call:* `#eae5ff`
(`--sapAssistant_Question_Background` in Horizon Light).

### Chat drawer (☰, card mode)
A 256 px drawer slides in over the card's left edge (the conversation stays visible beside it). From
the top: ☰ and the name, *New chat* (an outlined button), the group header with a count badge and a
collapse chevron, the chats (32 px rows, radius 6 px; the open one marked with the 3 px bar above),
and Joule's footer (expiry note, *AI Notice*). Each chat row has a `•••` menu: Rename, Delete. The
open chat's header `•••` menu: Rename, Delete, New.

### Maximized
- `position: fixed; inset: 0; width: 100vw; height: 100vh`, corners 0. It covers **the whole window,
  ShellBar included**.
- The drawer becomes a fixed 256 px sidebar, always shown, with its own ☰ that hides it (☰ then moves
  into the chat's header). The chat's header bar spans the rest. The conversation and the composer are
  a centred column about 784 px wide.
- ⤡ goes back to the card.

### Animation
While toggling, the card gets `transition: all 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94)`. Size,
position and corner radius (16 → 0) animate together, from wherever the card is to the window's
edges, and back. Measured: ~450 ms of visible movement, ease-out (big steps first). The class is only
on during the toggle: dragging is not animated.

### Dragging
The header bar (not its buttons) drags the card anywhere in the window. It is kept inside the window
and may cover the ShellBar. The position survives maximize → restore and close → reopen, and is
forgotten on reload (Joule keeps it in memory only; what it does persist is the last open
conversation).

## 4. Who decided what

The user decided:
- Emulate Joule exactly: colours, how chats open, maximizing to the whole page.
- The maximized panel replaces the AI page; the ShellBar toggle is the only access point.
- The shell search's *Chats* results and the home tile *New report* go too.
- Reports: the report is a page and the panel is its chat. A chat's first report goes to that page
  with the panel still open, back to card size if it was maximized (from the option the user picked).
- The maximize animation as Joule does it.
- Draggable when not maximized.

My calls are marked *(my call)* where they appear. They are collected in §8.

## 5. The design

### 5.1 One way in; what goes
- **The toggle** (`AppShell`'s ShellBar `ToggleButton`, `assistantToggle`) opens and closes the panel
  everywhere. It is no longer disabled or forced pressed on an AI page (there is none).
- **Removed:** `routes/$slug/assistant/index.tsx` and `$id.tsx`; `AssistantPage.tsx`; the side-nav
  entry `ASSISTANT_PAGE_TITLE` → `/assistant`; the home tiles *AI assistant* and *New report*
  (`routes/$slug/index.tsx`); the *Chats* scope, its hits, *Recent chats* and the AI-page scoping in
  `GlobalSearch.tsx`; every `onAiPage` check (`AppShell`, `AssistantProvider`, `GlobalSearch`). The
  i18n keys only these used go with them. *(My call:)* no redirect from old `/assistant/…` URLs.
- **Kept:** the AI usage page (`/usage`, admin) and its side-nav entry. That is a meter, not a way into
  a chat. Saved report tiles on home open `/reports/$id`.

### 5.2 The card
It keeps the panel's guarantees: mounted from the first open and hidden when closed, under
`AssistantProvider`, `Escape` closes it. It is drawn as §3 describes: size, radius, shadow, header,
welcome, conversation, composer, disclaimer. The header's title is the assistant's name on a new
chat's welcome, else the chat's name (`label`: title, report title, configuration name, "Untitled").
The `•••` menu is for the open chat (§5.4). The welcome keeps today's greeting and per-kind sentence
(`ASSISTANT_HELLO`, `ASSISTANT_WELCOME_*`), and today's quick prompts under the composer. The
welcome's mark is the `ai` icon unless the builder finds a sparkle treatment that reads as Joule's.

Colours: §3's palette in Horizon and Horizon Dark, Horizon Auto following whichever it resolves to.
*(My call:)* in every other theme (high contrast, Quartz) the panel keeps today's theme parameters
(`--sapAssistant_*`, `--sapBackgroundColor`, …), so high contrast stays high contrast.

### 5.3 The chat drawer
☰ toggles the drawer (card mode) or the sidebar (maximized). Contents, from the top:
- *New chat*: always a new blank general chat (`assistant.newThread({})`, which reuses the user's
  blank one, `blankThread`). It replaces the panel's `+` button.
- The user's chats, `assistant.threads` (pinned first, then latest; the server caps the list at
  100). *(My call:)* two groups like Joule's *Active*: *Pinned* (only when there is one) and *Chats*,
  each with its count badge and collapse chevron. No search field: Joule has none, and the Chats
  search scope is gone. *(Ponytail: the 100 most recent; add a search field if users lose chats past
  that.)*
- Each row: the chat's label, the open one marked. Its `•••` menu holds Pin/Unpin, Rename, Delete
  *(my call: Pin stays, as chats can be pinned today)*. Rename is in place; Delete asks first
  (`ASSISTANT_DELETE_CONFIRM`), as today.
- Footer *(my call)*: no expiry note (Confire's chats do not expire) and no *AI Notice* (there is no
  notice page). The disclaimer under the composer is the AI notice.

Picking a chat in card mode closes the drawer; maximized, the sidebar stays.

### 5.4 Which chat the panel shows
The panel shows one chat at a time:
1. On a configuration's page, that configuration's chat. On a report's page, that report's chat
   (`reports.get` → `threadId`).
2. A chat picked in the drawer replaces it until the user moves to another page that has its own
   chat (rule 1). Elsewhere a pick stays until another pick or *New chat*.
3. Otherwise, the user's latest general chat (today's `assistant.thread({})`).

Deleting the open chat falls back to rules 1 and 3 *(my call)*; a configuration's or report's page then
opens a fresh thread for it, as the server does today.

*(My call:)* picking a report's chat goes to its report page, because a report's chat edits what that
page shows. Picking a configuration's chat stays where the user is: the thread outranks the page
(today's rule), and *Open configuration* is one of the chat's next actions under the last answer.

**One rule for leaving the panel's size:** whenever the chat takes the user to a page, the panel
returns to card size so the page is visible. That covers a chat's first report, a report's chat
picked in the drawer, *Create* on a read request (today `onStarted` navigates to the configuration's
form), and *Open configuration*.

The header `•••` menu: Pin/Unpin, Rename, Delete. *Open configuration* is a next action (beside the
quick replies) on a configuration's chat when its form is not on screen. Starting a configuration's chat over (today the `+` with a confirm,
`newThread({ projectId })`) becomes Delete *(my call)*: the next open makes a fresh thread.

### 5.5 Maximized
As §3: the whole window with the sidebar, the header bar over the rest, and the conversation and
composer in a centred column (today's `READING` already centres at 48 rem; Joule's column is ~784 px,
the builder picks one). The chat is the same `ChatView` element in both sizes: maximizing must not
remount it, as an answer may be streaming.

The AI page's empty-chat `HeroBanner` and `WavingDots` go. The maximized welcome is the card's
welcome, larger.

### 5.6 Animation
Joule's transition (§3) on maximize and restore, from the card's current spot (dragged or not) to
the window and back. Only during the toggle: never while dragging. *(My call:)* with
`prefers-reduced-motion: reduce` it is instant, as the panel's greeting already is.

### 5.7 Dragging
Not maximized, the header bar drags the card (pointer events; the buttons on it do not start a
drag). It is clamped inside the window, and covering the ShellBar is allowed, which means the card
layers above the ShellBar (today it sits at `zIndex: 1`, under NavigationLayout's ShellBar at 3). The
position lives in `AssistantProvider` (memory only). It survives restore and close/reopen, is lost on
reload, and is re-clamped when the window shrinks. Before any drag the card sits where Joule's does.

### 5.8 Reports
`/reports/$id` stops drawing `AssistantPage`. It draws the report alone: `ReportView` with today's
live run, filter bar, refresh, save to home, rename and delete, moved over from `AssistantPage`. The
panel floats over it as over any page.
- **Edit** opens the panel (on the report's chat, by §5.4). The *Done* half goes; ✕ closes the panel.
- A report's chip (*change this*, `onChip`) opens the panel and puts the text in its box (today's
  `prefill`).
- The page re-reads the report when the panel's chat stores one (`report_set`, today's `onTool`).
- A general chat's first `report_set` (which creates the report, `adoptReport`) takes the user to
  `/reports/<new id>`, the panel open on the same chat and back to card size (§5.4).
- The report page's title stays the report's. A saved report opened from home no longer has a "read
  mode": it is just the page, and its chat is behind the toggle or Edit.

### 5.9 Timestamps
Joule stamps every message. Stored messages carry no time today. *(My call:)* stamp each message
when it is stored, in its metadata. The timestamp must not reach the model, so the cached prompt
prefix and `prefixHash` stay as they are. Messages stored before the change show none. The builder
confirms how the metadata survives `modelMessagesToUIMessages`.

## 6. Constraints
- **The panel's guarantees** (assistant spec §4.2, `AssistantProvider`): mounted once opened, hidden
  when closed; a stream survives closing, maximizing, restoring and dragging; one thread live in one
  place only. Each `ChatView` writes its finished messages into every cached copy of its thread, as
  today.
- **Styling:** the assistant has no stylesheet; every style is inline on the UI5 components, with
  theme parameters set on them so they reach their shadow DOM (CLAUDE.md, "The assistant"). Joule's
  palette fits that: per-theme values chosen in code, not a new CSS file. The light/dark choice must
  follow the theme actually applied (Horizon Auto resolves by the OS; `@confire/ui/appearance.ts`).
- **Typed navigation:** `useNavigate({ from: "/$slug" })` with `to: "/$slug/…"`.
- **i18n:** every new text through `useI18n()` in `messagebundle_{en,es,eu}.properties`.
- **Accessibility:** the drawer and sidebar are a labelled list; ☰, ⤢/⤡, ✕ and each `•••` have
  accessible names; the drag handle has a keyboard path or none is promised *(builder's call)*.
  Escape still closes.
- Type-checking per project is the gate (`apps/app`, `packages/ui`, and `apps/server` if §5.9 touches
  it), plus `bun --cwd apps/app build` for the route tree once the `/assistant` routes are deleted.

## 7. Left to the builder
- How the palette is chosen per theme: a hook over UI5's applied theme, or another way that keeps
  "no stylesheet".
- Whether the drawer slides (Joule's does; duration and easing are not measured) and the
  "Thinking…" dots.
- The exact maximized column width (Joule ~784 px, today's `READING` 48 rem).
- The z-order once the card covers the ShellBar, provided UI5 popovers, menus and dialogs opened from
  inside the panel still show above it.
- Whether `newThread({ projectId })`/`clearThread` lose their last caller and can go.
- How in-place rename looks (today's `RenameField` is one way).

## 8. My calls, for checking
1. Step folds, decision cards, file drops, quick prompts and chips stay, restyled to the frame.
2. Light theme = Joule's light values; high-contrast and Quartz keep the theme's parameters.
3. Light question bubble `#eae5ff`.
4. Pin stays (row and header menus); two groups, *Pinned* and *Chats*; no search field.
5. No expiry note, no *AI Notice* link.
6. *New chat* is always a general chat; starting a configuration's chat over is Delete.
7. A report's chat picked in the drawer goes to its report; a configuration's chat stays put.
8. Any navigation by the chat returns the panel to card size.
9. The report page's *Edit* opens the panel; *Done* goes.
10. Timestamps on messages stored from now on.
11. Reduced motion: no animation.
12. No redirect from old `/assistant` URLs.

## 9. Docs to update
CLAUDE.md, "The assistant": the panel and AI page paragraphs, *Reports* (the docked chat, read mode,
`#chat`), and every mention of the AI page or `AssistantPage`. The assistant spec §4.2 and the reports
spec §6.2 get a line pointing here.
