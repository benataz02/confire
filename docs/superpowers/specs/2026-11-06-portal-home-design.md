# Portal home redesign

Date: 2026-11-06. Mockup: `.superpowers/brainstorm/481031-1793970933/content/layout-a-v2.html`
(local, gitignored; layout A with pins).

## Why

The portal's landing page (`apps/portal/src/routes/$slug/index.tsx`) is four equal cards: requests
by status, quotes awaiting an answer, recent documents, open invoices. It is hard to read. It does not
answer what a manufacturer's customer opens the portal for: **where are my inquiries, and is it my
move?** The redesign makes the customer's open inquiries and their progress the page, with a
one-click way to start a new one and the latest documents below.

## Goals

- **Open inquiries with their progress**, the whole journey and not only Confire's part:
  **sent → review → quoted → ordered → delivered → invoiced**. Ordered, delivered and invoiced are SAP
  documents that descend from the inquiry's quotation.
- At a glance, **whose move it is** for each inquiry, in plain words.
- **Quick actions:** *New project* and opening one inquiry (the row).
- **Latest documents** below the inquiries.
- **Pins:** a customer pins inquiries to keep them on top.
- The page is **home**: its URL is `/<slug>/home`, no longer the slug's index.

## Non-goals

- The journey on the project page or the Projects list. Home only. Both can reuse the journey
  element later.
- Pinning from anywhere but home.
- New notifications. The SAP steps already notify through `document_sent` events.
- Following an inquiry's documents across a SAP company switch. The rule stands that a quotation is
  linked only in its company.

## Anti-goals

- The four-card dashboard look again, with equal tiles that say nothing about urgency.
- A down SAP agent breaking the page. Postgres content must render without SAP, as today
  (`home.ts`: "two calls on purpose").
- A figure on home that disagrees with the rows under it.

## The page (decided with the user)

Layout A of the mockup, top to bottom:

1. **HeroBanner**: overline = the date and "<company> at <supplier>"; header = a greeting with the
   user's first name (the staff home's morning/afternoon/evening greeting); `actions` = **New
   project** (buyers and owners only, as `projects.create` is `portalBuyerProcedure`). Inside it,
   three figures:
   - **Need your answer**: quoted with no response yet, plus changes requested (`returned`).
     Critical colour when not zero.
   - **With <supplier>**: `submitted` + `in_review`, plus quoted-and-accepted that has no order
     yet. The supplier is working on all of these. *(Adding the accepted ones: my call. The user
     approved submitted + in review.)*
   - **Ordered, not yet invoiced**: the stored SAP step is ordered or delivered.
