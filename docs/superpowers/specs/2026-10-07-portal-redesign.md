# Portal redesign: a separate app for external users

**Date:** 2026-10-07
**Status:** DRAFT. Q&A in progress; the decisions below are agreed, and §10 lists what is still open.
**Replaces:** the current portal (`role = "client"` members inside the manufacturer's org,
`portal_client`, `orpc/routers/portal.ts`, `apps/web/src/routes/_authed/portal/*`).

## 1. Goal

External users (the manufacturer's customers and prospects) get their own app on their own host
and their own server process, so external traffic never shares an event loop with internal users.
In that app they can:

- onboard in one of two ways: **invited** to an existing B1 business partner, or by **self-registering**
  with a business-partner form that becomes a B1 **lead** once an internal user approves it;
- create projects (one configuration each), submit them as requests, and follow each one on a **Timeline**
  that shows every event and every SAP document the project produced (quotation → order → delivery → invoice,
  each printable);
- browse their own SAP documents (quotations, sales orders, deliveries, invoices) in a List Report /
  Object Page built for external users, and print them.

Internal users accept requests and quote them, send them back for changes, or decline them.

## 2. Decisions so far

| # | Topic | Decision |
|---|---|---|
| D1 | Deployment | A separate SPA (`apps/portal`) and a separate server process, both from this repo and image, sharing Postgres. |
| D2 | Domain | One purchased domain (`confire.ai` or similar), split into **sibling zones**: internal on `app.confire.ai` + `<slug>.app.confire.ai`, portal on `portal.confire.ai` + `<slug>.portal.confire.ai`. `confire.ai` itself is the marketing site. |
| D3 | Identity | **One shared `user` table.** The same email can be internal at supplier A and external at supplier B, but never both inside the same tenant. |
| D4 | Customer org | A customer company is a Better Auth **organization in the portal instance**: one per tenant × CardCode. The company owner can invite colleagues. |
| D5 | Auto-join | A verified sign-in whose email domain is registered to a company on this tenant **joins that company with the lowest role**. Free-mail domains are blocked. Microsoft is keyed on the Entra tenant ID (`tid`), not on the `email` claim. |
| D6 | Sign-in | Email + password (with verification), Google, Microsoft. |
| D7 | Lead timing | Self-registration creates a **pending application in Confire**. The B1 lead (`CardType = cLid`) is created **only when an internal user approves it**. |
| D8 | SAP load | Portal document reads stay **live, with no rate limit**. `ponytail:` see §8. |
| D9 | Project | **One project = one configuration** (`config_project`, as today). |
| D10 | Internal outcomes | Accept (in review), Quote, Send back for changes, Decline (final). The quotation and its linked orders, deliveries and invoices, with their PDFs, appear on the timeline. |
| D11 | Internal edits | Internal users may change entries and batches before quoting. The timeline records each change **with a diff**, and the client sees it. |
| D12 | Timeline extras | Comments both ways (with internal-only notes), file attachments, email notifications. |

## 3. Hosts, cookies, processes

```
confire.ai                      marketing
app.confire.ai                  internal apex: login / signup / onboarding / lobby
<slug>.app.confire.ai           internal app            -> confire-server  (existing)
portal.confire.ai               portal apex: login / signup, company picker across suppliers
<slug>.portal.confire.ai        portal app for one supplier -> confire-portal (new process)
```

- **Cookies stay in their zone.** Internal: `crossSubDomainCookies.domain = ".app.confire.ai"`.
  Portal: `".portal.confire.ai"`. Neither zone's session cookie is ever sent to the other.
  The internal change is configuration only: `APP_BASE_DOMAIN=app.confire.ai`.
- **`tenant.ts` stays the only place a host is parsed.** It already takes `baseDomain` as a
  parameter; the portal process passes `PORTAL_BASE_DOMAIN`. Dev: `app.lvh.me` / `portal.lvh.me`
  (`*.lvh.me` resolves at any depth).
- **One Caddy, two wildcard sites** (`*.app.{$DOMAIN}`, `*.portal.{$DOMAIN}`), each proxying to its
  own upstream. Both certificates are wildcards, so both use the DNS challenge with one provider token.
- **Social login:** one Google client and one Microsoft client, each with two callback URLs
  registered (`app.confire.ai/api/auth/callback/*` and `portal.confire.ai/api/auth/callback/*`).
- **Process split:** the portal process mounts only the portal router and the portal auth instance.
  It imports the same server modules (`calculateProject`, `lookups`, `b1`, `entity-read`, `doc-chain`,
  `print`) instead of copying them.

## 4. Better Auth design

### 4.1 Two instances, one identity

| | Internal instance (exists) | Portal instance (new) |
|---|---|---|
| Process | `confire-server` | `confire-portal` |
| `user`, `account`, `verification` | shared | shared (same tables) |
| `session` | `session` | **`portal_session`** (`session.modelName`) |
| Cookie | prefix `better-auth`, `.app.<domain>` | prefix `confire-portal`, `.portal.<domain>` |
| `organization` plugin | manufacturer = org; `member` = employees | **customer company** = org → `portal_company`, `portal_member`, `portal_invitation` |
| Social | Google, Microsoft | Google, Microsoft (same OAuth clients) |
| `organizationLimit` | 1 (unchanged) | unlimited across tenants, but one company per user **per tenant** |

Separate session tables mean a portal session can never authenticate an internal request, even
when replayed by hand. Users and linked accounts are shared on purpose: one password and one Google
link per person. The cost is that a password reset on either side changes it for both.

### 4.2 Portal organization = customer company

- `schema.organization.additionalFields`: `tenantId`, `cardCode`, `cardType` (`cCustomer` | `cLid`),
  all `input: false`, so only the server writes them.
- `allowUserToCreateOrganization: false`. Companies are created server-side only, on an internal
  invite or on approval of an application.
- Roles via `createAccessControl`: `owner` (company admin: users, domains), `buyer` (create, edit and
  submit projects), `viewer` (read projects and documents). Auto-join uses `viewer`.
- `portal_company_domain (tenantId, domain, companyId)`, **unique on (tenantId, domain)**. This is
  the auto-join index, and the uniqueness constraint is what stops one domain mapping to two companies.
- `organizationHooks.beforeAddMember` enforces "one company per user per tenant" and "not an
  internal member of the same tenant".
- `requireEmailVerificationOnInvitation: true`.
- The tenant boundary is still **host → tenant → membership join**, exactly as `orpc/base.ts` does
  today. The portal builder joins `portal_member ⋈ portal_company` on `tenantId` from the host, and
  `cardCode` comes from that row. `session.activeOrganizationId` is never trusted for authorization.

### 4.3 Hooks used

| Hook | Use |
|---|---|
| `organizationHooks.beforeCreateInvitation` | Re-read the BP from SAP (existence, `CardType`) before an invite is minted. |
| `organizationHooks.afterAcceptInvitation` | Timeline/audit event; optionally sync a B1 `ContactEmployees` row (open). |
| `hooks.after` on `/callback/:id` and `/verify-email` | Domain auto-join (D5): host → tenant, verified email domain → `portal_company_domain` → `auth.api.addMember({ role: "viewer" })`. |
| `captcha` plugin (Cloudflare Turnstile) | `/sign-up/email`, `/sign-in/email`, `/request-password-reset`. |

## 5. Onboarding flows

### 5.1 Internal invite to an existing CardCode

1. An internal admin or owner picks a BP (value help over `BusinessPartners`, customers **and** leads)
   and enters an email.
2. The server finds or creates `portal_company` for (tenant, CardCode) and calls
   `createInvitation({ role: "owner" })`. `sendInvitationEmail` mails
   `https://<slug>.portal.confire.ai/accept/<invitationId>`.
3. The invitee signs in or signs up (any method in D6) and accepts. They are the company owner and
   can invite colleagues and register the company's email domains.

### 5.2 Self-registration

1. Sign up on `<slug>.portal.confire.ai` (D6), with the captcha check and email verification.
2. If the verified domain matches `portal_company_domain` on this tenant, the user auto-joins (D5) and is done.
3. Otherwise, the user fills in the **onboarding form**, built from `BusinessPartners` metadata using the
   fields an admin marked as required (§10, Q-form). This creates `portal_application (pending)`.
4. An internal user reviews the application and can:
   - **Approve as new lead:** POST `BusinessPartners` with `CardType = cLid` and the form data.
     The write is idempotent through a dedup UDF, the same pattern as `U_CF_Key` on quotations; a
     missing UDF refuses to run. Then create the company and the owner membership, register the domain
     unless it is free-mail, and email the applicant.
   - **Approve onto an existing BP:** the applicant is actually an existing customer, so bind to that
     CardCode instead of creating a duplicate lead.
   - **Reject** with a reason, emailed to the applicant.
5. The current invite's `CardType === "cCustomer"` check is relaxed to customers **or** leads.
   (B1 lets quotations be raised for leads; later documents need the lead converted to a customer
   in B1, which keeps the CardCode, so the binding survives.)

## 6. Project lifecycle

```
                 submit                 accept
   draft ───────────────▶ submitted ─────────────▶ in_review ──── quote ───▶ quoted ──▶ (SAP chain)
     ▲   ◀── withdraw ───     │                      │  │
     │                        │ send back            │  │ decline
     └──── edit, resubmit ── returned ◀──────────────┘  └──────────▶ declined (final)
                              ▲                                        ▲
                              └──────── send back / decline ───────────┘ (also from submitted)
```

- `withdraw` is only allowed while `submitted`. Once accepted, the client comments instead.
- `accept` records the assignee (an internal user). The client sees "In review" and the
  assignee's name.
- Internal edits in `in_review` (D11) write a `revised` event carrying `{ param: { from, to } }`
  for entries and batches.
- Every transition stays one guarded `UPDATE` on `status` (and `calculatedAt` where it matters), as
  today: the side that loses a race gets a clear error instead of a lost write.
- Internal-only configurations keep using just `draft` and `quoted`.

## 7. Timeline

Merged in time order:

- **Events** (new table, replacing the `events` jsonb): status transitions, revisions with their
  diffs, comments, attachments. Columns: `id, tenantId, projectId, at, kind, actorUserId,
  actorSide (internal|external), visibility (external|internal), note, payload jsonb`.
  This is a table rather than a jsonb column because comments are unbounded, visibility has to be
  filtered in SQL, and notifications fan out from the rows.
- **SAP documents**: `documentChain` from `b1DocEntry` (quotation → orders → deliveries → invoices),
  live, each entry linking to its Object Page and its PDF (`printDocument`, fenced by CardCode).

## 8. SAP load

Portal document lists, object pages, the chain walk and printing all go **live** through the
tenant's agent, with no limiter (D8).

`ponytail: live and unlimited. Process separation isolates CPU and the event loop, but not the agent
or the Service Layer. Upgrade path: (1) a per-tenant concurrency cap and short TTL cache in front of
portal reads; (2) a per-tenant document mirror in Postgres, the same pattern as config_masterdata_row.`

## 9. What gets deleted

- Server: `orpc/routers/portal.ts` (rebuilt for the new app; the fence helpers move with it),
  the `clientProcedure` and `client` role branches in `orpc/base.ts`, `portalClientsRouter`.
- DB: `portal_client`, and every `member` row with `role = "client"`.
- Web: `routes/_authed/portal/*`, `routes/accept.tsx`, `components/portal/*`, `features/portal/*`,
  the `client` branches in `_authed.tsx` and `AppShell.tsx`, the "Portal clients" card in Settings.
- Scripts and tests: `seed-portal-client.ts`, `invites.test.ts`.
- **Kept and reused:** the allowlist-as-schema fence (`portalSchema`/`projectDoc`), the CardCode
  filter clause, `toPortalModelDef`/`toPortalCandidate`, `readRows`/`readOne`, `documentChain`,
  `printDocument`, `calculateProject`.

## 10. Open questions

- Q-mail: which transactional email provider, and what sender identity.
- Q-files: where attachments are stored.
- Q-prices: whether external users see engine prices before an internal quote.
- Q-cardcode: how a new lead's CardCode is numbered.
- Q-form: what the onboarding form covers (header fields, addresses, contact person) and how admins define it.
- Q-ui: whether the List Report / Object Page shells are extracted into a shared package or copied into `apps/portal`.
- Q-docs: a fixed field allowlist for portal documents, or one admins configure.
- Q-scope: portal home page, online quote acceptance, branding, languages, which models each company may configure.
