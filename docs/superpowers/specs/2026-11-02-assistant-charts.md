# Assistant charts and an audit of the assistant — 2026-11-02

## Charts in the chat

The chat answered in text only. A question like "sales by month" or "top customers" now answers with a
chart card in the chat.

- **Tools are procedures.** `reports.sap` and `reports.configs` (`orpc/routers/reports.ts`) are
  `userProcedure`s, so the chat (`reports_sap`, `reports_configs`) and MCP get the same rules: the
  membership join, `assertReadable` (admin-only SAP sets stay admin-only), `internalVisible` (no
  client draft).
- **The model asks and the server counts.** The model sends a spec (`ReportSpecZ`: title, chart,
  groupBy with an optional date `bucket`, series, 1–3 measures, filter, sort, top). The server reads
  the rows and `aggregate` (`report.ts`, pure, tested) builds the dataset. The figures always come from
  the server, as on every other card.
  - SAP: narrow `$select` pages through `readRows` (1000 rows a page), stopping at `MAX_SCAN` = 5000
    rows with `truncated`. A plain count is `$count` over one row.
  - Confire: one SQL read over the configurations and requests, through the list's own `compileQuery`.
  - Field names are checked before any read, and a wrong one is refused with the closest real names.
- **The card** (`apps/app/src/assistant/cards/ChartCard.tsx`) uses UI5's own charts (column, bar,
  line, donut, pie), so it follows the theme's palette, dark mode and high contrast. It also has
  figures (KPI), a table, a chart switch, a drill-down from a bar to its list and a CSV download.
  - The model's call is never needed: the card's actions run on their own.
  - The drill-down only opens a list the app has, and only filters by a field that list can filter
    on. Otherwise the list would show more rows than the chart counted.
  - The card is lazy-loaded, so the panel on every page does not carry the charts library.
- **The prompt** asks for a chart for comparisons, trends and rankings, and for one or two sentences
  instead of repeating the figures. `todayLine` gives the date, so a request like "this month" can be
  answered.

ponytail: the server counts at most 5000 rows itself. OData `$apply` (groupby/aggregate) would let SAP
count them, once it has been verified on a live Service Layer and added to the agent's allowlist.

Over MCP the same tools answer JSON. The user's own Claude draws the chart in its own way
(artifacts/analysis). An MCP Apps UI resource (`_meta.ui.resourceUri`) is the upgrade path if a
Confire-drawn chart is wanted there.

## Audit (TanStack AI 1.0 skills, claude-api skill)

Fixed:

1. **The history was never cached.** `route.ts` set `promptCache: "short"` and also put manual
   `cache_control` on two system blocks. When the adapter finds any marker of the caller's
   (`hasManualCacheControl`), it adds none of its own. So `promptCache` did nothing: each
   agent-loop call sent the whole thread and the earlier tool results at the full input price. The
   chat request now adds top-level automatic caching (`modelOptions.cache_control`). That makes three
   breakpoints of the four allowed. This is the claude-api skill's "robust combination for agent loops":
   an explicit breakpoint on the static system prefix, plus automatic caching for the growing tail.
2. **A declined answer drew nothing.** A `refusal` that the server-side fallback did not serve ends the
   run with `finishReason: "content_filter"` and no words. That run is now logged to Sentry, and the
   chat shows a notice.
3. **"This month" had no date.** The model had no date to work from. A one-line date now follows the
   language line, after the breakpoints.

Checked and kept:
- The pricing in `usage.ts` matches the live pricing page (2026-11-02). Sonnet 5.5 cache reads are
  $0.10. The bundled claude-api skill says $0.20, but it was cached on 2026-10-06 and is out of date.
- Refusal fallbacks: Sonnet sends `fallbacks: "default"` and the adapter adds the `-2026-07-01` beta.
- `max_tokens` comes from the adapter's per-model default.
- Thinking uses `reasoning` (adaptive + effort), never `budget_tokens` or sampling parameters.
- `chat()`, `toServerSentEventsResponse` and middleware are used as the TanStack skills prescribe.
  Tools are `toolDefinition().server()`, and the client is `useChat` from `@tanstack/ai-react`.
- Thinking from earlier runs is removed before replay (`withoutThinking`). This is the documented way
  to recover when the prefix changes between runs.

Recommendations (not done):
- **Keep the prefix append-only, so earlier thinking can be replayed.** The page section, the `dirty`
  flag and the language change between runs. Two options:
  - Send them as mid-conversation `role: "system"` messages, which Sonnet 5.5 supports and which are
    stored in the thread. The top-level system prompt then never changes.
  - Or send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` under
    `thinking-binding-controls-2026-08-01`, and log `input_transformations`.

  Either way, earlier reasoning is kept and stripping it is no longer a steady-state pattern. The
  adapter has a mid-conversation prompt channel (`mid.systemMessages`); check how `chat()` reaches it
  and how a thread would store it, and measure with an eval run (`scripts/assistant-eval.ts`).
- **The `dirty` flag sits inside the page section.** Each time it changes, the history cache misses
  once. Move it into the user turn, or into a mid-conversation system message.
- **Effort is `high` for every turn.** This is Sonnet 5.5's default. The claude-api guidance is `low`
  or `medium` for chat, so measure it with the eval before changing it. Per-message effort
  (`mid-conversation-output-config-2026-07-01`) avoids the cache reset.
- **About 30 tools on the general page.** TanStack's `lazy: true` (lazy tool discovery) could keep
  rarely used tools (`b1_schema`, `b1_find`, `timeline_list`) out of the prefix. Weigh this against
  the cache: discovered tools change the request.
