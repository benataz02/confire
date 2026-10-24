# Notifications: bell, mail and per-user settings (design, 2026-10-22)

Decided through Q&A on 2026-10-21/22. **Supersedes** the portal redesign's §12, D22 and D27
(`2026-10-07-portal-redesign.md`): who hears of a project event is no longer an admin's tenant/company
setting plus a routing chain, but each user's own choice over a fixed eligibility rule. Calls marked
*(builder's call)* were made while writing this, not in the Q&A; challenge them freely.

## 1. Intent

Confire tells people about project events only by mail today, and admins decide for them (D27's
`off`/`creator`/`buyers`, D22's assignee → sales employee → fallback → admins). We want:

- an **in-app inbox**: the ShellBar's bell, in both the staff app and the portal;
- **two channels**, bell and mail, that **every user switches on and off per event** in their own
  Notifications page, a UI5 `Table` of every event they can receive;
- a **catalog of events** that is portal project events today and grows later (any kind of event, not only
  projects), without touching the delivery or the settings page.

The current notification code (`notify.ts`'s routing, the D27 settings, the D22 chain) is **rewritten from
scratch**, not extended. `notify.ts` stays as the project-events *producer*: it decides who is eligible
and hands the rest to the new system.

## 2. Goals, non-goals, anti-goals

**Goals**
- The bell lights up within **30 seconds** of an event (decided), in both apps.
- Every catalog event has a Bell and a Mail toggle per user; **everything is on by default** (decided).
- Adding an event later is a catalog entry, an i18n key and a producer call, with no schema change and
  no backfill.
- Eligibility is the narrow, decided rule in §4: the people a request actually involves.

**Non-goals**
- Real-time push (WebSocket/SSE/`LISTEN`), browser/desktop push, SMS, digests.
- Admin-set defaults, admin-forced notifications, per-project watch/mute.
- Account mail (verification, password reset, invitations). It stays outside this system and is never
  switchable.
- Internal-only configurations (no `portalCardCode`). Nothing about them notifies anyone, as today.

**Anti-goals** (a failure even if it "works")
- A bell entry or mail that reveals an internal note, internal file, a client's draft, or another
  company's project.
- Any tenant's entries showing under another tenant's path; a forged `x-tenant` reading someone's bell.
- A notification on a request's critical path: a failed insert or send must never fail the action.
- A user who cannot turn something off.

## 3. Decisions from the Q&A

1. In-app notifications next to mail. `notify.ts` feeds the new system.
2. Freshness: **30 s**. So it's **polling**, not push.
3. Channels: **bell** and **mail**, toggled **per user, per event**, in a **UI5 `Table`** listing every
   event the user can receive.
4. Catalog: portal events now, **any kind later**.
5. Staff side: **only the assignee** hears of a request's activity.
6. "**Submitted, not yet assigned**" is its own event: any staff member may switch it on.
7. "**Assigned to you**" is its own event.
8. Staff can **change a request's assignee**.
9. Client side: **only the project's creator** hears of it.
10. Defaults: **everything on**.
11. Bell items have a **close button**, in UI5's `NotificationList`.

## 4. The catalog and who is eligible

A **type** is one row in the user's settings table. The catalog is code, a plain array in
`apps/server/src/notifications.ts`:

```ts
type NotificationType = {
  id: string;                    // stable, stored in rows: "request.submitted"
  audience: "staff" | "client";  // which app's settings page lists it
  group: string;                 // the settings table's group row: "portal"
};
```

Labels are **not** in the catalog: each SPA translates `NOTIF_<ID>` (label) and `NOTIF_<ID>_DESC`
(one-line description), and the bell's text per type (§7). Ids are namespaced so a later non-project
event (`masterdata.sync_failed`, say) slots in without collision. Staff ids say *request* and client ids
say *project*, because those are the words each side's UI already uses (Portal → Requests vs the portal's
Projects).

| id | Audience | Fires on | Eligible recipient |
|---|---|---|---|
| `request.submitted` | staff | `submitted` | **every staff member** of the tenant (the request has no assignee yet) |
| `request.assigned` | staff | new `assigned` event (§6) | the new assignee |
| `request.resubmitted` | staff | `resubmitted` | the assignee |
| `request.comment` | staff | a client's `comment` | the assignee |
| `request.file` | staff | a client's `file` | the assignee |
| `request.quote_accepted` | staff | `quote_accepted` | the assignee |
| `request.quote_declined` | staff | `quote_declined` | the assignee |
| `client.onboarded` | staff | onboarding submit (§5.4 step 6, today's `notifyOnboarded`) | the inviter |
| `project.accepted` | client | `accepted` | the project's creator |
| `project.returned` | client | `returned` | the creator |
| `project.declined` | client | `declined` | the creator |
| `project.quoted` | client | `quoted` | the creator |
| `project.comment` | client | staff `comment` with `external` visibility | the creator |
| `project.file` | client | staff `file` with `external` visibility | the creator |

Rules that apply to every row:

- **No assignee, then the opt-in audience** *(builder's call)*. A staff-side event on a request with no
  assignee goes to **every staff member who has that type on**. `request.submitted` is the case the Q&A
  named: a first submit never has an assignee. The same rule covers a client comment on a request nobody
  has accepted yet, and a resubmit after a send-back that came straight from `submitted`. Without it, those
  reach nobody, where today they reach the D22 fallback.
- **Still there at send time.** The assignee and inviter must still be staff of the tenant (a `member`
  row whose role is not in `EXTERNAL_ROLES`). The creator must still hold a seat at the project's company
  (`member.cardCode = project.portalCardCode`, an external role). Anyone who has left gets nothing. This
  matches today. **An assignee who has left counts as no assignee** *(builder's call)*: the event falls to
  the opt-in audience above, so a request is never silent. (`assigneeId` has no foreign key and nothing
  clears it.)
- **Never the actor** *(builder's call)*. Whoever caused the event is dropped from the recipients: a staff
  member who reassigns a request to themselves, or who accepts it (accept makes them the assignee).
- **Kept from today:** an `internal`-visibility event notifies nobody. A client's draft is private, so
  its comments and files reach no one at the supplier. `revised` never notifies on its own: its
  transition's mail lists the revision, and the bell shows only the transition. `withdrawn` and `created`
  are not in the catalog.

## 5. Preferences

**Default on; store only the switch-offs.** A row in `notification_optout` means "this user, in this
tenant, does not want this type on this channel". Toggling back on deletes the row. A type added to the
catalog later is therefore on for everyone immediately, with no backfill. A row whose type has since left
the catalog is ignored.

Preferences are **per tenant**, like everything under the path. A staff member of two workspaces, or a
client with seats at two suppliers, sets each one separately and sees two separate bells.

## 6. Reassigning a request

Today `assigneeId` is set only by `accept` (`project-lifecycle.ts`, `step()`), to the acceptor.

- **`assign()` in `project-lifecycle.ts`.** It stays the only writer of project events, and `assigned` is
  one. Staff only (`actor.side === "internal"`). It locks the row, checks it is a portal request the actor
  may see (`fenced`), and accepts any status but `draft`. The target must be staff of the tenant, else
  `BAD_REQUEST`. Assigning the current assignee is a no-op. In one transaction it writes `assigneeId` and
  an `assigned` event: `visibility: "internal"`, payload `{ assigneeId, assigneeName }` (name snapshotted,
  so the timeline needs no join). After commit, `notifyInBackground`.
- **`accept` stops overwriting** *(builder's call)*: it sets `assigneeId` only when there is none
  (`row.assigneeId ?? actor.userId`), so a request reassigned to Bob before anyone accepted stays Bob's.
- `PROJECT_EVENT_KINDS` gains `assigned`. It is a `text` column, so there is no migration for that. Add
  the payload to `ProjectEventPayload`, and an entry in `@confire/ui/timeline` ("Assigned to {name}").
- **API:** `requests.assign({ projectId, userId })` (`userProcedure`: any staff member may reassign) and a
  list of assignable staff (id, name, email) for the picker.
- **UI:** a *Reassign* button by the "Assigned to …" line in `ConfigProcessPage.tsx`'s request header. It
  opens a UI5 `SelectDialog` of staff (search on name/email). The page updates from the response, as
  every other request action does.

## 7. Delivery

```
project-lifecycle.ts ──after commit──▶ notify.ts (producer: event → type, eligible people, params, path, mail)
onboarding submit   ──────────────────▶        │
                                               ▼
                               notifications.ts deliver()
                               ├─ one query: opt-outs for (tenant, type, recipients)
                               ├─ bell: one multi-row INSERT into notification
                               └─ mail: sendMails(…, key)   (existing mailer, templates)
```

**`apps/server/src/notifications.ts`** is the only writer of `notification` and `notification_optout`,
imported by both processes (the `portal/members.ts` pattern). It holds the catalog, `deliver()`, and the
read/write helpers the two routers call.

```ts
deliver(n: {
  tenantId: string; type: string; to: Person[];          // Person = { userId, email, name }
  params: NotificationParams; path: string;               // what the bell row stores (§8)
  mail: (to: Person) => Mail; mailKey: string;            // the existing templates, built per recipient
}): Promise<SendResult>
```

The bell insert and the mail are independent. A failed insert is logged and the mail still goes, and the
reverse. Mail failures come back as `SendResult` for the producer to record, as today
(`config_project_event.mailError`).

**`notify.ts`, rewritten.** It keeps its entry points (`notifyInBackground`, `notifyOnboarded`,
`notificationsSettled`), so `project-lifecycle.ts` and onboarding don't change. It keeps the
`background()` in-flight set and the "never throws, never awaited" contract. It keeps the mail templates
(`clientProjectMail` with tenant branding from `<slug>@`, `staffRequestMail` as Confire's from
`notify@`) and adds staff copy for `assigned`. Everything else goes: `CLIENT`/`STAFF` maps,
`clientRecipients` modes, `staffRecipients`' chain, `salesEmployeeEmail`, which takes away the live B1
call on every staff mail.

**Polling.** Each SPA polls `unreadCount` with TanStack Query (`refetchInterval: 30_000`,
`refetchOnWindowFocus`). The list is fetched when the popover opens. `// ponytail: polling; push over
LISTEN/NOTIFY + SSE if 30 s stops being enough`.

## 8. Data model

New schema file `packages/db/src/schema/notifications.ts`, re-exported from the schema index, shipped as a
migration (`bun run db:generate`).

```
notification
  id          uuid pk default random
  tenant_id   text not null
  user_id     text not null → user.id on delete cascade
  type        text not null              -- a catalog id
  params      jsonb not null             -- the bell's text inputs, snapshotted (see below)
  path        text not null              -- tenant-relative path in the recipient's app
  created_at  timestamptz not null default now()
  read_at     timestamptz null
  index (user_id, tenant_id, created_at desc)

notification_optout
  user_id     text not null → user.id on delete cascade
  tenant_id   text not null
  type        text not null
  channel     text not null              -- 'bell' | 'mail'
  primary key (user_id, tenant_id, type, channel)
```

- **The row carries its own text inputs, not a foreign key to the event.** That is what lets a non-project
  event live in the same table later. `params` is a small flat object: `projectName`, `actorName`,
  `companyName`, `note` (excerpt), `docNum`, whatever the type's text needs. It is snapshotted like a mail,
  so a renamed project does not rewrite old entries. The SPA renders it through `NOTIF_<ID>_TITLE` in the
  **reader's** language. The mail stays English, as today.
- **`path`** is in the recipient's app, decided by the producer: staff `/configs/<id>`, client
  `/projects/<id>`, `client.onboarded` `/b1/BusinessPartners/<cardCode>`. The SPA navigates with
  `useEntityNav`, so it stays under `/$slug`.
- `// ponytail: no retention; delete read rows older than N days when the table hurts`.

## 9. API

The same six procedures in both routers, each a thin wrapper over `notifications.ts`. Every one filters on
**(the request's tenant, the session's user)**, so a forged `x-tenant` reaches only a tenant the user
belongs to (the membership join), and only their own rows. Staff: `userProcedure`. Portal:
`portalMemberProcedure`.

| Procedure | Returns / does |
|---|---|
| `notifications.unreadCount` | `{ count }` |
| `notifications.list` | newest 50: `{ id, type, params, path, createdAt, read }` |
| `notifications.markRead({ ids? })` | the given ids, or all when absent; another user's id is a silent no-op |
| `notifications.dismiss({ id })` | deletes the row (the close button); another user's id is a silent no-op |
| `notifications.settings` | the catalog for the caller's audience, each `{ id, group, bell, mail }` |
| `notifications.setPreference({ type, channel, enabled })` | `BAD_REQUEST` for a type outside the caller's audience |

## 10. UI (UI5 Web Components for React 2.27, checked with the UI5 MCP)

**Bell, both shells** (`AppShell.tsx`, `PortalShell.tsx`, which needs `showNotifications` added):
- `ShellBar notificationsCount` = the unread count as a string, or unset at 0, so no badge shows.
- `onNotificationsClick` → `e.detail.targetRef` opens a **`ResponsivePopover`**. Header: title plus
  *Mark all as read* (`Button`, transparent). Body: **`NotificationList`** (`noDataText`) of
  **`NotificationListItem`**: `titleText` from `NOTIF_<ID>_TITLE`, the note excerpt as content, `read`
  (bold when unread), `footnotes` with the project/company name and a relative time, `state` per type
  where it helps (declined `Negative`, quoted `Positive`). Footer: *Notification settings* (navigates to
  the page below).
- Clicking an item (`NotificationList onItemClick`) marks it read, closes the popover and navigates to
  its `path`.
- Every item has a **close button** (`showClose`, decided). `NotificationList onItemClose` **dismisses**
  it: the row is deleted *(builder's call: Fiori's close removes a notification; it does not mark it
  read)*, and the list and the unread count update optimistically.

**Notifications page, both apps**, at `/<slug>/notifications`, for every user (not under `_admin`). It's
reached from a new *Notifications* item in each shell's `UserMenu` and from the popover footer.
- A UI5 **`Table`**: `TableHeaderRow` with *Event* | *Bell* | *Mail*; a **`TableGroupRow`** per catalog
  `group` (only "Portal" today); one `TableRow` per type with `TableCell`s for label + description and two
  **`Switch`**es (`accessibleName` "Bell: {event}" / "Mail: {event}").
- **A switch saves on change** *(builder's call)*: optimistic update, revert with a toast on error, no Save
  button, as Fiori settings switches behave.

The popover and the table are presentational components in `@confire/ui/notifications/`, taking data,
callbacks and `getText`. Each app wires its own oRPC queries and i18n bundle, as `ProjectTimeline` does.

## 11. What is removed

- `notify.ts` routing as listed in §7.
- `portal_company.notify` (column dropped in the migration). `PortalSettings.notify` and
  `notifyFallback` (types removed; the same migration strips the keys from `portal_settings.settings`
  with `settings - 'notify' - 'notifyFallback'`, appended to the generated SQL). **No carry-over**
  (decided): an existing D27 `off` is dropped, not turned into opt-outs, and those clients start on the
  new default, everything on.
- `NOTIFY_EVENTS`, `NOTIFY_MODES`, `NotifyEvent`, `NotifyMode`, `PortalNotify` (`@confire/db`).
- `orpc/routers/portal.ts`: `portalCompanies.setNotify`, the `notify` block of the company read, and the
  `notify`/`notifyFallback` fields of the general settings read and save (`NotifyZ`).
- `apps/app/src/components/settings/PortalMail.tsx` and its card in `routes/$slug/_admin/settings.tsx`.
  The notify section of `BpPortal.tsx`. The `ADMIN_NOTIFY_*` and `ADMIN_EMAIL_NOTIFICATIONS*` i18n keys.
- `apps/server/test/portal-notify.test.ts`, rewritten for the rules in §4.
- Docs: mark D22, D27 and §12 of the portal spec superseded by this file. Rewrite CLAUDE.md's "Who hears of
  what is `notify.ts`" paragraph.

## 12. Tests

Server tests with the existing harness (`devOutbox`, `notificationsSettled()`):
- an assigned request's client comment: assignee gets a bell row and a mail, other staff nothing;
- a first submit: every staff member, minus one who switched off bell only (mail, no row) and one who
  switched off both (nothing);
- a staff quote: only the creator; a creator who has left the company: nothing;
- the actor never: self-reassign, and accept, produce no `request.assigned`;
- internal comment and client-draft comment: nothing;
- `assign()`: refused on a draft, refused for a non-staff target, writes `assigned` and notifies the new
  assignee; accept keeps an existing assignee;
- the fence: `markRead` and `dismiss` on another user's id change nothing; a user sees only the path tenant's rows;
  `setPreference` refuses another audience's type.

## 13. Left to the builder

Exact wording of every i18n key (English base, laid over the existing locales); the `params` fields per
type; per-type `state`/icon in the bell; whether the bell list needs paging past 50; the assignable-staff
procedure's name; where the shared components sit inside `@confire/ui`; and the order of the work.