2. **Open inquiries**: a table, section title plus an *All projects ›* link to the Projects list.
   Columns: pin · inquiry (name, plus a sub-line with the latest step and its date, e.g. "Quoted
   3 Nov · 6.950,00 €", "Delivered 4 Nov", "Draft · started 2 Nov") · progress (the six-step journey) ·
   next (a tag in plain words) · navigation. Clicking the row opens `/$slug/projects/$id`.
3. **Latest documents**: a list, section title plus an *All documents ›* link. The newest
   documents across quotations, orders, deliveries and invoices; an open invoice's amount in the
   critical colour. Open invoices no longer get a card of their own. Clicking opens
   `/$slug/docs/$entity/$key`. Each line shows type and number, date and amount. The mockup's
   project name on each document is dropped, because attaching it would need the chain walk's
   results inside the documents read *(my call)*.

**Which inquiries are open**: every company project (`portalCardCode`) that is not finished.
Finished = SAP shows it **invoiced**, or the supplier **declined** it (`status = declined`). A draft is
open. A quote the customer declined is not finished, because `quoteDecline` sends the project back
to `in_review` for a new quote.

**Pins** are the user's own, not their colleagues'. A pinned inquiry sorts first and **stays on home
after it is finished**, until unpinned.

**Order**: pinned first, then the customer's move, then the supplier's, then drafts; within each
group, the latest change first. *(Order within groups: my call.)*

### Journey and "next", per state

| Project state | Journey (✓ done, ● current) | Next tag | Tag design |
|---|---|---|---|
| `draft` | ● sent | Finish and send | Neutral |
| `submitted`, `in_review` | ✓ sent, ● review | <supplier> reviews | Information |
| `returned` | ✓ sent, ● review (critical) | Make the changes | Critical |
| `quoted`, no response | ✓ sent, review, ● quoted (critical) | Answer the quote | Critical |
| `quoted`, accepted, no order | ✓ …quoted, ● ordered | Waiting for the order | Information |
| SAP: ordered | ✓ …ordered, ● delivered | Delivery next | Information |
| SAP: delivered | ✓ …delivered, ● invoiced | Invoice next | Information |
| SAP: invoiced (pinned only) | all ✓ | Done | Positive |
| `declined` (pinned only) | stopped at review, negative | Declined | Negative |

An invoice raised straight from the order, with no delivery, counts as invoiced, and the delivery
step is drawn done. A viewer (`portal_viewer`) sees the same tags but cannot act on them: the
project page already enforces that. *(Viewer wording unchanged: my call.)*

## Constraints and existing pieces to build on

- **Data split stays.** `home.overview` reads Postgres only. Anything that reads SAP is a second call
  with `retry: false`, and a failure there costs the SAP parts, never the page.
- **SAP steps are stored on the project** *(my call, which the user agreed to)*: a new nullable
  column on `config_project` holds the furthest SAP step observed (`ordered` | `delivered` |
  `invoiced`), plus that document's date for the sub-line. The SAP call walks the chain for every
  open, quoted project whose `b1Company` is the agent's company, writes any step that moved, and
  answers the new steps. The page lays them over the overview rows. Once a project is invoiced it is
  never read again. A step only moves forward *(my call: a cancelled order is out of scope)*. The
  overview's figures and "open" filter read the stored column, so they work with SAP down. Ships as a
  migration (`bun run db:generate`, per CLAUDE.md).
- **Chain walk**: `doc-chain.ts` `documentChain` is three sequential crossjoins per quotation (its
  ponytail comment names this exact case). `baseClause` already takes a set of base entries, so one
  walk over all open quotations is three crossjoins in total, attributed back by `BaseEntry`. Batch
  it. Each hop's `$top` counts document–line pairs (the existing ponytail): size `top` to the batch.
- **SAP down**: the journey shows the stored step, and a single critical `MessageStrip` above the
  table says SAP can't be reached (the current `PORTAL_HOME_SAP_DOWN` text), with the same note in
  the documents section. *(Refines the user-approved "journey stops at Quoted": with the stored step
  it stops at the last step it knew.)*
- **Pins storage**: `ui_user_state` (tenant, user, key), key `portal:homePins`, value = an array of
  project ids. The portal already exposes `views.getState` / `views.setState` for its own user, so
  the page writes pins with no new procedure. `home.overview` reads the key server-side (`getUserState`
  in `ui-views.ts`), so pinned finished projects come back in the same call. Ids that no longer
  resolve inside the company fence are ignored.
- **Figures are not links** *(my call)*. The staff home's rule is that a tile's figure opens a list
  showing exactly its rows, and two of these three cannot be expressed as Projects-list filters. The
  table directly below already lists them.
- **Route**: `routes/$slug/index.tsx` becomes `routes/$slug/home.tsx` (`/$slug/home`). The slug's
  index stays as a `beforeLoad` redirect to it, so the lobby's `portalTenantUrl(slug)`, mail links and
  the `navigate({ to: "/$slug" })` calls in accept, onboarding and company keep working. The shell's
  Home item (`PortalShell.tsx`, `data-to="/"`, `selected={pathname === "/"}`) moves to `/home`.
- **Texts**: `apps/portal/src/i18n/parts/portal.{en,es,eu}.properties`. Add the new keys in all
  three languages and delete the `PORTAL_HOME_*` keys nothing uses any more.
- **Theme**: every colour is a Horizon variable (`--sapPositiveColor`, `--sapInformativeColor`,
  `--sapCriticalColor`, `--sapNegativeColor`, `--sapNeutralBorderColor`, …). No raw colours.

## UI5 components (checked with the UI5 MCP, 2.27)

| Part | Component |
|---|---|
| Banner, greeting, New project | `HeroBanner` (`overlineText`, `headerText`, `actions` slot) + `Button icon="add"`, as `apps/app/src/routes/$slug/index.tsx` |
| Three figures | the staff home's `Tile` look (`cf-tiles`, `-home.css`). Reuse it rather than redraw: moving `Tile` and its CSS into `@confire/ui` is the builder's call |
| Inquiries table | `Table` + `TableHeaderRow`/`TableHeaderCell` + `TableRow`/`TableCell`, row navigation with `TableRowActionNavigation` (or the row's `interactive` press) |
| Pin | `Button design="Transparent"` with `pushpin-on` / `pushpin-off` (both in `@ui5/webcomponents-icons`), its own press only (it must not open the row), with an accessible name |
| Next | `Tag` with the design from the table above |
| Journey | no UI5 component fits: `Wizard` is for input and a horizontal `Timeline` is an event log. A small custom element: six dots joined by lines, labelled, theme variables only, `role="img"` with an `aria-label` such as "Step 3 of 6: Quoted" |
| Latest documents | `List` + `ListItemStandard type="Navigation"` (icon from `DOC_PAGES`, date as description, amount as `additionalText`, `additionalTextState="Critical"` for an open invoice), as today |
| Empty states | `IllustratedMessage` (no inquiries: with New project for buyers; no documents) |
| SAP down | `MessageStrip design="Critical"` |

## Left to the builder

- The exact procedure shapes. For example, `home.overview` returning rows, pins and figures, and a
  SAP call returning the step changes plus the latest documents. Whether the latest-documents read
  and the chain walk share one call or use two.
- How many latest documents to show (today 5) and whether to cap the inquiries table (suggest no
  cap, with a `ponytail:` note naming a cap if a big customer makes it long).
- Whether the journey element lives in `@confire/ui` now or in the portal until a second user needs it.
- The column's name and type for the stored SAP step.
- Loading states: the shimmer skeleton (`confire-op-skel-bar`) for figures and rows, as on the staff home.
- Tests: the state → journey/next mapping is a pure function and gets one small test. So does the
  batched chain attribution (pure over crossjoin JSON, like `flattenChain`).
