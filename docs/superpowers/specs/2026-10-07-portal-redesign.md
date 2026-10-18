# Customer portal: a separate app for external users

**Date:** 2026-10-07
**Superseded in part 2026-10-17** by `2026-10-17-single-sign-in-design.md`: one Better Auth instance,
one session table and one sign-in on `<domain>` for staff and customers. D2's cookie zones, §3 "Auth
lives on each apex", §4.1, §4.5 (captcha, `t` branding) and §9's apex lobby no longer hold.
**Status:** Spec agreed through Q&A. **P0–P2 built 2026-10-16** (plan:
`docs/superpowers/plans/2026-10-16-portal-p0-p2.md`). **P3 built 2026-10-16** (plan:
`docs/superpowers/plans/2026-10-16-portal-p3.md`). Decided then: no `joined` event until P4; the
last-owner guard applies on both sides; owners list and cancel their own pending invitations;
invitation Reply-To is the inviter until P7. P4–P7 are not built yet. §16 lists what must be checked
against a live B1 and Better Auth before the matching phase starts.
**P4 decided 2026-10-17** through Q&A: the portal configurator runs the engine on the server and
receives a projection (§7.1); indicative prices are live, then frozen at submit, then the quotation's
(§7.2); a declined quote reopens the project and a re-quote modifies the same B1 quotation (§7.3);
`revised` is written once per round, at the next transition (§7.4); P4 takes the whole lifecycle,
quote response included (§15). There is no `joined` event.
**P4 built 2026-10-17.** Decided while building: the portal gets its own **views** router (personal
views only, `ui-views.ts` shared with the internal one), so personal views and value-help layouts
work from P4; the portal timeline shows SAP documents as **plain rows until P5** (no link, no PDF);
documents are a separate read (`timeline.documents`) and so is the live quotation behind Prices
(`projects.quotation`), so SAP being down never blocks a page; publishing is its own call
(`models.publish`) so it never bumps a model's `updatedAt`. The projection keeps **no parameter
expression at all** (not only `priceExpr`) and sends values of **visible** parameters only. A client
may not change a read-only parameter; a table the client sends back unchanged keeps staff's
overrides, a table the client edits becomes the client's (§7.1, `acceptPortalInputs`). Finalizing
actions sit in the page footers (Fiori). Notifications stay P7: no event mails yet. The four §16 P4
checks against a live B1 are **not done** — the code marks each assumption `unverified (spec §16)`.
**P5 decided 2026-10-18** through Q&A (§13.1): an entity with no `docFields` setting shows **code
defaults**; the "Project" link is on **all four** documents (a walk back through the lines'
`BaseType`/`BaseEntry` to the quotation); a timeline document row offers **Open + Preview**;
**Download is removed** from both apps (Preview only: the browser's PDF viewer still saves); Invoices
are on the portal; the settings picker is a table of entities whose *Edit* opens the existing column
p13n panel. `docs.chain` (§11) is not built: §9 never uses it and `timeline.documents` is the chain.
**P5 built 2026-10-18** (plan: `docs/superpowers/plans/2026-10-18-portal-p5.md`). Decided while
building: Settings' tabs mount only while selected (the Portal tab reads four SAP schemas); the portal's
`UiSource` keeps the raw `docs.*` functions on its `client` side, because `PrintActions` calls
`client.entities.print` directly.
**P6 decided and built 2026-10-18** (no plan document: built directly). Decided: the lead series is a
Select filled from `SeriesService_GetDocumentSeries` (`Document: "2"`, `DocumentSubType: "L"`, locked
series left out), sent as a POST through `createEntity`, so no new transport method; with **no series
set**, the lead POST omits `Series` and B1 uses its default lead series (invites are not refused); the
inviter's "new client onboarded" mail (§5.4 step 6, §12) **moves to P7**. Built: the form rule is one
pure module, `portal/onboarding-form.ts` (denylist, `extraPickable`, `onboardingSchema`,
`formProblems`, `leadPayload`, `leadKey`), read by the settings picker, `formSchema` and `submit`.
`formSchema` also returns the page's **seed**, and submit lays the form over the same seed, because
ObjectPage's create diff never sends a value equal to its seed. Fixed `AddressName`s "Bill to" / "Ship
to"; the contact's `Name` is first + last name, cut to 50. The form lives at
`/onboarding/$invitationId` (file `onboarding_.$invitationId.tsx`, outside `/onboarding`'s auto-join).
The §16 P6 checks are **not done** (the Service Layer was unreachable): the code marks each
assumption `unverified (spec §16)`. A tenant needs the `U_CF_Key` UDF (alphanumeric, 64) on OCRD
(Business Partners) as well as on OQUT; without it, submit refuses to run.
**Revised 2026-10-16:** onboarding is invitation-only (D7, D17, D25, D26, §5). Open
self-registration, applications and their approval are gone.
**Revised 2026-10-16:** this builds from the current internal-only codebase. The previous in-app
portal is already gone (§14). Nothing here migrates it or rewrites portal code.
**Revised 2026-10-16:** the mailer is Resend with React Email templates (D13, D28). Admins choose
which client-facing events send mail and to whom, per tenant with a per-company override (D27, §12).
A tenant can send client mail from its own verified subdomain (D29). An AI email designer is noted
for later (§17).

## 1. Goal

External users (the manufacturer's customers and prospects) get their own app on their own host
and their own server process, so external traffic never shares an event loop with internal users.
In that app they can:

- onboard **by invitation only**, in one of two ways: invited to an **existing** B1 business partner
  (they join its company), or invited as a **new client** (they fill a business-partner form that
  becomes a B1 **lead** when they submit it);
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
| D4 | Customer org | A customer company is a **plain Confire table** (`portal_company`, not a Better Auth organization): one per tenant × CardCode. The company owner can invite colleagues. |
| D5 | Auto-join | A verified sign-in whose email domain is registered to a company on this tenant **joins that company as `viewer`** (the lowest role). Free-mail domains are blocked. A Microsoft email counts as verified only on the `xms_edov` claim (§4.4). |
| D6 | Sign-in | Email + password (with verification), Google, Microsoft. |
| D7 | Lead timing | There is **no open self-registration**. A new-client invitation leads to the onboarding form, and submitting it **creates the B1 lead** (`CardType = cLid`) at once. The invitation is the tenant's approval; nobody reviews the form in between. |
| D8 | SAP load | Portal document reads stay **live, with no rate limit**. `ponytail:` see §13. |
| D9 | Project | **One project = one configuration** (`config_project`, as today). |
| D10 | Internal outcomes | Accept (in review), Quote, Send back for changes, Decline (final). The quotation and its linked orders, deliveries and invoices, with their PDFs, appear on the timeline. A quote the client declines **reopens** the project in review; a re-quote **modifies the same B1 quotation**, or posts a new one when B1 has it closed (§7.3). Internal users can close a B1 quotation from Confire. |
| D11 | Internal edits | Internal users may change entries, batches and tables while the project is in review. The client sees the changes as **one `revised` event per round**, a diff against the inputs frozen at submit, written at the next transition (§7.4). |
| D12 | Timeline extras | Comments both ways (with internal-only notes), file attachments, email notifications. |
| D13 | Mail | **Resend**, behind a `Mailer` seam (Resend in production, a console logger in dev). Sender `notify@mail.<domain>`, the tenant's name as display name, the tenant's sales address as `Reply-To`. Because a mailer now exists, **email verification is switched on for internal sign-ups too** (this removes the `ponytail` in `signup.tsx`). |
| D14 | Files | Attachments in **Postgres `bytea`** (`project_file`), with a per-file size cap. Upload and download are plain Hono routes, not oRPC: the RPC body cap is 2 MB. `ponytail:` move to S3-compatible storage (Bun's `S3Client`) when DB size or backups hurt. |
| D15 | Prices | **Per published model**: `portalPricing = "indicative"` (unit price and total per batch after calculate) or `"request"` (no numbers until quoted). The server omits the numbers, not the page. Indicative figures are live while the client edits, frozen at submit, and replaced by the quotation's once quoted; per-option price badges show on indicative models only (§7.2). |
| D16 | Lead CardCode | A **B1 numbering series**: an admin picks the BP `Series` in portal settings, and the create payload sends `Series` and omits `CardCode`. |
| D17 | Onboarding form | The **BP-create ObjectPage** with an onboarding section tree: **code-default** header fields plus **admin extras** (`BusinessPartners` fields from metadata, UDFs included, each required or optional), **addresses** (bill-to and ship-to → `BPAddresses`) and a **contact person** (the user → `ContactEmployees`). A hard denylist in code no extra can expose (§5.3). |
| D18 | UI code | **Extract `packages/ui`**: ListReport, ObjectPage, CFL, views and metadata merge, shared by `apps/web` and `apps/portal`. The portal declares its own external-user features. |
| D19 | Doc fields | **Admin-configurable** per entity (header and line fields, UDFs included), stored per tenant and enforced server-side. A new `portalSchema` projects B1 metadata down to that list. A **hard denylist** in code (cost, gross profit, margins, purchase prices) that no setting can expose. |
| D20 | v1 scope | Portal home overview; online quote acceptance (accept or decline the B1 quotation: a timeline event plus an internal notification; on accept internal staff create the order, a decline reopens the project, §7.3); tenant branding (logo, name, accent colour on the portal and in emails). **Not in v1:** multiple languages. |
| D21 | Models | **Every published model** (`config_model.portal = true`) is available to every company on the tenant. |
| D22 | Notify | Internal notifications go to the **BP's B1 sales employee** (`SalesPersonCode` → `SalesPersons` email → Confire user). If that resolves to nothing, they go to a tenant fallback list. |
| D23 | Old memberships | Leftover `member.role = "client"` rows are **not migrated**. No script turns them into portal companies. They stay locked out of the internal app. |
| D24 | Colleagues | A company owner may invite **only addresses on the company's registered domains**. Any other address needs an internal admin. |
| D25 | Invitations | **Two types, one link** (`/accept/<id>`). **Existing-BP**: sent from the BP Object Page (or by a company owner, D24), linked to that CardCode; the invitee joins. **New-client**: sent from the BP List Report header, no CardCode yet; the invitee fills the onboarding form. `portal_invitation.companyId` being null *is* the type, until submit sets it. |
| D26 | Duplicate guard | A new-client invite is refused when the email is already linked to a CardCode in **Confire's register** on this tenant (a portal member, or a pending invitation). B1 is not searched. `ponytail:` see §5.1. |
| D27 | Client mail settings | Admins choose, **per client-facing project event**, `off` / `creator` (the project creator) / `buyers` (the creator plus every buyer and owner of the company). Tenant-wide in Settings → Portal, with a **per-company override** on the BP Object Page that only internal admins edit. Account mail (invitation, verification, password reset) and internal notifications (D22) are not configurable. |
| D29 | Sender domain | A tenant may verify **its own subdomain** (`mail.mueller-gmbh.de`) as a Resend domain from Settings → Portal. While it is `verified`, **client-facing mail** goes out from `notify@<that subdomain>`: invitations and the D27 project events. The local part is always `notify`. Verification and password-reset mail, and every internal notification, stay on `notify@mail.<domain>`: the apex picks the tenant from `t`, which nothing trusts, so it may not choose a tenant's sending domain. |
| D28 | Templates | **React Email** components in code, rendered to HTML and text on send and branded per tenant (D20). Per-tenant template editing waits for the email designer (§17). |

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
| `session` | `session` | **`portal_session`** (`session.modelName: "portalSession"`) |
| Cookie | prefix `better-auth`, `.app.<domain>` | prefix `confire-portal`, `.portal.<domain>` |
| `organization` plugin | manufacturer = org; `member` = employees only; `organizationLimit: 1`. Leftover `client` rows stay locked out of this instance (already true in `userProcedure`) | **none**: companies, members and invitations are Confire tables (§4.2) |
| Email + password | `requireEmailVerification: true` (D13) | `requireEmailVerification: true` |
| Social | Google, Microsoft | Google, Microsoft (same OAuth clients, second callback URL) |
| Plugins | `organization` | `captcha` (Turnstile) |

Separate session tables mean a portal session can never authenticate an internal request, even
when replayed by hand. Users and linked accounts are shared on purpose: one password and one Google
link per person. The cost is that a password reset on either side changes it for both.

**No organization plugin on the portal.** Its endpoints assume a signed-in member acting on their
own org, while the portal's main writer is an internal user acting on a customer's. Verified on
Better Auth 1.7.7: `invite-member` requires the caller's own membership with `invitation:create`;
`createOrganization` drops every `input: false` field from its body (even from `auth.api`) and needs
an owner who already exists; `acceptInvitation` runs `beforeAcceptInvitation` but not
`beforeAddMember`. Every rule would be routed around, and ~15 `/api/auth/organization/*` endpoints
would still be live on the portal apex, waiting to be locked down. The rules live in Confire's SQL
instead, next to the membership join that already is the tenant boundary.

Schema: `packages/db/src/schema/portal.ts`, hand-written and re-exported from `schema/index.ts`. It
holds `portalSession` (Better Auth's `session` columns, without `activeOrganizationId`) and the
company tables in §4.2. The portal instance has **no generate target**: it adds one core table, and
the shared `user`, `account` and `verification` stay owned by the generated `auth.ts`. The drizzle
adapter resolves `schema[modelName]`, so `modelName` is the **export key** (`portalSession`), not the
SQL table name.

### 4.2 Customer company: plain tables

- `portal_company (id, tenantId, cardCode, cardName, cardType)` with **unique (tenantId, cardCode)**;
  `cardType` is `cCustomer` | `cLid`. Rows are created server-side only: by an existing-BP
  invitation, or when a new-client onboarding form is submitted (§5.4). This table **is the register**
  of which CardCodes are on the portal; its members are that CardCode's portal users. Nothing a
  portal user can call creates, renames or deletes one.
- `portal_member (companyId, userId, tenantId, role)`: **primary key (companyId, userId)** and
  **unique (tenantId, userId)**. The second index *is* "one company per user per tenant". It is a
  constraint rather than a hook, so a concurrent join and accept cannot both win. `tenantId` is
  copied from the company for exactly that index.
- `portal_invitation (id, tenantId, companyId, email, role, invitedBy, registerDomain, status,
  expiresAt)`, where `status` is `pending | accepted | canceled`. `companyId` is **nullable**: null
  is a new-client invitation (D25), and submit sets it to the company it created, so every accepted
  invitation ends up linked to a CardCode. A partial unique index on `(tenantId, lower(email)) WHERE
  status = 'pending'` makes "one open invitation per email per tenant" a constraint, so two
  concurrent invites cannot both win. The random `id` goes in the link, but holding it is not
  enough: acceptance also checks the email (§5.2).
- Roles are the `role` column. The §4.3 builders are the whole permission check; there is no
  access-control config.

  | Role | Can |
  |---|---|
  | `owner` | everything below + invite colleagues on company domains, change roles, remove members |
  | `buyer` | create, edit, submit and withdraw projects; comment; upload; accept or decline quotes |
  | `viewer` | read projects, timeline and documents; print; comment |

- `portal_company_domain (tenantId, domain, companyId)`, **primary key (tenantId, domain)**. This is
  the auto-join index, and the key is what stops one domain mapping to two companies. Domains are
  written **only by internal users**: through an invitation's `registerDomain` checkbox (applied on
  accept or submit, never for free-mail, skipped when the domain already belongs to another company)
  or from the BP Object Page's Portal section (§10). A company cannot claim a domain itself, because
  a lead that registered a competitor's domain would capture that competitor's staff.
- **One insert path for members.** `addPortalMember(tx, …)` is the only code that writes
  `portal_member` (auto-join, invitation accept, onboarding submit). It refuses an internal
  member of the same tenant ("you work for this supplier") and maps a unique violation on
  (tenantId, userId) to "already in a company here". On the internal side, the mirror check goes in
  the internal instance's `beforeAcceptInvitation`, because `acceptInvitation` does not run
  `beforeAddMember` (verified on 1.7.7).
- **Invitations** are §5: two types, where they are sent from, the duplicate guard, and the one
  link. Every accept path ends in one transaction: a guarded `UPDATE … SET status = 'accepted' WHERE
  status = 'pending'` and `addPortalMember`. A double click loses at the guard.
- **The tenant boundary is still host → tenant → membership join**, as in `orpc/base.ts` today.
  There is no active-company state: the host picks the tenant, and the unique index leaves at most
  one company there.

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
4. calls `addPortalMember` with role `viewer` (§4.2). There is no audit event:
   `portal_member.createdAt` records the join, and the Company page lists it.

If nothing matches, the user sees an "ask your supplier for an invitation" page. Auto-join and an
invitation (§5) are the only two ways into a company.

Microsoft: in multi-tenant Entra apps the `email` claim is not guaranteed verified. The Microsoft
provider's `mapProfileToUser` sets `emailVerified` from the optional `xms_edov` claim, which the
Entra app registration has to emit. Google's `email_verified` is used as-is. Since 1.7 a Microsoft
account is keyed on the `oid` claim and a token without one is rejected: the mapper can change
`emailVerified` (it is spread after the built-in value), never the identity a link attaches to.

### 4.5 Other plugins

- `captcha` with `provider: "cloudflare-turnstile"` on `/sign-up/email`, `/sign-in/email` and
  `/request-password-reset`.
- `emailVerification.sendVerificationEmail` and `sendResetPassword` go through `Mailer`, branded
  with the tenant named by `t`, or Confire when there isn't one.

## 5. Onboarding flows

Onboarding is **invitation-only** (D7). Besides auto-join (§4.4), an invitation is the only way into
a company, and there are two types of invitation behind one link (D25).

### 5.1 Invitations

| | Existing-BP invitation | New-client invitation |
|---|---|---|
| Sent from | **BP Object Page**, header action *Invite to portal* (`header.actions` on the `businessPartners` feature); or a company owner on the portal (D24) | **BP List Report**, DynamicPage header toolbar *Invite new client* (the `actionsBar`, next to Refresh), `BusinessPartners` only |
| Input | email, role (defaults to `owner` while the CardCode has no portal users), `registerDomain` | email, `registerDomain` |
| `companyId` | the company for this CardCode, found or created on send | null until submit (§5.4) |
| Role on accept | the invitation's | `owner` |
| The invitee | joins (§5.2) | fills the onboarding form (§5.3) |

Internal senders are admins and owners; the server enforces it, not which button a page draws.
An existing-BP invitation re-reads the BP from SAP first. Customers and leads both qualify.
It finds or creates `portal_company` for (tenant, CardCode).

**Guard.** Checked on send, server-side, against Confire's own tables (D26):

- **New-client:** refused when the email (ignoring case) already belongs to a portal member on this
  tenant, or already has a pending invitation here. The refusal names the CardCode the email is
  linked to, so the sender can use *Invite to portal* on that BP instead.
- **Existing-BP:** refused when the email already belongs to a member of *another* company on this
  tenant. Accept would fail on the unique index anyway; refusing at send time is kinder.
- **Both:** refused for an internal member of the tenant ("you work for this supplier").
- The partial unique index on pending invitations (§4.2) is the backstop when two sends race.

`ponytail: register-only guard, B1 is not searched — a customer who was never on the portal can
still get a duplicate lead from a new-client invite. Add a B1 lookup (BP EmailAddress, contact
E_Mail via $crossjoin) when that bites.`

**Sending.** Insert the row (`expiresAt` = 14 days) and mail
`https://<slug>.portal.<domain>/accept/<invitationId>` through `Mailer`, branded with the tenant and
naming the inviter. Re-sending is cancel + a new invitation, since the index allows one open
invitation per email. Pending invitations are listed (and cancelled) on **Portal → Invitations**
and, for existing-BP ones, in the BP Object Page's Portal section (§10).

### 5.2 The link: `/accept/$invitationId`

1. Not signed in: hard redirect to `portal.<domain>/login?redirect=…&t=<slug>`. The invitee signs in
   or signs up there (D6, captcha, verification) and comes back.
2. `onboarding.invitation` checks what Better Auth's `acceptInvitation` checks (pending, not expired,
   `email` equal to the user's email ignoring case, `user.emailVerified`), plus invitation `tenantId`
   = host tenant and "not an internal member here". It returns the type, the inviter, the tenant
   branding and, for existing-BP, the company name and role. A failed check is a page that says why
   (a wrong account gets "this invitation was sent to a…@…, sign in with that address").
3. **Existing-BP:** "Join *CardName* on *Tenant*'s portal" with an Accept button.
   `onboarding.accept` runs the guarded `UPDATE` and `addPortalMember` (§4.2), and registers the
   domain when `registerDomain` is set. Then the portal home.
4. **New-client:** navigate to `/onboarding/$invitationId`, the form.

### 5.3 The onboarding form

The BP-create `ObjectPage` from `packages/ui`, **unchanged**: `isNew`, `entity="BusinessPartners"`,
`constraints` from `onboarding.formSchema`, `localViews` (no `ui_view` rows for a non-member),
`createLabel="Submit"`, a `notice` ("*Inviter* invited you to *Tenant*'s portal…"),
`lockedFields={["Contact.E_Mail"]}`, and a seed with the user's email and name and
`ShipToSame: true`. The "template" is a declared section tree, `apps/portal/src/features/onboarding.ts`,
the same shape as `features/b1/business-partners.tsx`:

| Section | Fields |
|---|---|
| Company | code defaults `CardName`, `FederalTaxID`, `Phone1`, `EmailAddress`; then the admin extras in settings order |
| Bill-to | `BillTo.Street`, `BillTo.ZipCode`, `BillTo.City`, `BillTo.Country`, `ShipToSame` (checkbox) |
| Ship-to | `ShipTo.Street`, `ShipTo.ZipCode`, `ShipTo.City`, `ShipTo.Country`; `visible: (d) => !d.ShipToSame` |
| Contact | `Contact.FirstName`, `Contact.LastName`, `Contact.Phone1`, `Contact.E_Mail` (locked) |

**Flat prefixed keys, on purpose.** `ObjectPage` validates only the fields its section tree declares
(`allFields`), and `diffOf` sends only what the constraints mark writable. Declaring the address and
contact inputs as ordinary fields keeps required, `MaxLength` and save validation exactly as they
are; a section template drawing its own nested inputs would have to rebuild all three. The server
folds the keys back into collections (§5.4). A hidden Ship-to section is not validated.

**`onboarding.formSchema(invitationId)`** returns an `EntityConstraints`, the type
`entities.metadata` returns, and only to the user a pending new-client invitation names:

- header fields from the cached BP schema (`entitySchema`): the code defaults ∪
  `settings.onboarding.extraFields`, minus the denylist;
- `BillTo.*` / `ShipTo.*` from `BPAddresses.Fields` and `Contact.*` from `ContactEmployees.Fields`,
  so labels and `MaxLength` come from B1; `ShipToSame` as a boolean;
- `Editable` on all of them; `Required` from the code defaults (`CardName`, `BillTo.Street`,
  `BillTo.City`, `BillTo.Country`, `Contact.LastName`, and the same Ship-to fields) and from each
  extra's setting. The form and the submit handler read this one rule;
- `BillTo.Country` / `ShipTo.Country` carry `Options` read from `Countries` (`Code`, `Name`), so the
  country is a plain select and the onboarding form needs no value help before its user is a member.

**Denylist** (code, applied to the settings picker and to `formSchema` alike): `CardCode`,
`CardType`, `Series`, `U_CF_Key`, `CreditLimit`, `MaxCommitment`, `PriceListNum`, `DiscountPercent`,
`PayTermsGrpCode`, `SalesPersonCode`.

`ponytail: no State field — B1 checks it per country against OCST; add a country-dependent select
when a tenant needs one. Extras that need a value help (GroupCode, Industry) render as plain inputs;
enums still get a select. Countries are read live on each formSchema call (the agent has to be up to
submit anyway).`

### 5.4 Submit: `onboarding.submit({ invitationId, form })`

1. **Pre-flight, before any B1 call:** everything `onboarding.invitation` checks, the type is
   new-client, the user is in no company on this tenant, and the §5.1 new-client guard again
   (ignoring this invitation). An invitation can sit for two weeks.
2. **Validate against `formSchema`:** a key outside it is refused (rather than dropped, as
   `pickEditable`'s callers do), required fields present (the `ShipTo.*` ones only when `ShipToSame`
   is false, as on the page), `MaxLength` respected.
3. **Build the payload:** the header fields; `BPAddresses` = bill-to (`AddressType: "bo_BillTo"`)
   and ship-to (`"bo_ShipTo"`, a copy of bill-to when `ShipToSame`), each with a server-set
   `AddressName`; `ContactEmployees: [{ Name, FirstName, LastName, Phone1, E_Mail }]` with `E_Mail`
   the **session's** verified email, never the form's; `CardType: "cLid"`, `Series:
   settings.leadSeries` (D16) and no `CardCode`; `U_CF_Key` = SHA-256 over `tenant|invitationId`.
4. **Check-then-create, exactly like `createQuote`:** `BusinessPartners?$filter=U_CF_Key eq '<key>'`.
   A hit means B1 created the lead and our response never arrived, so use its CardCode. Otherwise
   POST with return-representation and take the generated CardCode. A 400 on the filter means the UDF
   is missing on OCRD, and the handler **refuses to run** with the setup message. The key covers the
   invitation, not the form, so a retry with corrected data binds to the lead that already exists.
   Two concurrent submits share `createQuote`'s window; Submit is disabled while saving.
5. **One transaction:** insert `portal_company` (`cardType = cLid`); guarded `UPDATE
   portal_invitation SET status = 'accepted', companyId = … WHERE id = … AND status = 'pending'`
   (zero rows = rollback, `CONFLICT`); `addPortalMember(owner)`; the domain when `registerDomain`.
   If this fails after the POST, the invitation is still pending and a retry binds through
   `U_CF_Key`.
6. **After commit:** mail the inviter (§12). The user lands on the portal home as owner.

B1's error, when the POST is refused, reaches the page as `ObjectPage`'s save error.

### 5.5 Lead to customer

A lead converted to a customer in B1 keeps its CardCode, so the binding survives. Only `cardType`
is refreshed, read live when the company page loads.

## 6. Data model

New tables (all with `tenantId text` like the rest, no FK to `organization`):

| Table | Columns (key ones) | Notes |
|---|---|---|
| `portal_session` | Better Auth `session` columns, hand-written | `session.modelName: "portalSession"`; no `tenantId` |
| `portal_company` | `id`, `tenantId`, `cardCode`, `cardName`, `cardType`, `notify jsonb` | unique (tenantId, cardCode); `notify` is the D27 override, a partial `{ [event]: mode }` (null or a missing key = the tenant's setting) |
| `portal_member` | `companyId`, `userId`, `tenantId`, `role` (owner\|buyer\|viewer), `createdAt` | PK (companyId, userId); unique (tenantId, userId) |
| `portal_invitation` | `id`, `tenantId`, `companyId` (null = new-client until submit), `email`, `role`, `invitedBy`, `registerDomain`, `status` (pending\|accepted\|canceled), `expiresAt`, `createdAt` | `id` is the link token; partial unique (tenantId, lower(email)) where pending |
| `portal_company_domain` | `tenantId`, `domain`, `companyId`, `addedBy`, `addedAt` | PK (tenantId, domain) |
| `portal_settings` | `tenantId` PK, `settings jsonb` | one document loaded and saved whole (CLAUDE.md convention): `onboarding: { extraFields: [{ key, required }] }`, `leadSeries`, `docFields: { [entity]: { header: [], lines: [] } }`, `branding: { displayName, accent, logoFileId }`, `notify: { [event]: "off" \| "creator" \| "buyers" }` (D27, defaults in §12), `senderDomain: { name, resendDomainId, region, status, records, error } \| null` (D29), `notifyFallback: string[]`, `replyTo` |
| `config_project_event` | `id`, `tenantId`, `projectId`, `at`, `kind`, `actorUserId`, `actorSide` (internal\|external), `visibility` (external\|internal), `note`, `payload jsonb`, `mailError` | replaces `config_project.events` jsonb |
| `project_file` | `id`, `tenantId`, `projectId`, `eventId`, `name`, `mime`, `size`, `data bytea`, `uploadedBy`, `visibility` | D14; also holds the branding logo (`projectId` null) |

Changed:

- `config_project.status`: widen from `draft | quoted` to
  `draft | submitted | in_review | returned | declined | quoted`. Internal configurations use only
  `draft` and `quoted`.
- `config_project`: **add** `portalCompanyId` (nullable, indexed; the portal fence),
  `assigneeId`, `quoteResponse` (`accepted | declined | null`) and `quoteRespondedAt`.
  **Drop** `events`. The jsonb list (`created`, `quoted`) is replaced by `config_project_event`,
  with no backfill (`quotedAt` already dates an old quote). A portal project's `customer` is set from
  its company on create, so `createQuote` and the internal lists read it the way they do today.
  `b1DocEntry` is **the current quotation**: a re-quote modifies it, or replaces it when B1 has it
  closed (§7.3). Each `quoted` event keeps its own `docEntry`, so earlier quotations stay findable.
- `config_model`: **add** `portal` (boolean, default false; D21) and `portalPricing`
  (`"indicative" | "request"`, default `"request"`). Unpublishing hides a model from the catalog;
  projects already created from it keep working.

`config_project_event.kind`, and its `payload`:

| Kind | Payload | Notes |
|---|---|---|
| `created` | — | internal projects too |
| `submitted`, `resubmitted` | `{ inputs: { entries, batches, tables }, prices? }` | the snapshot §7.2 and §7.4 read; `prices` only for `indicative` models |
| `withdrawn`, `accepted`, `returned`, `declined` | — | `note` carries the reason where there is one |
| `revised` | `{ entries: { [key]: [old, new] }, batches?: [old, new], tables: { [key]: [oldRows, newRows] } }` | row counts for tables; written by §7.4 |
| `quoted` | `{ docEntry, docNum, value, mode: "created" \| "updated", inputs }` | internal projects too; `inputs` is the next round's §7.4 baseline |
| `quote_accepted`, `quote_declined` | — | `note` is the client's |
| `comment` | — | `note` is the text |
| `file` | `{ fileId }` | P7 |

Internal-only projects write `created` and `quoted` and nothing else.

## 7. Project lifecycle

```
                submit                accept                 quote
  draft ──────────────▶ submitted ─────────────▶ in_review ─────────────▶ quoted ── quote accepted ──▶ (final)
        ◀── withdraw ──   ▲  │  │                 ▲  │  │ ◀─ quote declined ─┘
                resubmit  │  │  └──── decline ────┼──┼──┴──── decline ────▶ declined (final)
                          │  │ send back          │  │ send back
                       returned ◀─────────────────┼──┘
                                                  └── (re-quote modifies the same quotation, §7.3)
```

| Action | From → to | Who | Events (all `external`) |
|---|---|---|---|
| create | — → `draft` | buyer | `created` |
| submit | `draft` → `submitted` | buyer | `submitted` (snapshot, §7.2) |
| withdraw | `submitted` → `draft` | buyer | `withdrawn` |
| accept | `submitted` → `in_review` | internal member; sets `assigneeId` | `accepted` |
| send back | `submitted`, `in_review` → `returned` | internal member | `revised` (if any, §7.4), `returned` |
| resubmit | `returned` → `submitted` | buyer | `resubmitted` (snapshot) |
| decline | `submitted`, `in_review` → `declined` | internal member | `revised` (if any), `declined` |
| quote | `in_review` → `quoted` | internal member | `revised` (if any), `quoted` |
| quote accepted | `quoted` (stays), `quoteResponse = accepted` | buyer | `quote_accepted` |
| quote declined | `quoted` → `in_review`, `quoteResponse = declined` | buyer | `quote_declined` |

- Every action is one guarded `UPDATE` on `status` (and on `calculatedAt` for submit and resubmit,
  as today), written in the same transaction as its event rows. The side that loses a race gets a
  clear error instead of a lost write.
- **Submit and resubmit gates:** a name, at least one batch, a calculation (`calculatedAt` not
  null) and no `missingInputs`, the same rule the internal *Create quote* button follows.
- `withdraw` only from `submitted`. Once accepted, the client comments instead.
- `accept` sets `assigneeId`. The client sees "In review" and the assignee's name.
  `ponytail: no reassignment — add a "Reassign" action when a sales team asks for one.`
- A declined quote reopens with the same assignee. A re-quote clears `quoteResponse`.
- Client-facing labels: Draft, Submitted, In review, Changes requested, Declined, Quoted
  (+ "Accepted" / "Declined by you").

**One writer per status.** `assertConfigMutable` becomes `assertWritable(tenantId, projectId, side)`,
and every handler that writes a project's inputs (`configs.update`, `calculate`, `select`, `remove`,
and their portal counterparts) goes through it:

| Status | Client (buyer, owner) | Internal |
|---|---|---|
| `draft` | edit, delete, submit | — (a portal draft is invisible, §10) |
| `submitted` | withdraw | accept, send back, decline |
| `in_review` | comment | edit (D11), quote, send back, decline |
| `returned` | edit, resubmit | read |
| `declined` | read | read |
| `quoted` | read, respond to the quote | read |

An internal-only project (`portalCompanyId` null) keeps today's rule: editable until `quoted`. On
a portal project, `configs.update` also refuses `modelId` and `customer`: the model was the
client's pick, and the customer is the company.

### 7.1 The portal configurator

**The engine runs on the server.** `apps/portal` never receives a `ModelDef`, `ResolvedLookups` or a
candidate's `outputs`, and never runs `propagate`. `projects.get` and `projects.calculate` return one
payload: the project's portal fields, `toPortalModelDef(model)`, `toPortalProp(prop)`,
`toPortalLookups(…)`, `missing` (from `missingInputs`), `badges` and `prices` (§7.2). One edit is one
call: `projects.calculate({ id, entries?, batches?, tables? })` writes the inputs and empties the
candidates in one statement, recalculates when the inputs are complete, and returns that payload,
the contract `configs.calculate` already keeps. The page debounces like the internal one.

The projection is `portal/projection.ts`, pure and unit-tested. It is the fence, so each function
names what it keeps:

- `toPortalModelDef`: `name`, `description`, `parameters` without `priceExpr`, `structure`, and
  `tables` without the items grid's `unitcost`/`unitprice` and with formula `expr` blanked.
  `computed`, `constraints`, `bom`, `routing`, `history` and `pricing` stay out.
- `toPortalProp`: `values` filtered to parameter keys (no computed, no `<param>_<column>` derived
  keys), `domains`, `visible`, `required`, `defaulted`, `open`, `conflicts` (the author's messages),
  plus `tables`: each table's rows **evaluated on the server**, which is how a formula column shows a
  value without its expression.
- `toPortalLookups`: only the option tables a visible parameter or table column names, and only
  their non-`hidden` columns. `prices` never goes.

`ConfiguratorForm` and `ConfigTable` render this unchanged, with two optional props: `badges`
replaces the local `paramPrices`, and `evaluated` replaces the local `evalTableRows`. The internal
page passes neither and keeps computing in the browser. On the portal, `money` is absent, so the
items grid has no cost or price columns. Formula cells are read-only there: typing over a formula
is a salesperson's override.

**Portal input is checked on the server:** an entry key outside `model.parameters` is refused, and
so is a table cell on `unitcost`, `unitprice` or a formula column.

**Value help:** `projects.queryPage` pages a table only when the model is published and names it
(`referencedTables`), and leaves out the `hidden` columns. The portal's `UiSource.client.configs.queryPage`
calls it, so `CflField` works unchanged.

**What the client sees:** every parameter and table of the model, plus *General* with only Name and
Batch quantities. The model is picked from the catalog at create and cannot change; the customer is
the company. There are no candidates on the portal. Staff pick them during review, as today.
`ponytail: no "internal only" field flag — a model with salesperson-only fields is not published, and
the §7.4 diff shows every changed field. Add a flag on ParamZ/TableColumnZ when a tenant needs both.`

### 7.2 Prices

The first matching row wins:

| When | What the Prices section shows | Models |
|---|---|---|
| the project has a `b1DocEntry` (quoted, or reopened in review) | the current B1 quotation's lines and total, read live, after its CardCode matches the company; marked "declined by you" while reopened | both |
| `draft`, `returned` | live: per batch, unit price and total from the current candidates. One candidate gives exact figures; several give "from" (the minimum) | `indicative` |
| `submitted`, `in_review` | the figures **frozen in the latest `submitted`/`resubmitted` event**, labelled "indicative at submission" | `indicative` |

`request` models show no number before the quotation, and no badges.

The freeze lives on the append-only event row, so the project row stays live ("nothing is
snapshotted") and needs no new column. `toPortalPrices` computes the live figures from the
candidates on the server and sends only these numbers. Item split prices never go.

**Badges:** the per-option price a parameter's `priceExpr` gives (`paramPrices`), evaluated on the
server and sent as amounts. The expression never leaves the server.

### 7.3 Quote and re-quote

`quote` is `createQuote` (dedup UDF, `b1DocEntry`) plus the events. The CardCode is the company's,
lead or customer. With no `b1DocEntry`, it creates, as today. With one (a reopened project), it
reads the quotation first:

- **Open → modify.** `PATCH Quotations(n)` with `If-Match`, the new header and `DocumentLines`, and
  `B1S-ReplaceCollectionsOnPatch: true`. Without that header the Service Layer merges lines by
  `LineNum` and keeps the ones it was not sent. `U_CF_Key` is rewritten to the new `commandId`. A
  lost response means the retry gets a 412 (the ETag moved). The handler then re-reads, and if
  `U_CF_Key` already equals this `commandId`, the update landed and it is a success. This is
  check-then-create applied to an update. The `quoted` event says `mode: "updated"`.
- **Closed → create a new one.** Closed by hand or by B1 (lines copied to an order): post a new
  quotation and move `b1DocEntry` to it. For this create, the dedup hash also covers the previous
  `docEntry`, or the pre-check would find the closed quotation and report it as the new one. The old
  `docEntry` stays on its `quoted` event, and the timeline shows both chains.

`quotedValue`/`quotedCost`/`quotedAt` are overwritten on every quote.

**Close a quotation from Confire.** `entities.close({ entity: "Quotations", key })`, admin/owner like the
rest of `/b1`: a *Close* header action on the Quotations Object Page and a *Close* action on the
List Report's selected rows. It calls `POST Quotations(n)/Close` through a new transport method,
`action(entitySet, key, name)`, with an allowlist of action names on the agent route as well.

**Quote response (D20):** on `quoted`, a buyer or owner accepts or declines with an optional note.
That sets `quoteResponse`/`quoteRespondedAt` and writes the event. Accepted is final, and internal
staff create the order. Declined reopens the project in review (§7). Nothing is written to SAP.

### 7.4 Revisions

Internal edits in `in_review` go through `configs.calculate` and write no event on their own. The
page auto-calculates about 1 s after every edit, so an event per call would be one per keystroke.
Instead, the next transition (quote, send back or decline) compares the current inputs with the
`inputs` frozen in the latest event that carries them (`submitted`, `resubmitted` or `quoted`). If
anything differs, it writes one `revised` event first (payload in §6). `quoted` carries them so a
reopened project's next revision shows only what changed since the declined quote. Keys are stored, and labels are resolved from the model when
the timeline is read. One revision per round, and half-done edits never reach the client.

### 7.5 Code layout (P4)

| Path | What |
|---|---|
| `apps/server/src/config-project.ts` | **moved** out of `orpc/routers/configs.ts`: `loadModel`, `cachedLookups`, `liveEngine`, `calculateProject`, `queryTablePage`. The router module imports `orpc/base.ts` → the internal `auth.ts`, which the portal process must not build |
| `apps/server/src/config-quote.ts` | + `quoteDraft`, `createQuote` (create or modify, §7.3) |
| `apps/server/src/project-lifecycle.ts` | **new**, the only writer of `status` and `config_project_event`: `transition()`, `assertWritable(side)`, `revisionDiff()`. Both processes import it (the `portal/members.ts` pattern) |
| `apps/server/src/portal/projection.ts` | **new**, pure: `toPortalModelDef`, `toPortalProp`, `toPortalLookups`, `toPortalPrices`, with a test |
| `apps/server/src/portal/orpc/projects.ts`, `timeline.ts` | **new** portal routers (§11) |
| `apps/server/src/orpc/routers/requests.ts`, `timeline.ts` | **new** internal routers (§11) |
| `apps/server/src/orpc/routers/entities.ts` | + `close` |
| `packages/b1`, `apps/agent` | + `action()` and the `/action` route; `updateEntity` + `replaceCollections` |
| `packages/db/src/schema/configurator.ts` | status widened, the §6 columns, `configProjectEvent` |
| `packages/ui/src/configurator/` | **moved** from `apps/web`: `ConfiguratorForm`, `ConfigTable`, `formHelpers`, `configTableOps`, `costElements`; currency through `UiSource` (a `useCurrency` hook next to `useRole`) |
| `packages/ui/src/timeline/ProjectTimeline.tsx` | **new**, props-driven: each app passes its own events and comment mutation |
| `apps/portal/src/routes/_authed/projects/` | **new**: `index.tsx`, `new.tsx`, `$id.tsx` |
| `apps/web/src/routes/_authed/requests/index.tsx` | **new**: Portal → Requests |

## 8. Timeline

One merged, time-ordered feed per project:

- **Events** from `config_project_event`. The portal reads `visibility = 'external'` only; the SQL
  filter is the fence, and nothing is hidden by the page. Revisions render their diff, comments their
  text, files a download link.
- **SAP documents**: `documentChain(docEntry)`, live (quotation → orders → deliveries → invoices),
  for each distinct `docEntry` in the project's `quoted` events. Usually that is one quotation; a
  quotation replaced because it was closed (§7.3) keeps its own chain, marked superseded. Each
  entry links to its portal Object Page and its PDF. The portal print handler calls
  `printDocument` only after the document's CardCode matches the company. `printDocument` itself
  stays the printable-entity allowlist. Before the first `quoted` there is no chain.
- Rendered by `ProjectTimeline` (UI5 `Timeline`) on both project pages, with a comment box. Buyer,
  owner and viewer can comment, and a portal comment is always `external`. Internal comments carry
  an internal-only toggle. Upload is P7 (buyer and owner).

## 9. Portal app UI (`apps/portal`)

`NavigationLayout` + `ShellBar` + `SideNavigation`, the same chrome pattern as `AppShell.tsx`.
The ShellBar shows the tenant's logo and name (D20). The user menu has account, theme, density,
"switch supplier" (to the apex lobby) and sign out.

| Side nav | Route | Page |
|---|---|---|
| Home | `/` | overview cards: open requests by status, quotes awaiting your response, recent documents, open invoices |
| Projects | `/projects` | List Report over `portal.projects.rows`, with system views All / Drafts / In progress / Changes requested / Quoted; **New project** opens the model catalog |
| | `/projects/new` | published-model catalog (cards) → name → create |
| | `/projects/$id` | Object Page: header (status, model, assignee, actions by status and role: Submit, Withdraw, Resubmit, Delete, Accept / Decline quote), sections **Configuration** (*General* with Name and Batch quantities, then the configurator form from §7.1, read-only outside `draft`/`returned`), **Prices** (§7.2: `indicative` models, or once quoted), **Timeline** |
| Documents ▸ Quotations / Sales orders / Deliveries / Invoices | `/docs/$entity` | List Report over `portal.docs.rows`, columns from the tenant's `docFields` |
| | `/docs/$entity/$key` | Object Page, read-only, **Print** action, plus a "Project" link when the document belongs to one |
| Company (fixed item, owner only) | `/company` | members (invite on company domains, role, remove), registered domains (read-only), BP summary |

Not under `_authed`: `/accept/$invitationId` (the join page, or on to the form, §5.2),
`/onboarding/$invitationId` (the new-client form, §5.3), `/onboarding` (no company here: auto-join,
else "ask your supplier for an invitation"). On the apex: `/login`, `/signup`, `/forgot-password`, and `/` as the supplier lobby
(list of the user's companies across tenants → hard redirect).

Views: system views are code. External users may save **personal** views (`ui_view` rows with
their own `userId`). There are no shared views on the portal side.

## 10. Internal app changes (`apps/web`)

- **Side nav group "Portal"** (any member sees Requests; admins and owners see the rest):
  - **Requests**: List Report over portal projects, with system views New (submitted), Mine
    (in review, assignee = me), Changes requested, Declined, Quoted, Quote responses. It opens the
    existing configuration process page. A portal project shows here **from its first submit** and
    nowhere else: a client's draft is private (`status = 'draft'` with a `portalCompanyId` is
    invisible to every internal read), and **Configurations** (`configs.rows`) lists internal-only
    projects, the staff's own work list.
  - **Invitations**: List Report over `portal_invitation`, both types, with status, CardCode (empty
    for a pending new-client one), email, inviter and expiry; **Cancel**. The only place a pending
    new-client invitation shows.
- **Business partners** (the `businessPartners` feature, admins and owners only, §5.1):
  - List Report `actionsBar`: **Invite new client**.
  - Object Page `header.actions`: **Invite to portal** (not in create mode).
  - Object Page **Portal** section, a `sectionTemplate`: this CardCode's portal users (role, remove),
    pending invitations (cancel) and registered domains (add, remove). It is how an internal user sees
    whether a BP is already on the portal before inviting. It also holds **Email notifications**:
    the §12 configurable events, each set to *Tenant default (…)*, `off`, `creator` or `buyers`.
- **ConfigProcessPage**, for portal projects: header actions Accept / Send back / Decline / Create
  quote by status (§7); editable only in `in_review` (§7's side table); Model and Customer
  read-only (the customer is the company); the client's quote response in the header; a Timeline
  section (§8) with comment box and internal-only toggle (upload in P7). Create quote on a reopened
  project modifies the quotation (§7.3), and the quote page says so.
- **Quotations** (the `documents` feature): a **Close** action on the Object Page header and on the
  List Report's selected rows (§7.3), admins and owners.
- **Model builder → Settings tab** (admins): *Publish on the portal* (`config_model.portal`) and
  *Portal pricing* (`indicative` / `request`).
- **Settings → Portal tab** (admins): onboarding extras (pick `BusinessPartners` fields from
  metadata, filtered by the §5.3 denylist, and mark each required or optional);
  lead numbering series (value help over the BP series); document field pickers per entity (filtered
  by the hard denylist); branding (display name, accent, logo upload); **client email
  notifications** (one row per §12 configurable event: `off` / `creator` / `buyers`); **sender
  domain** (D29: enter a subdomain and a region, copy the DNS records shown, *Verify*, *Remove*; the
  status and the last error are shown); notification fallback list and Reply-To.

## 11. API surface

**Portal server** (`portal/orpc/router.ts`):

| Namespace | Procedures | Builder |
|---|---|---|
| root | `me` (session + tenant + `member` / `onboarding` state + branding) | session |
| `onboarding` | `join`, `invitation`, `accept`, `formSchema`, `submit` | session |
| `company` | `get`, `members.list`, `members.invite`, `members.setRole`, `members.remove`, `domains.list` | member / owner |
| `models` | `list` (published, with `portalPricing`) | member |
| `projects` | `rows`, `get`, `create`, `update` (name), `remove` (draft only), `calculate`, `queryPage`, `submit`, `withdraw`, `resubmit`, `respondQuote` | member (read) / buyer (write) |
| `timeline` | `list`, `comment` | member |
| `docs` | `metadata`, `rows`, `one`, `print`, `chain` | member |
| `home` | `overview` | member |

The Hono routes `POST /files/:projectId` and `GET /files/:id` use the same session and fence, with
a size cap on the stream.

Portal responses name their fields in mappers, the same way the internal routers do. Every
`projects` read and write is fenced on `portalCompanyId = seat.companyId`. `get` and `calculate`
return the §7.1 projection. There is no `lookups` procedure and no candidate list: the engine stays
on the server, and `toPortalPrices` (§7.2) is the only path a number takes to the page.

**Internal server** additions: `requests.{rows, accept, sendBack, decline}` (quote stays
`configs.createQuote`, now create-or-modify), `timeline.{list, comment}` (with `visibility`),
`entities.close` (Quotations, admin), `portalInvitations.{rows, inviteExisting, inviteNew,
cancel}`, `portalCompanies.{get (by CardCode: members, invitations, domains, notify), setRole, removeMember,
addDomain, removeDomain, setNotify}`, `portalSettings.{get, save, senderDomain.{add, verify,
remove}}`. Settings, invitations and companies are
`adminProcedure`; requests and timeline are `userProcedure`.

## 12. Notifications

Sent after the transaction commits, through `Mailer`, and never on the request's critical path.
A failure is logged on the event row (`mailError`).

`ponytail: no retry queue — there is no job runner; add an outbox table when a lost mail matters.`

**Fixed**: always sent, not configurable.

| Event | To |
|---|---|
| invitation, verification, password reset | the user |
| submitted, resubmitted, comment (external), file (external), quote response | the BP's sales employee (D22), else the fallback list |
| new client onboarded (§5.4: a lead now exists in B1) | the inviter |

**Configurable (D27)**: client-facing project events. The mode is `portal_company.notify[event]`,
else `portal_settings.notify[event]`, else the default.

| Event | Default | `creator` | `buyers` |
|---|---|---|---|
| accepted, returned, declined, quoted, revised, comment (internal, external visibility) | `buyers` | the project creator | the creator plus every company member with role buyer or owner |

Recipients are resolved from `portal_member` **at send time**. A creator who has since left the
company gets nothing, so a removed member's address never receives a project mail. Viewers get
project mail only when they created the project.

**Sending (Resend).** The template renders to `html` and `text` (D28) and goes out as one email per
recipient, so colleagues never see each other's addresses. Several recipients use `POST
/emails/batch` (≤ 100, atomic, no attachments, which no notification needs). Idempotency keys:
`batch-event/<eventId>` for project events, `invite/<invitationId>` for invitations. The SDK returns
`{ data, error }` instead of throwing, and `error.message` is what lands in `mailError`.

**Sender (D29).** Client-facing mail uses `"<display name>" <notify@<senderDomain.name>>` when
`senderDomain.status = 'verified'`, else `notify@mail.<domain>`. The stored status can be stale:
when Resend refuses the tenant's domain (403, domain not verified, e.g. its DNS records were
removed), the send is **retried once from `mail.<domain>`**, and `status`/`error` are updated so
Settings shows why. A bad DNS change therefore costs branding, never a lost mail. No poller: the
status changes on *Verify* and on a refused send.

Two keys: the `Mailer` holds a `sending_access` key (`RESEND_API_KEY`); only the `senderDomain`
handlers hold a `full_access` key (`RESEND_ADMIN_KEY`), because creating and verifying a domain
needs one. `senderDomain.add` refuses the root of the domain the tenant names (`mueller-gmbh.de`):
records on a subdomain cannot collide with the tenant's own Microsoft 365 SPF/MX, and its sending
reputation stays apart from their mailboxes'. Remove calls `domains.remove` and clears the field.

`ponytail: "subdomain" = at least three labels, so a root under a two-part suffix (mueller.co.uk)
slips through. Check against the public suffix list if a tenant ever does that.`

`ponytail: no Resend webhook — a bounce or spam complaint shows only in the Resend dashboard
(Resend suppresses the address itself). Add an email.bounced webhook that flags the member when
someone asks why they get nothing.`

Sales employee resolution: a live read of `BusinessPartners(CardCode).SalesPersonCode`, then that
`SalesPersons` row's email, matched against internal `member` emails of the tenant. Anything that
fails (agent down, no email, no match) falls back to the list.

## 13. SAP reads and writes

- **Reads are live, no limiter (D8).** Lists, object pages, chain walks, prints, the sales-employee
  lookup and the BP summary all go through the tenant agent.

  `ponytail: live and unlimited. Process separation isolates CPU and the event loop, not the agent or
  the Service Layer. Upgrade path: (1) a per-tenant concurrency cap and short TTL cache in front of
  portal reads; (2) a per-tenant document mirror in Postgres, the config_masterdata_row pattern.`
- **Document fields (D19):** `portalSchema(schema, docFields[entity] − DENYLIST)` is new, and it is
  the only field list a portal document read uses. `DocEntry`, `DocNum` and `DocumentLines` are
  always present; `CardCode` is never in the schema. List queries append
  `CardCode eq '<company cardCode>'` after `compileList`, so a saved view cannot widen the result.
  The denylist is code (exact names and name patterns, for example `GrossProfit*`,
  `GrossBuyPrice`, `*Cost*`) and applies to the settings picker and to the server alike.
- **Writes:** the quotation (create as today, or modify on a re-quote, §7.3), the quotation
  *Close* action (§7.3) and the lead BP create (§5.4). `ENTITY_PROFILES` stays the rule for
  internal entity edits; the re-quote PATCH is the server's own, built from the item matrix like the
  create, not an `entities.update`. The lead create is its own handler with its own field list,
  `formSchema` (code defaults ∪ admin extras, ∩ BP metadata, minus the denylist), plus the
  server-set `CardType`, `Series`, `BPAddresses`, `ContactEmployees` and `U_CF_Key`.

### 13.1 Portal documents (P5)

**Entities:** `Quotations`, `Orders`, `DeliveryNotes`, `Invoices`, and nothing else; the portal router
refuses any other name.

**The field rule, one pure module** (`portal/doc-fields.ts`, tested), read by both processes:

- `ALWAYS = DocEntry, DocNum, DocDate, DocumentStatus, DocTotal, DocCurrency`. The page header needs
  them, and the timeline already shows total and status to the client. They are in every portal
  schema and are not offered by the picker.
- `NEVER = CardCode`: the fence field, never in a portal schema (§13).
- `DENYLIST`: patterns, case-insensitive, matched on header and line fields alike: `*Cost*`,
  `*Profit*`, `GrossBuyPrice`, `Stock*` (the row's inventory value), `LastBuy*` (last purchase
  price), `*Margin*`, `*Commis*`, `U_CF_Key`. Checked against a live tenant's cached schemas
  (OperatingProfit*, StockInmPrice, LastBuyInmPrice, CommisionPercent… are real B1 fields).
- `DOC_DEFAULTS`, used when `settings.docFields[entity]` is absent: header `DocDueDate`, `NumAtCard`;
  lines `ItemCode`, `ItemDescription`, `Quantity`, `UnitPrice`, `LineTotal`. Not `Comments`: B1's
  Remarks often hold internal notes, so an admin opts it in.
- `portalSchema(schema, docFields)`: `ALWAYS` ∪ the header list, then a `DocumentLines` collection
  holding the line list. Fields come in setting order, so the list's columns and the form follow the
  admin's order. Anything denylisted, unknown to the schema, or a collection other than
  `DocumentLines` is dropped **on read**, so a stale setting cannot expose a field later added to the
  denylist.
- `pickable(schema)`: the picker's candidates, i.e. scalar header fields and `DocumentLines` fields,
  minus `ALWAYS`, `NEVER` and the denylist.

**Settings** (`portal_settings`, §6): P5 creates the table and writes only `docFields`. A module
`portal/settings.ts` loads it (absent row = `{}`) and saves the whole document. Internal
`portalSettings.get` (admin) returns the settings — each stored list cut to what `pickable` still
offers, so a removed UDF or a newly denied field cannot block the next save — plus, per entity, its
`pickable` header and line fields (label from metadata); `portalSettings.save` refuses an entity outside the four and any field
`pickable` does not offer. In `apps/web` Settings becomes two tabs, *SAP agent* and *Portal*. The
Portal tab holds the *Document fields* table: one row per entity, header and line counts ("Default"
while unset), *Edit* opening `ColumnsTab` (search, tick, reorder) in a dialog, *Reset* removing the
entity's entry, and one *Save*.

**Portal `docs` router** (member). Every read uses `portalSchema(entitySchema(…), settings)`:

- `metadata(entity)`: `toConstraints(portalSchema, undefined)` (read-only) plus `printable`.
- `rows(entity, query, cursor?, count?)`: `readRows` with `CardCode eq '<company>'` as its
  `extraFilter` and the cursor sealed to `portal:<companyId>`.
- `one(entity, key)`: the row with `CardCode` read alongside, `NOT_FOUND` unless it is the
  company's, then cut down to the schema (header fields and each line's fields). No ETag goes back.
- `print(entity, docEntry)`: the same CardCode check, then `printDocument`.
- `project(entity, docEntry)`: the project this document came from, or null. It walks back through
  the lines' `BaseType`/`BaseEntry` (17 → Orders, 15 → DeliveryNotes, 23 → Quotations), reading only
  `DocumentLines` per hop, three hops at most, until it reaches quotation DocEntries. Then it finds a
  `quoted` event carrying one of them, on a project with `portalCompanyId` = the seat's company. The
  first document is CardCode-checked. It is a separate call, so a slow walk never delays the page.

**Portal UI:**

- Side nav group *Documents* with the four entities, `/docs/$entity` and `/docs/$entity/$key`.
- `features/documents.ts` builds each page from the metadata the server sends: the list's columns
  and the form's fields are the schema's header fields in order, the Lines table its `DocumentLines`
  fields. This is D19's admin list deciding the page, not B1 metadata, so CLAUDE.md's "metadata never
  generates a page" still holds. Filters: `DocNum` (exact), `DocDate`, `DocumentStatus`. System
  views: Standard (newest first), Open.
- The Object Page is read-only (`writable: false`), with no record navigation. Header facets are
  status and total; header actions are **Preview** and, when `docs.project` answers, a **Project**
  link to `/projects/$id`.
- `UiSource` gains `client.entities.print`. The portal builds its `entities` source from `docs.*`, which
  replaces P4's throwing stub. `PrintActions` (Preview only) moves to `packages/ui` and prints
  through the source.
- `ProjectTimeline` document rows: *Open* (`onOpenDocument`) and *Preview* (a `canPreview` prop),
  on the portal for every seat, and on the internal page for admins, matching `entities.print`.

## 14. Starting point

The previous in-app portal is already gone. There is no `portal_client` table, no
`orpc/routers/portal.ts`, no portal routes under `apps/web`, no `portalSchema`, no `PORTAL_DOC` /
`PORTAL_LINE`, and no `scope: "portal"` switches. This spec adds `apps/portal` and a second server
process beside the internal app. It does not delete, migrate, or rewrite portal code.

What the build sits on:

- The internal app as it is: `apps/web`, `apps/server`, and the three procedure builders
  (`sessionProcedure`, `userProcedure`, `adminProcedure`). Portal handlers call the same modules
  the internal server already has: `calculateProject`, `lookups`, `b1`, `entity-read`,
  `doc-chain`, `printDocument`, `compileList`, `createQuote`.
- Shared UI still lives in `apps/web/src/shared/` and moves to `packages/ui` in P1. There is no
  portal data source to unpick; the seam is only so the portal can plug in later.
- `config_project.status` is `draft | quoted`. Events are a jsonb list of `created` and `quoted`.
  `config_model` has no `portal` flag. Those columns are added in §6.
- `calculateProject`, `liveEngine`, `quoteDraft` and `createQuote` are exported from
  `orpc/routers/configs.ts`, which imports the internal `auth.ts` through `orpc/base.ts`. P4 moves
  them out (§7.5) before the portal imports any of them.
- `ConfiguratorForm`, `ConfigTable` and their helpers live in `apps/web/src/components/configurator/`
  and read web's `useCurrency`. P4 moves them to `packages/ui` (§7.5).
- `B1Transport` has no document-action method, and `updateEntity` sends no
  `B1S-ReplaceCollectionsOnPatch`. Both are added in P4 (§7.3).
- `printDocument` checks the printable-entity allowlist and nothing else. The CardCode check is
  new, in the portal handler (§8). Document lists have no customer fence; the portal appends one
  after `compileList` (§13).
- Leftover `member.role = "client"` rows stay locked out of the internal app (`userProcedure`,
  the dead-end screen in `AppShell`). The new portal does not read them (D23). That lockout stays.
- CLAUDE.md describes the internal app only. The portal process, the host split and the portal
  builders are written in when that code lands.

## 15. Build phases

Each phase ends type-checked per project, with its tests green, and is usable on its own.

| Phase | Content |
|---|---|
| P0 Foundations | Host split (`APP_BASE_DOMAIN=app.…`, `PORTAL_BASE_DOMAIN`), Caddy two-zone config, `Mailer` seam (Resend + dev console logger, `RESEND_API_KEY`), the React Email layout and the verification and reset templates, internal email verification. |
| P1 `packages/ui` | Move `apps/web/src/shared/*` into `packages/ui`. The data-source seam is the plug the portal uses from P2 on; `apps/web` behaves identically. |
| P2 Portal skeleton | Portal entrypoint, portal Better Auth instance (`portal_session`, captcha), `schema/portal.ts`, builders, `me`, apex login / signup / lobby, `apps/portal` shell with NavigationLayout and branding. |
| P3 Invites & companies | Existing-BP invitations: *Invite to portal* + Portal section on the BP Object Page, guard, Portal → Invitations, accept page, company page (colleague invites on domains), domains, auto-join. Dev seed `scripts/seed-portal-company.ts`. |
| P4 Projects & lifecycle | Move the engine core out of the router and the configurator UI into `packages/ui` (§7.5). Widen `config_project.status`, `config_project_event`, `assertWritable`, model publish settings. Portal projects + server-side configurator + projection + pricing phases (§7.1–7.2), internal Requests inbox + Accept / Send back / Decline, revisions at transition (§7.4), Timeline (events + doc chains), comments. Quote response, reopen, re-quote (modify or new) and the quotation Close action (§7.3). |
| P5 Documents | Portal List Report / Object Page for the four entities, `docFields` settings + denylist, print, project link. |
| P6 New-client onboarding | *Invite new client* on the BP List Report + guard, onboarding section tree + `formSchema` (Countries, denylist), settings extras picker, submit → lead create (Series, `U_CF_Key`, addresses, contact). |
| P7 Files, mail, home | `project_file` + upload routes, notification routing (sales employee), client notification settings (tenant tab + per-company override, D27), tenant sender domain
(D29), home overview, logo upload. The quote response moved to P4. |

## 16. Verify before building

Checks against a live B1 and the installed Better Auth, done at the start of the phase that needs
them. Record any verified error strings in code comments, as the repo already does.

| Phase | Check |
|---|---|
| P2 | Better Auth 1.7.7: a second instance with `session.modelName: "portalSession"` over the hand-written table, sharing `user`, `account` and `verification`; sign-in on one zone creates a row only in its own session table. |
| P2 | `xms_edov` arrives in the Microsoft profile once configured as an optional claim. |
| P4 | `createQuote` for a `cLid` BP: B1 accepts a Sales Quotation for a lead (and which later documents it refuses until conversion). |
| P4 | `PATCH Quotations(n)` with `B1S-ReplaceCollectionsOnPatch: true` replaces `DocumentLines` (omitted lines are deleted, not kept), and `U_CF_Key` can be rewritten in the same PATCH. |
| P4 | The error a PATCH gets on a quotation that is closed, and on one whose lines were copied to an order (record both strings; the second may not show as `DocumentStatus = bost_Close`, so the open check must cover it). |
| P4 | `POST Quotations(n)/Close` on an open quotation, and what it answers for one already closed. |
| P6 | BP POST with `Series` and no `CardCode` returns the generated `CardCode`; `BPAddresses` and `ContactEmployees` are accepted inline in the same POST, and which keys each needs (`AddressName` + `AddressType`, contact `Name`); `U_CF_Key` on OCRD (alphanumeric, 64) filters as on quotations; `Countries` reads `Code` and `Name`. |
| P0 | Resend: `mail.<domain>` verifies (SPF, DKIM, MX for the return path), and `from` must match it exactly. The domain's **region is fixed when it is added**, so decide EU vs US first. A tenant display name with `&`, `,`, `"` or umlauts (`Müller & Söhne GmbH`) arrives intact once quoted in `from`. |
| P7 | Resend sender domains (D29): the plan's `domains.limit` (usage endpoint) covers the tenant count; a `sending_access` key with no `domainId` can send from every domain on the account; the exact 403 body for an unverified or removed domain, so the fallback matches on its code, not its message; what `domains.create` returns for a name another Resend account already holds (claiming it would break the tenant's own sending, so the handler must refuse and say so). |
| P7 | The `SalesPersons` entity exposes the employee email, and under which property name (read it from `$metadata`). |

## 17. Later: AI email designer

Not in v1. Admins design their tenant's email templates in a visual editor with AI help ("make the
quote mail shorter, add our hotline"). The likely shape: each React Email template from D28 stays
the code default; a tenant override is one jsonb document per template (the CLAUDE.md convention),
built on React Email's embeddable editor, with the variables each event provides (project, status,
link, branding) as the only data a template can name. The code templates should therefore take
**one typed props object per event**, so the designer can list exactly those variables later.
