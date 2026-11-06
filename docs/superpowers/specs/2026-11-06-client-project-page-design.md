# Client projects: progress and conversation, in both apps

Date: 2026-11-06. Mockup: `.superpowers/brainstorm/611794-1793980676/content/project-overview.html`
(local, gitignored; layout **C**, "the steps are the timeline's chapters").
Follows `2026-11-06-portal-home-design.md`, which left "the journey on the project page" as a non-goal.

## Why

A project a client sent through the portal opens, in both apps, on its configuration form, with the
timeline at the very bottom (portal: `apps/portal/src/routes/$slug/projects/$id.tsx`; staff:
`ConfigProcessPage`, `/<slug>/configs/<id>`). What both sides come back for is different: **how far
has this got, whose move is it, and what did the other side say?** The configuration is worked on at
the start, and again when it is sent back or reviewed. The redesign splits a client project in two:

- **The project page**, at the URL everything already opens (portal `/<slug>/projects/<id>`, staff
  `/<slug>/configs/<id>`): the project's **progress** and its **conversation**.
- **The configuration page**, its own URL: today's form, without the timeline.

**Scope: only projects with portal interaction** — a configuration with `portalCardCode` set (staff
side: `configs.get`'s `request` is non-null). A configuration staff create for themselves keeps
today's page, unchanged, at `/<slug>/configs/<id>`.

## Goals

- A **progress bar** of the six journey steps the portal home already draws (sent · review · quoted
  · ordered · delivered · invoiced), larger and with **an icon on each step** and the date each was
  reached. The current step's ring says whose move it is.
- Below it, **the timeline** (chat, details, attachments, SAP documents), **split into chapters, one
  per step**. Each comment, file and document sits under the step it happened in. Clicking a reached
  step on the bar scrolls to its chapter.
- **One line to the configuration** between the bar and the timeline: a short summary and a link,
  the page's main action while the configuration is that side's work.
- Steps still to come hinted after the conversation, faded.
- **One implementation, two apps.** The bar, the chapters, the page layout and the journey rule are
  written once and shared; each app supplies its queries, actions and texts.

## Non-goals

- Internal configurations (no client): untouched, in every way.
- New server state or events. Everything shown exists: status, quote response, `sapStep`, timeline
  events, the live SAP document chain.
- Changing who may do what, or when.
- The lists and homes. Their rows keep opening the same URLs, now the project page.

## Anti-goals

- A client's decision that depends on SAP being up. Accept/Decline must work when the live documents
  read fails.
- A chapter that repeats, or a timeline out of time order. It is a chat: it reads top to bottom.
- A second copy of the journey rule in a browser. The server decides `step` and `next`
  (`portal/journey.ts`, `journeyOf`); the pages draw them.
- Two copies of the page, one per app.

## The project page (both apps)

Top to bottom (mockup C):

1. **Title**: breadcrumbs, the project's name, the product (model) name, the status tag and the
   quote-response tag as today, the **messages button** first in the actions (the codebase rule:
   every Object Page has one; here it carries this page's own call failures), then the side's title
   actions (below).
2. **Progress bar**, in the title area. Six steps, each an icon in a circle over its label and date:

   | Step | Icon (the SAP icons `ProjectTimeline` already uses) |
   |---|---|
   | Sent | `paper-plane` |
   | Review | `inspection` |
   | Quoted | `sales-quote` |
   | Ordered | `sales-order` |
   | Delivered | `shipping-status` |
   | Invoiced | `receipt` |

   Done steps: filled in the positive colour, white icon, joined by a positive line. Current step:
   the list background with a ring and a soft halo, and under its label, instead of a date, the
   side's "next" text in the ring's colour. Upcoming steps: neutral. All colours are theme variables.
   A slow pulse on the current ring only under `prefers-reduced-motion: no-preference`. A reached
   step is a button (keyboard, focus ring, accessible name "Review, 29 Oct"); the bar keeps a text
   alternative like home's `PORTAL_HOME_JOURNEY_ARIA`.

   **The ring is whose move, seen from the reader's side.** Critical = the reader's move; Negative =
   declined; neutral = a draft nobody sent; Informative = the other side's move.

   | `next` | Portal (client) | Staff |
   |---|---|---|
   | `finish` (draft) | neutral | neutral |
   | `review` | Informative | **Critical** |
   | `changes` | **Critical** | Informative |
   | `answer` | **Critical** | Informative |
   | `awaitOrder` | Informative | **Critical** |
   | `delivery`, `invoice` | Informative | Informative |
   | `declined` | Negative | Negative |

   Staff never see a client's draft (`internalVisible`), so `finish` is portal-only in practice.
3. **Configuration line**: a card, one row: icon, "Configuration", a summary (the batch quantities,
   then up to three filled values of the first visible fields, as the form shows them), and a link
   whose weight follows whose work the configuration is:
   - Portal: draft → Emphasized **Continue configuring**; `changes` → Emphasized **Make the changes**;
     otherwise a plain **Open**.
   - Staff: `submitted`/`in_review` (`review`) → Emphasized **Review the request**; otherwise **Open**.
4. **Timeline in chapters**: the shared `ProjectTimeline` with chapters on (below), for the reader's
   side as today (staff keep the internal-only toggle and see internal notes). The comment box stays
   at the end.
5. **What comes next**: after the comment box, the steps not reached yet, faded, no entries. The
   first carries one sentence on what happens next (per side); the rest are their names. Hidden when
   `next` is `done` or `declined`.

No footer bar on the project page.

### Actions, per side

Portal (client):

| Action | Shown when | Where |
|---|---|---|
| Continue configuring / Make the changes / Open | always | configuration line |
| Accept quote, Decline (optional note, `promptNote`, as today) | buyer, `quoted`, unanswered | the Quoted chapter's latest `quoted` entry |
| Withdraw | buyer, `submitted` | the Sent chapter's latest `submitted`/`resubmitted` entry |
| Delete (confirm, as today) | buyer, `draft` | title actions |
| Submit / Resubmit | as today | configuration page footer, unchanged |

The quote's figures on its entry (total, validity, Preview PDF) come from `projects.quotation` when it
answers; if SAP is down the entry still shows the buttons and says the quotation could not be read
(`PORTAL_QUOTE_UNAVAILABLE`). The quotation's line table stays in the configuration page's Prices.
Viewers see the page without any of these, as today.

Staff:

| Action | Where |
|---|---|
| Review the request / Open | configuration line |
| Reassign, Attach (as today's header) | project page title actions |
| Open quotation (when one exists here, as today) | project page title actions |
| Accept, Send back, Decline, Create/Update quote (`ProcessFooter`) | **configuration page footer, unchanged** — staff decide while looking at the configuration, its costs and candidates |
| Sync, Copy, the cost rail toggle, Retry | configuration page, unchanged |

The assignee shows in the staff project page's title as it does today.

## Chapters

A chapter is a journey step. Every timeline entry (event or SAP document) belongs to exactly one,
decided by walking the entries **oldest first** with a running chapter that **only moves forward**:

- Milestones move it to their step: `submitted` → Sent, `accepted` → Review, `quoted` and an SAP
  **Quotations** document → Quoted, **Orders** → Ordered, **DeliveryNotes** → Delivered,
  **Invoices** → Invoiced. A milestone for a step behind the running one changes nothing.
- Everything else (comments, files, `returned`, `resubmitted`, `revised`, `withdrawn`, `declined`,
  `quote_accepted`, `quote_declined`, `document_sent`, `created`, staff's `assigned`) stays in the
  running chapter.
- Entries before the first milestone are in the first chapter.

So rework after *returned* stays in Review (the bar sits on Review meanwhile); a withdraw and re-send
stays in Sent; a declined quote and its re-quote stay in Quoted (the bar moves back to Review then,
but a chapter never repeats). Each chapter appears at most once and the entries stay in time order.

**Same-day documents (my call).** An SAP document has a day, not a time, and `ProjectTimeline` sorts
it at the start of that day — before the same day's `submitted`/`accepted`/`quoted`, which would make
a same-day turnaround jump straight to Quoted and drop Sent and Review. When chapters are on, a
document sorts **after the last event of its day** instead. This changes only the chaptered
timeline (client requests); internal configurations have no timeline section.

Why forward-only: the bar's step can go back (`quote_declined` → `in_review`, `withdraw` → `draft`),
and following it would repeat a chapter or break time order (anti-goals).

Chapter titles: the step's name and its date range ("Review · 29 Oct – 3 Nov"). While the project is
a draft the first chapter reads **Draft** (portal only; staff never see drafts). The bar's date under
a done step is the date its chapter starts.

The SAP documents come from a separate live read that may fail; then their chapters are absent and
the timeline shows its existing "SAP unavailable" strip. The bar does not depend on it (`journeyOf`
reads the stored `sapStep`), so it may show Ordered while the Ordered chapter is missing. Accepted.

## The configuration page (both apps)

Today's page minus the timeline section; on the portal also minus the Accept/Decline/Withdraw
footers (they moved). Everything else stays: the title with the messages button, General, the
model's sections, prices/candidates/similar/cost rail as each app has them, the footers, the patch
queue and Retry. Breadcrumbs gain the project page: *list* / *project name* / Configuration.

**Portal: Submit and Resubmit go to the project page (my call).** After either succeeds, the toast
shows as today and the client lands on the project page, where Withdraw and the conversation now
live; the configuration page would have nothing left to act on.

**Staff: the request's extras (my call).** The subheader (client, assignee) and the strip with the
client's answer to the quote stay on the configuration page *and* show on the project page — staff
need both while quoting. **Reassign and Attach move to the project page only**: Attach without a
visible timeline would upload into a feed the reader cannot see. Each page's messages button carries
the failures of the calls made on that page.

URLs: portal `/<slug>/projects/<id>/configuration`, staff `/<slug>/configs/<id>/configuration`.
- Portal: a new project (`projects/new`) lands on the configuration page: a draft's work is configuring.
- Staff: `/configs/<id>` shows the project page for a client request and today's `ConfigProcessPage`
  for an internal configuration (decided by `configs.get`'s `request`, which the route's loader
  already fetches). `/configs/<id>/configuration` for an internal configuration redirects to
  `/configs/<id>`. Leaving the configuration page (`useConfigProcess`'s `left`) still goes where it
  goes today.

## Server

Both `projects.get` (portal) and `configs.get` (staff, client requests only) add
`journey: { step, next }` from `journeyOf` over the project's `status`, `quoteResponse` and `sapStep`.
`journeyOf` stays the one rule; where it lives so both routers import it is the builder's call
(today `apps/server/src/portal/journey.ts`, which the staff router may import). Nothing else changes.

Open check for the builder: whether `sapStep` is kept fresh outside the portal home (`home.progress`
writes it). If only the portal home refreshes it, a staff reader may see a stale step until a client
opens their home; the plan should say how staff get it fresh (e.g. the same refresh on `configs.get`
for a request, off the request path) or accept it.

## Shared code (`@confire/ui`)

- **`ProjectTimeline`** gains, optional and off by default (the internal configuration page passes
  none of it):
  - **Chapters**: entries grouped as above. UI5's native `TimelineGroupItem` (`groupName`,
    collapsible), all expanded, the group name being the chapter title — **my call**; it has no icon,
    the step icons live on the bar. If it cannot be scrolled to or styled acceptably, a plain heading
    between items is the fallback (the mockup's look).
  - **Scroll to a chapter** from outside (the bar's clicks).
  - **Entry actions**: the caller adds controls to a given entry (the portal's decision buttons and
    Withdraw).
  The chapter assignment is a pure function beside the component, with a small test (`bun run test:ui`).
- **The progress bar** moves to `@confire/ui` (as `Tile` did for the home), with icons, dates,
  clickable steps and the per-side ring. The portal home's small dot version keeps rendering exactly
  as today, whether it becomes a variant of the shared component or stays its own. It keeps
  `Journey`'s technique (one grid column per step, the line as two halves). Under ~30rem the labels
  and dates of non-current steps hide; the icons stay.
- **The project page itself**: one shared component (title area with the bar, configuration line,
  chaptered timeline, what-comes-next) taking the side, the project data, the texts, the actions
  and the timeline callbacks as props, the way `ProjectTimeline` already takes each app's calls. Each
  app's route is the thin part: its queries, mutations, invalidations and texts.
- **The `next` → ring colour table** above, keyed by side, lives with the bar.

## Texts

Shared texts (chapter "Draft", "Configuration", the "SAP unavailable" ones) go in `@confire/ui`'s
bundle. Side-specific texts go in each app's bundle (portal `portal.{en,es,eu}.properties`, the app's
own): the configuration line's buttons, the "next" text under the current step (portal reuses
`PORTAL_HOME_NEXT_*`; staff need their own: "Review it", "Waiting for {client}'s answer", …), and the
what-comes-next sentences. Step names: the portal's `PORTAL_HOME_STEP_*`, and the staff app needs the
same six.

## Left to the builder

- The route files (nested folders or non-nested `$id_.configuration.tsx`, as `configs/$id_.quote.tsx`
  already is), and keeping each project row's hover preload.
- Splitting today's portal `$id.tsx` and the staff route between the two pages (which queries move).
- Where `journeyOf` lives.
- Exact spacing and sizes, within Horizon and the mockup.

## Calls made in the brainstorm (check these)

- Chapters move forward only; a declined quote's re-quote stays in Quoted while the bar shows Review.
- First chapter reads "Draft" until sent (portal).
- Portal: Accept/Decline on the quotation's entry, Withdraw on the Sent chapter's entry, Delete in the title.
- Staff: Accept, Send back, Decline and quoting stay in the configuration page's footer.
- `TimelineGroupItem` for chapters, so chapter heads carry no icon (the mockup's did).
- A new portal project opens on the configuration page.
- The quotation's line table stays on the configuration page.
- With chapters on, an SAP document sorts after the last event of its day.
- Portal Submit/Resubmit land on the project page.
- Staff: client/assignee subheader and the quote-answer strip on both pages; Reassign and Attach on
  the project page only.
