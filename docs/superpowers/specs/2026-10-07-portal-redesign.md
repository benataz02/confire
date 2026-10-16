# Customer portal: a separate app for external users

**Date:** 2026-10-07
**Status:** Spec agreed through Q&A. Not built yet; §16 lists what must be checked against a live
B1 and Better Auth before the matching phase starts.
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
| D10 | Internal outcomes | Accept (in review), Quote, Send back for changes, Decline (final). The quotation and its linked orders, deliveries and invoices, with their PDFs, appear on the timeline. |
| D11 | Internal edits | Internal users may change entries and batches before quoting. The timeline records each change **with a diff**, and the client sees it. |
| D12 | Timeline extras | Comments both ways (with internal-only notes), file attachments, email notifications. |
| D13 | Mail | **Resend**, behind a `Mailer` seam (Resend in production, a console logger in dev). Sender `notify@mail.<domain>`, the tenant's name as display name, the tenant's sales address as `Reply-To`. Because a mailer now exists, **email verification is switched on for internal sign-ups too** (this removes the `ponytail` in `signup.tsx`). |
| D14 | Files | Attachments in **Postgres `bytea`** (`project_file`), with a per-file size cap. Upload and download are plain Hono routes, not oRPC: the RPC body cap is 2 MB. `ponytail:` move to S3-compatible storage (Bun's `S3Client`) when DB size or backups hurt. |
| D15 | Prices | **Per published model**: `portalPricing = "indicative"` (unit price and total per batch after calculate) or `"request"` (no numbers until quoted). The server omits the numbers, not the page. |
| D16 | Lead CardCode | A **B1 numbering series**: an admin picks the BP `Series` in portal settings, and the create payload sends `Series` and omits `CardCode`. |
| D17 | Onboarding form | The **BP-create ObjectPage** with an onboarding section tree: **code-default** header fields plus **admin extras** (`BusinessPartners` fields from metadata, UDFs included, each required or optional), **addresses** (bill-to and ship-to → `BPAddresses`) and a **contact person** (the user → `ContactEmployees`). A hard denylist in code no extra can expose (§5.3). |
| D18 | UI code | **Extract `packages/ui`**: ListReport, ObjectPage, CFL, views and metadata merge, shared by `apps/web` and `apps/portal`. The portal declares its own external-user features. |
| D19 | Doc fields | **Admin-configurable** per entity (header and line fields, UDFs included), stored per tenant and enforced server-side. A new `portalSchema` projects B1 metadata down to that list. A **hard denylist** in code (cost, gross profit, margins, purchase prices) that no setting can expose. |
| D20 | v1 scope | Portal home overview; online quote acceptance (accept or decline the B1 quotation: a timeline event plus an internal notification, and internal staff create the order); tenant branding (logo, name, accent colour on the portal and in emails). **Not in v1:** multiple languages. |
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
4. calls `addPortalMember` with role `viewer` (§4.2) and writes a `joined` audit event.

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
  **Drop** `events`. The jsonb list (`created`, `quoted`) is replaced by `config_project_event`.
- `config_model`: **add** `portal` (boolean, default false; D21) and `portalPricing`
  (`"indicative" | "request"`, default `"request"`).

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
  each entry linking to its portal Object Page and its PDF. The portal print handler calls
  `printDocument` only after the document's CardCode matches the company. `printDocument` itself
  stays the printable-entity allowlist. Before `quoted` there is no chain.
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
    existing configuration process page.
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
  quote by status; a Timeline section with comment box, internal-only toggle and upload.
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
| `projects` | `rows`, `get`, `create`, `update`, `remove`, `run`, `lookups`, `queryPage`, `submit`, `withdraw`, `resubmit`, `respondQuote` | member (read) / buyer (write) |
| `timeline` | `list`, `comment` | member |
| `docs` | `metadata`, `rows`, `one`, `print`, `chain` | member |
| `home` | `overview` | member |

The Hono routes `POST /files/:projectId` and `GET /files/:id` use the same session and fence, with
a size cap on the stream.

Portal responses name their fields in mappers, the same way the internal routers do.
`toPortalModelDef` is new: it projects a published model down to what an external user may see
(parameters, lookups, batches; cost expressions stay out). `toPortalCandidate` names the candidate
fields the page reads and omits prices when `portalPricing` is `"request"`.

**Internal server** additions: `requests.{rows, accept, sendBack, decline}`,
`timeline.{list, comment}` (with `visibility`), `portalInvitations.{rows, inviteExisting, inviteNew,
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
- **Writes:** the quotation (unchanged path) and the lead BP create (§5.4). `ENTITY_PROFILES` stays
  the rule for internal entity edits. The lead create is its own handler with its own field list,
  `formSchema` (code defaults ∪ admin extras, ∩ BP metadata, minus the denylist), plus the
  server-set `CardType`, `Series`, `BPAddresses`, `ContactEmployees` and `U_CF_Key`.

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
| P4 Projects & lifecycle | Widen `config_project.status`, `config_project_event`, portal projects + configurator + pricing modes, internal Requests inbox + Accept / Send back / Decline, revisions with diff, Timeline (events + doc chain), comments. |
| P5 Documents | Portal List Report / Object Page for the four entities, `docFields` settings + denylist, print, project link. |
| P6 New-client onboarding | *Invite new client* on the BP List Report + guard, onboarding section tree + `formSchema` (Countries, denylist), settings extras picker, submit → lead create (Series, `U_CF_Key`, addresses, contact). |
| P7 Files, mail, home | `project_file` + upload routes, notification routing (sales employee), client notification settings (tenant tab + per-company override, D27), tenant sender domain
(D29), quote response, home overview, logo upload. |

## 16. Verify before building

Checks against a live B1 and the installed Better Auth, done at the start of the phase that needs
them. Record any verified error strings in code comments, as the repo already does.

| Phase | Check |
|---|---|
| P2 | Better Auth 1.7.7: a second instance with `session.modelName: "portalSession"` over the hand-written table, sharing `user`, `account` and `verification`; sign-in on one zone creates a row only in its own session table. |
| P2 | `xms_edov` arrives in the Microsoft profile once configured as an optional claim. |
| P4 | `createQuote` for a `cLid` BP: B1 accepts a Sales Quotation for a lead (and which later documents it refuses until conversion). |
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
