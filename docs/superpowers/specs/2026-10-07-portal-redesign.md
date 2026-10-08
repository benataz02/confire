# Portal redesign: a separate app for external users

**Date:** 2026-10-07
**Status:** Spec agreed through Q&A. Not built yet; §16 lists what must be checked against a live
B1 and Better Auth before the matching phase starts.
**Replaces:** the current portal (`role = "client"` members inside the manufacturer's org,
`portal_client`, `orpc/routers/portal.ts`, `apps/web/src/routes/_authed/portal/*`).

## 1. Goal

External users (the manufacturer's customers and prospects) get their own app on their own host
and their own server process, so external traffic never shares an event loop with internal users.
In that app they can:

- onboard in one of two ways: **invited** to an existing B1 business partner, or by **self-registering**
  with a business-partner form that becomes a B1 **lead** once an internal user approves it;
- create projects (one configuration each), submit them as requests, and follow each one on a
  **Timeline** that shows every event, comment and file, and every SAP document the project produced
  (quotation → order → delivery → invoice, each printable);
- browse their own SAP documents (quotations, sales orders, deliveries, invoices) in a List Report /
  Object Page built for external users, and print them.

Internal users accept requests, then quote them, send them back for changes, or decline them.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Deployment | A separate SPA (`apps/portal`) and a separate server process, both from this repo and image, sharing Postgres. |
| D2 | Domain | One purchased domain (`confire.ai` or similar), split into **sibling zones**: internal on `app.confire.ai` + `<slug>.app.confire.ai`, portal on `portal.confire.ai` + `<slug>.portal.confire.ai`. `confire.ai` itself is the marketing site. |
| D3 | Identity | **One shared `user` table.** The same email can be internal at supplier A and external at supplier B, but never both inside the same tenant. |
| D4 | Customer org | A customer company is a Better Auth **organization in the portal instance**: one per tenant × CardCode. The company owner can invite colleagues. |
| D5 | Auto-join | A verified sign-in whose email domain is registered to a company on this tenant **joins that company as `viewer`** (the lowest role). Free-mail domains are blocked. A Microsoft email counts as verified only on the `xms_edov` claim (§4.4). |
| D6 | Sign-in | Email + password (with verification), Google, Microsoft. |
| D7 | Lead timing | Self-registration creates a **pending application in Confire**. The B1 lead (`CardType = cLid`) is created **only when an internal user approves it**. |
| D8 | SAP load | Portal document reads stay **live, with no rate limit**. `ponytail:` see §13. |
| D9 | Project | **One project = one configuration** (`config_project`, as today). |
| D10 | Internal outcomes | Accept (in review), Quote, Send back for changes, Decline (final). The quotation and its linked orders, deliveries and invoices, with their PDFs, appear on the timeline. |
| D11 | Internal edits | Internal users may change entries and batches before quoting. The timeline records each change **with a diff**, and the client sees it. |
| D12 | Timeline extras | Comments both ways (with internal-only notes), file attachments, email notifications. |
| D13 | Mail | One transactional provider (Resend or Postmark) behind a `Mailer` seam. Sender `notify@mail.<domain>`, the tenant's name as display name, the tenant's sales address as `Reply-To`. Because a mailer now exists, **email verification is switched on for internal sign-ups too** (this removes the `ponytail` in `signup.tsx`). |
| D14 | Files | Attachments in **Postgres `bytea`** (`project_file`), with a per-file size cap. Upload and download are plain Hono routes, not oRPC: the RPC body cap is 2 MB. `ponytail:` move to S3-compatible storage (Bun's `S3Client`) when DB size or backups hurt. |
| D15 | Prices | **Per published model**: `portalPricing = "indicative"` (unit price and total per batch after calculate) or `"request"` (no numbers until quoted). The server omits the numbers, not the page. |
| D16 | Lead CardCode | A **B1 numbering series**: an admin picks the BP `Series` in portal settings, and the create payload sends `Series` and omits `CardCode`. |
| D17 | Onboarding form | Admin-picked `BusinessPartners` header fields from metadata (UDFs included, each required or optional), plus **addresses** (bill-to and ship-to → `BPAddresses`) and a **contact person** (the applicant → `ContactEmployees`). |
| D18 | UI code | **Extract `packages/ui`**: ListReport, ObjectPage, CFL, views and metadata merge, shared by `apps/web` and `apps/portal`. The portal declares its own external-user features. |
| D19 | Doc fields | **Admin-configurable** per entity (header and line fields, UDFs included), stored per tenant and enforced server-side as the schema (the existing `portalSchema` mechanism). A **hard denylist** in code (cost, gross profit, margins, purchase prices) that no setting can expose. |
| D20 | v1 scope | Portal home overview; online quote acceptance (accept or decline the B1 quotation: a timeline event plus an internal notification, and internal staff create the order); tenant branding (logo, name, accent colour on the portal and in emails). **Not in v1:** multiple languages. |
| D21 | Models | **Every published model** (`config_model.portal = true`) is available to every company on the tenant. |
| D22 | Notify | Internal notifications go to the **BP's B1 sales employee** (`SalesPersonCode` → `SalesPersons` email → Confire user). If that resolves to nothing, they go to a tenant fallback list. |
| D23 | Old data | **Drop everything.** No migration script. |
| D24 | Colleagues | A company owner may invite **only addresses on the company's registered domains**. Any other address needs an internal admin. |

## 3. Hosts, cookies, processes, code layout

```
confire.ai                      marketing
app.confire.ai                  internal apex: login / signup / onboarding / lobby       ┐ confire-server
<slug>.app.confire.ai           internal app                                             ┘ (existing)
portal.confire.ai               portal apex: login / signup / supplier lobby             ┐ confire-portal
<slug>.portal.confire.ai        portal app for one supplier (tenant)                     ┘ (new process)
```

- **Cookies stay in their zone.** Internal: `crossSubDomainCookies.domain = ".app.confire.ai"`.
  Portal: `".portal.confire.ai"`. Neither zone's session cookie is ever sent to the other. The
  internal change is configuration only: `APP_BASE_DOMAIN=app.confire.ai`.
- **Auth lives on each apex**, exactly the pattern the internal app already uses: tenant pages
  hard-redirect to `portal.confire.ai/login?redirect=…&t=<slug>`. The `t` parameter only picks the
  branding to show; nothing trusts it. A static `baseURL` per instance means **one** Google callback
  and **one** Microsoft callback per zone, and no wildcard redirect URIs, which providers don't allow
  anyway.
- **`tenant.ts` stays the only place a host is parsed.** It already takes `baseDomain` as a
  parameter; the portal process passes `PORTAL_BASE_DOMAIN`. Dev: `app.lvh.me` / `portal.lvh.me`
  (`*.lvh.me` resolves at any depth). The tenant is still the internal `organization` row, looked up
  by slug.
- **One Caddy, two wildcard sites** (`*.app.{$DOMAIN}`, `*.portal.{$DOMAIN}`) plus the two apexes,
  each proxying to its own upstream. Both certificates are wildcards, so both use the DNS challenge
  with one provider token. This replaces the `tls internal` `ponytail` in the `Caddyfile`.

**Code layout**

| Path | What |
|---|---|
| `apps/server/src/index.ts` | internal entrypoint (unchanged role) |
| `apps/server/src/portal/index.ts` | **portal entrypoint**: portal auth instance, portal router, file routes, serves `apps/portal/dist` |
| `apps/server/src/portal/auth.ts`, `portal/orpc/*` | portal Better Auth instance, procedure builders, routers |
| `apps/portal` | portal SPA (Vite + TanStack Router + UI5), own `index.html`, own route tree |
| `packages/ui` | extracted from `apps/web/src/shared/`: list-report, object-page, cfl, views, metadata, format, validation |

The portal entrypoint lives inside `apps/server` because it imports the same modules
(`calculateProject`, `lookups`, `b1`, `entity-read`, `doc-chain`, `print`, `list-sql`). It is a second
`CMD` on the same image, not a second package. That keeps CLAUDE.md's "workspace packages must be
direct dependencies" rule out of the picture for server code.

## 4. Better Auth design

### 4.1 Two instances, one identity

| | Internal instance (exists) | Portal instance (new) |
|---|---|---|
| Process | `confire-server` | `confire-portal` |
| `user`, `account`, `verification` | shared | shared (same tables) |
| `session` | `session` | **`portal_session`** (`session.modelName`) |
| Cookie | prefix `better-auth`, `.app.<domain>` | prefix `confire-portal`, `.portal.<domain>` |
| `organization` plugin | manufacturer = org; `member` = employees only (the `client` role is gone) | **customer company** = org → `portal_company`, `portal_member`, `portal_invitation` |
| Email + password | `requireEmailVerification: true` (D13) | `requireEmailVerification: true` |
| Social | Google, Microsoft | Google, Microsoft (same OAuth clients, second callback URL) |
| `organizationLimit` | 1 (unchanged) | unlimited across tenants; one company per user **per tenant** (§4.2) |
| Plugins | `organization` | `organization` (+ access control), `captcha` (Turnstile) |

Separate session tables mean a portal session can never authenticate an internal request, even
when replayed by hand. Users and linked accounts are shared on purpose: one password and one Google
link per person. The cost is that a password reset on either side changes it for both.

Schema files: the portal instance gets its own `better-auth-generate` target writing
`packages/db/src/schema/portal-auth.ts`, which `schema/index.ts` re-exports. Its output must contain
only `portal_*` tables. The shared `user`, `account` and `verification` stay owned by `auth.ts`.

### 4.2 Portal organization = customer company

- `schema.organization.additionalFields`: `tenantId`, `cardCode`, `cardType` (`cCustomer` | `cLid`),
  all `input: false`, so only the server writes them. There is a **unique index on (`tenantId`,
  `cardCode`)**.

  `ponytail: the composite unique index is hand-added to the generated portal-auth.ts; re-add it
  after every regenerate. Move it into a non-generated schema file if that ever bites.`
- `allowUserToCreateOrganization: false`. Companies are created server-side only, on an internal
  invite or when an application is approved.
- Roles via `createAccessControl`:

  | Role | Can |
  |---|---|
  | `owner` | everything below + invite colleagues on company domains, change roles, remove members |
  | `buyer` | create, edit, submit and withdraw projects; comment; upload; accept or decline quotes |
  | `viewer` | read projects, timeline and documents; print; comment |

- `portal_company_domain (tenantId, domain, companyId)`, **primary key (tenantId, domain)**. This is
  the auto-join index, and the key is what stops one domain mapping to two companies. Domains are
  written **only by internal users**: on approval (the applicant's verified email domain) or from the
  Companies page. A company cannot claim a domain itself, because a lead that registered a competitor's
  domain would capture that competitor's staff.
- `organizationHooks.beforeAddMember` enforces "one company per user per tenant" and "not an
  internal member of the same tenant". The internal invite acceptance gets the mirror check.
- `organizationHooks.beforeCreateInvitation`: if the inviter is a portal owner, the email domain must
  be one of the company's domains (D24). Internal admins create invitations through a server call,
  which skips this rule.
- `requireEmailVerificationOnInvitation: true`.
- **The tenant boundary is still host → tenant → membership join**, as in `orpc/base.ts` today.
  `session.activeOrganizationId` is never trusted for authorization.

### 4.3 Portal procedure builders

| Builder | Who | Context |
|---|---|---|
| `portalSessionProcedure` | signed in on the portal, tenant resolved from the host, maybe no company yet | `tenantId`, `user` |
| `portalMemberProcedure` | `portal_member ⋈ portal_company` with `company.tenantId = host tenant` | + `companyId`, `cardCode`, `cardName`, `cardType`, `role` |
| `portalBuyerProcedure` | member with role `owner` or `buyer` | same |
| `portalOwnerProcedure` | member with role `owner` | same |

An internal member of the host tenant is refused by every portal builder ("you work for this
supplier, use `<slug>.app.<domain>`").

### 4.4 Auto-join (D5)

Auto-join runs **on the tenant host**, not in an auth hook, because the auth endpoints are on the
apex, where there is no tenant. On a tenant page, `portal.me` returns `onboarding` for a signed-in
user with no company there. `portal.onboarding.join` then:

1. requires `user.emailVerified`;
2. rejects free-mail domains (a list in code);
3. looks up `portal_company_domain (hostTenant, domain(user.email))`;
4. calls `auth.api.addMember({ role: "viewer" })` and writes a `joined` audit event.

If nothing matches, the user sees the application form (§5.2) when self-registration is enabled
for the tenant, and an "ask your supplier for an invite" page when it is not.

Microsoft: in multi-tenant Entra apps the `email` claim is not guaranteed verified. The Microsoft
provider's `mapProfileToUser` sets `emailVerified` from the optional `xms_edov` claim, which the
Entra app registration has to emit. Google's `email_verified` is used as-is.

### 4.5 Other plugins

- `captcha` with `provider: "cloudflare-turnstile"` on `/sign-up/email`, `/sign-in/email` and
  `/request-password-reset`.
- `emailVerification.sendVerificationEmail` and `sendResetPassword` go through `Mailer`, branded
  with the tenant named by `t`, or Confire when there isn't one.

## 5. Onboarding flows

### 5.1 Internal invite to an existing CardCode

1. An internal admin or owner opens **Portal → Companies → Invite**, picks a BP (value help over
   `BusinessPartners`, customers **and** leads; the old `CardType === "cCustomer"` check is relaxed)
   and enters an email.
2. The server re-reads the BP from SAP, finds or creates `portal_company` for (tenant, CardCode),
   optionally registers the email's domain (a checkbox, never for free-mail), and creates an
   `owner` invitation. `sendInvitationEmail` mails
   `https://<slug>.portal.<domain>/accept/<invitationId>`.
3. The invitee signs in or signs up (D6) on the apex, comes back, and accepts. They become the
   company owner.

### 5.2 Self-registration (tenant setting `selfRegistration`, default off)

1. The user opens `<slug>.portal.<domain>` (typically linked from the manufacturer's website), signs
   up on the apex with the captcha check and verification, and returns.
2. If the verified domain matches, they auto-join (§4.4) and are done.
3. Otherwise they fill in the **onboarding form**:
   - the BP header fields from portal settings, rendered by the ObjectPage shell from
     `BusinessPartners` metadata, so labels, types, enum options and `MaxLength` come from B1;
   - bill-to and ship-to addresses;
   - the contact person, pre-filled from the user.

   This writes `portal_application (pending)`, and the user sees a "we're reviewing your application" page.
4. An internal user opens **Portal → Applications** and can:
   - **Approve as new lead.** POST `BusinessPartners` with `CardType = cLid`, `Series` (D16), the
     header fields, `BPAddresses` and `ContactEmployees`. The write is idempotent through
     `U_CF_Key` on OCRD (SHA-256 over `tenant|application`), check-then-create exactly like quotations,
     and a missing UDF **refuses to run**. Then create the company and the owner membership, register
     the email domain unless it is free-mail, and email the applicant.
   - **Approve onto an existing BP.** The applicant turns out to be an existing customer, so bind to
     that CardCode instead of creating a duplicate lead.
   - **Reject** with a reason, emailed to the applicant. The application stays as history.
5. A lead converted to a customer in B1 keeps its CardCode, so the binding survives. Only
   `cardType` is refreshed, read live when the company page loads.

## 6. Data model

New tables (all with `tenantId text` like the rest, no FK to `organization`):

| Table | Columns (key ones) | Notes |
|---|---|---|
| `portal_session` | Better Auth core | `session.modelName` |
| `portal_company` | BA org + `tenantId`, `cardCode`, `cardType` | unique (tenantId, cardCode) |
| `portal_member`, `portal_invitation` | BA org plugin | |
| `portal_company_domain` | `tenantId`, `domain`, `companyId`, `addedBy`, `addedAt` | PK (tenantId, domain) |
| `portal_application` | `id`, `tenantId`, `userId`, `status` (pending\|approved\|rejected), `form jsonb` ({header, addresses, contact}), `decidedBy`, `decidedAt`, `reason`, `companyId`, `cardCode` | one pending per (tenant, user) |
| `portal_settings` | `tenantId` PK, `settings jsonb` | one document loaded and saved whole (CLAUDE.md convention): `selfRegistration`, `onboarding: { fields: [{ key, required }], addresses, contact }`, `leadSeries`, `docFields: { [entity]: { header: [], lines: [] } }`, `branding: { displayName, accent, logoFileId }`, `notifyFallback: string[]`, `replyTo` |
| `config_project_event` | `id`, `tenantId`, `projectId`, `at`, `kind`, `actorUserId`, `actorSide` (internal\|external), `visibility` (external\|internal), `note`, `payload jsonb`, `mailError` | replaces `config_project.events` jsonb |
| `project_file` | `id`, `tenantId`, `projectId`, `eventId`, `name`, `mime`, `size`, `data bytea`, `uploadedBy`, `visibility` | D14; also holds the branding logo (`projectId` null) |

Changed:

- `config_project.status`: `draft | submitted | in_review | returned | declined | quoted`. Internal
  configurations use only `draft` and `quoted`.
- `config_project`: **add** `portalCompanyId` (nullable, indexed; the portal fence),
  `assigneeId`, `quoteResponse` (`accepted | declined | null`) and `quoteRespondedAt`.
  **Drop** `events` and `rejectionNote`, which now live in events. `source` stays.
- `config_model`: **add** `portalPricing` (`"indicative" | "request"`, default `"request"`).
- `member.role`: the `client` value disappears.
- **Removed:** `portal_client`.

`config_project_event.kind`: `created`, `submitted`, `withdrawn`, `accepted`, `revised` (payload =
diff), `returned`, `resubmitted`, `declined`, `quoted`, `quote_accepted`, `quote_declined`, `comment`,
`file`, `joined`.

## 7. Project lifecycle

```
                 submit                  accept
   draft ───────────────▶ submitted ─────────────▶ in_review ─── quote ───▶ quoted ──▶ accept / decline quote
     ▲   ◀── withdraw ───    │   │                   │   │                    │
     │                       │   └──── decline ──────┼───┴── decline ──▶ declined (final)
     │                       │ send back             │ send back
     └── edit, resubmit ── returned ◀────────────────┘
```

- Every arrow is one guarded `UPDATE` on `status` (and on `calculatedAt` for submit and resubmit,
  as today), written in the same transaction as its `config_project_event` row. The side that
  loses a race gets a clear error instead of a lost write.
- `withdraw` only from `submitted`. Once accepted, the client comments instead.
- `accept` sets `assigneeId`. The client sees "In review" and the assignee's name.
- **Internal edits (D11)** are allowed in `in_review` through the existing `configs.calculate`. When
  the project is a portal one, the handler diffs old and new `entries`/`batches` (and `tables`
  row counts) and writes a `revised` event that the client can see.
- `quote` is today's `createQuote` (dedup UDF, `b1DocEntry`), plus the event. The CardCode is the
  company's, lead or customer.
- **Quote response (D20):** on `quoted`, a buyer or owner accepts or declines with an optional
  note. That sets `quoteResponse` and writes the event, and the sales employee is notified. Nothing
  is written to SAP; internal staff create the order.
- Client-facing labels: Draft, Submitted, In review, Changes requested, Declined, Quoted
  (+ "Accepted" / "Declined by you").

## 8. Timeline

One merged, time-ordered feed per project:

- **Events** from `config_project_event`. The portal reads `visibility = 'external'` only; the SQL
  filter is the fence, and nothing is hidden by the page. Revisions render their diff, comments their
  text, files a download link.
- **SAP documents**: `documentChain(b1DocEntry)`, live (quotation → orders → deliveries → invoices),
  each entry linking to its portal Object Page and its PDF. `printDocument` is fenced by CardCode, as
  today. Before `quoted` there is no chain.
- Rendered with the UI5 `Timeline` component on the project Object Page, with a comment box and an
  upload button (buyer, owner and viewer can comment; buyer and owner can upload).

## 9. Portal app UI (`apps/portal`)

`NavigationLayout` + `ShellBar` + `SideNavigation`, the same chrome pattern as `AppShell.tsx`.
The ShellBar shows the tenant's logo and name (D20). The user menu has account, theme, density,
"switch supplier" (to the apex lobby) and sign out.

| Side nav | Route | Page |
|---|---|---|
| Home | `/` | overview cards: open requests by status, quotes awaiting your response, recent documents, open invoices |
| Projects | `/projects` | List Report over `portal.projects.rows`, with system views All / Drafts / In progress / Changes requested / Quoted; **New project** opens the model catalog |
| | `/projects/new` | published-model catalog (cards) → name → create |
| | `/projects/$id` | Object Page: header (status, model, assignee, actions), sections **Configuration** (configurator form or read-only summary), **Prices** (only for `indicative` models or once quoted), **Timeline** |
| Documents ▸ Quotations / Sales orders / Deliveries / Invoices | `/docs/$entity` | List Report over `portal.docs.rows`, columns from the tenant's `docFields` |
| | `/docs/$entity/$key` | Object Page, read-only, **Print** action, plus a "Project" link when the document belongs to one |
| Company (fixed item, owner only) | `/company` | members (invite on company domains, role, remove), registered domains (read-only), BP summary |

Not under `_authed`: `/accept/$invitationId`, `/onboarding` (join or application form, or a pending /
rejected page). On the apex: `/login`, `/signup`, `/forgot-password`, and `/` as the supplier lobby
(list of the user's companies across tenants → hard redirect).

Views: system views are code. External users may save **personal** views (`ui_view` rows with
their own `userId`). There are no shared views on the portal side.

## 10. Internal app changes (`apps/web`)

- **Side nav group "Portal"** (any member sees Requests; admins and owners see the rest):
  - **Requests**: List Report over portal projects, with system views New (submitted), Mine
    (in review, assignee = me), Changes requested, Declined, Quoted, Quote responses. It opens the
    existing configuration process page.
  - **Applications**: List Report over `portal_application`, and an Object Page showing the form as
    it will be posted, a "possible existing BPs" panel (search by name, email domain and tax ID), and
    the actions Approve as new lead / Approve onto existing BP / Reject.
  - **Companies**: List Report over `portal_company` with members, domains and invitations;
    **Invite** (§5.1); revoke member; add or remove domain.
- **ConfigProcessPage**, for portal projects: header actions Accept / Send back / Decline / Create
  quote by status; a Timeline section with comment box, internal-only toggle and upload.
- **Settings → Portal tab** (admins): self-registration on/off; onboarding form designer (pick
  `BusinessPartners` fields from metadata, mark required, toggle addresses and contact person);
  lead numbering series (value help over the BP series); document field pickers per entity (filtered
  by the hard denylist); branding (display name, accent, logo upload); notification fallback list and
  Reply-To.
- The current "Portal clients" card is removed.

## 11. API surface

**Portal server** (`portal/orpc/router.ts`):

| Namespace | Procedures | Builder |
|---|---|---|
| root | `me` (session + tenant + `member` / `onboarding` / `pending` state + branding) | session |
| `onboarding` | `join`, `apply`, `application`, `formSchema` | session |
| `company` | `get`, `members.list`, `members.invite`, `members.setRole`, `members.remove`, `domains.list` | member / owner |
| `models` | `list` (published, with `portalPricing`) | member |
| `projects` | `rows`, `get`, `create`, `update`, `remove`, `run`, `lookups`, `queryPage`, `submit`, `withdraw`, `resubmit`, `respondQuote` | member (read) / buyer (write) |
| `timeline` | `list`, `comment` | member |
| `docs` | `metadata`, `rows`, `one`, `print`, `chain` | member |
| `home` | `overview` | member |

The Hono routes `POST /files/:projectId` and `GET /files/:id` use the same session and fence, with
a size cap on the stream.

The **response mappers name their fields** as today. `toPortalModelDef` and `toPortalCandidate`
move here, and `toPortalCandidate` drops prices when the model's `portalPricing` is `"request"`.

**Internal server** additions: `requests.{rows, accept, sendBack, decline}`,
`timeline.{list, comment}` (with `visibility`), `applications.{rows, get, matches, approveNew,
approveExisting, reject}`, `portalCompanies.{rows, get, invite, removeMember, addDomain,
removeDomain}`, `portalSettings.{get, save}`. Settings and companies are `adminProcedure`; requests
and timeline are `userProcedure`.

## 12. Notifications

Sent after the transaction commits, through `Mailer`, and never on the request's critical path.
A failure is logged on the event row (`mailError`).

`ponytail: no retry queue — there is no job runner; add an outbox table when a lost mail matters.`

| Event | To |
|---|---|
| invitation, verification, password reset | the user |
| submitted, resubmitted, comment (external), file (external), quote response | the BP's sales employee (D22), else the fallback list |
| accepted, returned, declined, quoted, revised, comment (internal, external visibility) | every company member with role buyer or owner, plus the project creator |
| application submitted | the fallback list |
| application approved or rejected | the applicant |

Sales employee resolution: a live read of `BusinessPartners(CardCode).SalesPersonCode`, then that
`SalesPersons` row's email, matched against internal `member` emails of the tenant. Anything that
fails (agent down, no email, no match) falls back to the list.

## 13. SAP reads and writes

- **Reads are live, no limiter (D8).** Lists, object pages, chain walks, prints, the sales-employee
  lookup and the BP summary all go through the tenant agent.

  `ponytail: live and unlimited. Process separation isolates CPU and the event loop, not the agent or
  the Service Layer. Upgrade path: (1) a per-tenant concurrency cap and short TTL cache in front of
  portal reads; (2) a per-tenant document mirror in Postgres, the config_masterdata_row pattern.`
- **Document fields (D19):** `portalSchema(schema, docFields[entity] − DENYLIST)` replaces the
  `PORTAL_DOC` and `PORTAL_LINE` constants. `DocEntry`, `DocNum` and `DocumentLines` are always
  present; `CardCode` is never in the schema, and the fence clause is appended after compile, as
  today. The denylist is code (exact names and name patterns, for example `GrossProfit*`,
  `GrossBuyPrice`, `*Cost*`) and applies to the settings picker and to the server alike.
- **Writes:** the quotation (unchanged path) and the lead BP create (§5.2). `ENTITY_PROFILES` stays
  the rule for internal entity edits. The lead create is its own handler with its own field list,
  built from portal settings ∩ BP metadata, plus `CardType`, `Series`, `BPAddresses`,
  `ContactEmployees` and `U_CF_Key`.

## 14. What gets deleted

- Server: `orpc/routers/portal.ts` (its fence helpers move to the portal server),
  `portalClientsRouter`, `clientProcedure`, and the `client` line in `userProcedure`.
- DB: `portal_client`, and every `member` row with `role = "client"` (D23).
- Web: `routes/_authed/portal/*`, `routes/accept.tsx`, `components/portal/*`, `features/portal/*`,
  the `client` branches in `_authed.tsx` and `AppShell.tsx`, the "Portal clients" card in Settings,
  and the `portal` scope switches in `useFieldConstraints`, `useDetailView`, `PrintActions`,
  `cfl-provider` and `documents.tsx`. They come back as the portal app's own data layer over
  `packages/ui`.
- Scripts and tests: `seed-portal-client.ts` (replaced by `seed-portal-company.ts`) and
  `invites.test.ts` (replaced by portal onboarding tests).
- CLAUDE.md: the four-builders table and the portal mentions are rewritten when the code lands.

## 15. Build phases

Each phase ends type-checked per project, with its tests green, and is usable on its own.

| Phase | Content |
|---|---|
| P0 Foundations | Host split (`APP_BASE_DOMAIN=app.…`, `PORTAL_BASE_DOMAIN`), Caddy two-zone config, `Mailer` seam + internal email verification, **delete the old portal** (§14). |
| P1 `packages/ui` | Move `apps/web/src/shared/*` into `packages/ui` with a data-source seam replacing the `scope: "portal"` switches; `apps/web` behaves identically. |
| P2 Portal skeleton | Portal entrypoint, portal Better Auth instance (`portal_session`, org plugin mapping, access control, captcha), builders, `me`, apex login / signup / lobby, `apps/portal` shell with NavigationLayout and branding. |
| P3 Invites & companies | Internal Companies page + invite, accept page, company page (colleague invites on domains), domains, auto-join. |
| P4 Projects & lifecycle | Status migration, `config_project_event`, portal projects + configurator + pricing modes, internal Requests inbox + Accept / Send back / Decline, revisions with diff, Timeline (events + doc chain), comments. |
| P5 Documents | Portal List Report / Object Page for the four entities, `docFields` settings + denylist, print, project link. |
| P6 Self-registration | Portal settings form designer, onboarding form, applications, approval → lead create (Series, `U_CF_Key`, addresses, contact), approve onto existing BP. |
| P7 Files, mail, home | `project_file` + upload routes, notification routing (sales employee), quote response, home overview, logo upload. |

## 16. Verify before building

Checks against a live B1 and the installed Better Auth, done at the start of the phase that needs
them. Record any verified error strings in code comments, as the repo already does.

| Phase | Check |
|---|---|
| P2 | Better Auth 1.7: `session.modelName` + organization `schema.*.modelName` + `additionalFields` together on a shared `user` table; `inferOrgAdditionalFields` on the client; generating a second instance into `portal-auth.ts` without touching the `user`, `account` and `verification` it shares. |
| P2 | `xms_edov` arrives in the Microsoft profile once configured as an optional claim. |
| P4 | `createQuote` for a `cLid` BP: B1 accepts a Sales Quotation for a lead (and which later documents it refuses until conversion). |
| P6 | BP POST with `Series` and no `CardCode` returns the generated `CardCode`; `BPAddresses` and `ContactEmployees` are accepted inline in the same POST; `U_CF_Key` on OCRD (alphanumeric, 64) filters as on quotations. |
| P7 | The `SalesPersons` entity exposes the employee email, and under which property name (read it from `$metadata`). |
