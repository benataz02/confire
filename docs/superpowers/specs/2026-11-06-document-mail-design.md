# Document mail — design

2026-11-06. Status: built 2026-11-06 (§8 lists where the build differs).

## 1. Why

Staff create quotations, orders, deliveries and invoices in Confire, then send them to the customer
by hand from B1 or Outlook. Confire should send them itself, on create: the document's PDF from the
workspace's print engine (`printDocument`, `apps/server/src/print.ts` — the print spec §1 named this
the next step), **from the supplier's own Microsoft 365 mailbox** so the customer's replies reach the
supplier, to the recipient B1's own *Send* would pick. When the document belongs to a portal project,
the client's portal user also hears of it (bell + Confire's notification mail) and finds it, PDF
included, on the project's timeline.

## 2. Goals, non-goals, anti-goals

**Goals**
- A **"Notify the client"** switch on every Confire page that creates a sales document:
  - the quote page at the end of a configuration (`QuoteCreatePage` → `configs.createQuote`);
  - the Quotations and Orders create page (`/b1/$entity#create` → `entities.create`);
  - the Copy to draft (`/b1/$entity#copy` → `entities.copy`: Orders, DeliveryNotes, Invoices).
- Switched on, one post does up to three things:
  1. **document mail** — from the tenant's Microsoft 365, to the document's SAP contact, PDF attached;
  2. **timeline entry** — when the document belongs to a project: which document, to whom, when, the
     PDF as sent; on the staff timeline and, for a portal project, on the portal's;
  3. **portal notification** — when that project is a portal project: bell + Confire mail to the
     client's portal user, by that user's own switches.
- **Settings → Email**, a new admin-only tab: connect the Microsoft 365 mailbox; per document type,
  the switch's default and the address it sends from.

**Non-goals**
- Google, plain SMTP, or a tenant domain on Resend. Microsoft only, for now.
- B1 email groups (`EmailGroups`): B1 itself uses them only when a user picks one by hand (§3).
- Editable subject/body templates, a mail signature, CC/BCC.
- Documents posted by the assistant or over MCP (`b1.post`, `b1_write`, `b1_copy`, `post_quotation`):
  no switch, no mail.
- Sending an existing document later (a *Send* action on the Object Page), or re-sending after a
  failure. The failure is reported (§5.5); the user sends it by hand.
- Attachments of 3 MB or more (Graph's inline limit, §3).
- A mailbox per staff member. One mailbox per workspace.
- Documents created in B1 directly.

**Anti-goals** (would be a failure even if mail went out)
- A tenant's business documents leaving from Confire's sending domain. Confire's mail
  (`mail.<DOMAIN>`, Resend) stays for notifications only.
- The Microsoft token reaching a browser, or the tenant's mailbox becoming a general mailer: no
  procedure takes a recipient, subject, body or attachment from the client (§5.10).
- A mail on a request's critical path, or a failed mail undoing or failing the post.
- A double send. Graph's `sendMail` has no idempotency key, so nothing retries a send on its own.
- A silent miss: a document with no email in SAP says "not sent" on the post's toast.

## 3. Facts

Verified 2026-11-06 on hera's live Service Layer (b1s/v2, `$metadata` and data, GETs only):

- `EmailGroups` (key `EmailGroupCode`, `EmailGroupName`) and `EmailGroupsService_GetList` exist.
- `BusinessPartners`: `EmailAddress`, `ContactPerson` (the *name* of the default contact),
  `LanguageCode`, and `ContactEmployees[]` with `InternalCode`, `Name`, `E_Mail`, `Active`,
  `EmailGroupCode` (`"-1"` = none), `BlockSendingMarketingContent`.
- Every marketing document header has `ContactPersonCode` → `ContactEmployees.InternalCode`; `0` = none.
- **Nothing links a document type to an email group** — no such field anywhere in `$metadata`. B1's
  *Send* fills in the document's contact person; a group only when the user ticks "use E-mail group"
  and picks one ([SAP Help 9.1](https://help.sap.com/saphelp_sbo91/helpdata/en/45/06da6cd8696c30e10000000a114a6b/content.htm),
  [Seidor](https://SeidorB1Support.helpdocs.com/sales/sap-business-one-how-to-simplified-email-for-sending-documents-to-customers)).
- **B1's mail server settings are not in the Service Layer** (no SMTP/mailer type in `$metadata`), so
  Confire cannot reuse B1's mail configuration.
- hera names its groups by purpose ("Facturación", "Pedidos de venta"; a few groups are email
  addresses). Nearly every recent document carries a contact. Customer C006 has no contacts and no BP
  email, so its documents carry `0` and nothing can be sent to it.
- **Confire's own posts carry a contact, though no write path sets one.** B1 fills in the BP's default
  contact on a Service Layer create. Quotation 260003 (C168, posted by `createQuote`, `U_CF_Key` set)
  carries 878, which is C168's default contact "FACTURAS". The orders Confire copied from quotations
  (260002, 260003, 260005, "Created from Quotations … in Confire") carry their quotation's contact.
  `unverified`: whether a copy keeps a base contact that differs from the BP default, or resets it to
  the default. Every sample's quotation used the default.
- A `$crossjoin` returned `Active` as `"Y"`; an entity read returns the enum name (`"tYES"`). Accept
  both.
- `E_Mail` is free text: expect several addresses separated by `;` or `,`.

Microsoft (from Microsoft's docs and Message Center; re-check the details at build time):

- Delegated OAuth 2.0 authorization code flow against `https://login.microsoftonline.com/organizations/oauth2/v2.0/{authorize,token}`
  (work and school accounts only), scopes `offline_access User.Read Mail.Send Mail.Send.Shared`.
  The refresh token lasts about 90 days of inactivity, and each refresh returns a new one.
- `POST https://graph.microsoft.com/v1.0/me/sendMail` sends as the signed-in account;
  `POST /v1.0/users/{address}/sendMail` sends as a shared mailbox the account has *Send As* rights
  on (`Mail.Send.Shared`). The body is `{ message: { subject, body: { contentType: "HTML", content },
  toRecipients: [{ emailAddress: { address } }], attachments: [{ "@odata.type": "#microsoft.graph.fileAttachment",
  name, contentType, contentBytes }] }, saveToSentItems: true }`, and the answer is `202`. The mail
  lands in Sent Items. Inline attachments must be under 3 MB; 3–150 MB needs a draft and an upload
  session ([Graph](https://learn.microsoft.com/graph/api/message-post-attachments)).
- Customers' IT will usually have to approve the app for their organisation (admin consent), and
  most will only do so for a **publisher-verified** app.
- Why not SMTP: Exchange Online switches off password (Basic) auth for SMTP submission by default
  from December 2026 ([MC786329](https://mc.merill.net/message/MC786329?from=1&to=4)).

## 4. Decided (by the user)

- **Recipients: same as B1's Send** — the document's contact person.
- **The tenant brings its own email: Microsoft 365, through OAuth.** Confire's mail is for portal
  notifications only.
- **Two channels, one switch.** The document always goes from the tenant's mailbox to the SAP
  contact. If the document belongs to a portal project, the client's portal user also gets Confire's
  bell and notice. A portal user who is also the SAP contact gets both mails, and can switch
  Confire's off on the portal.
- **Timeline:** a "sent" entry — which document, to whom, when, its PDF to open — on the staff side
  and the portal side.
- **Configuring email sending is admin-only, in Settings.** Notification switches stay personal and
  unchanged: staff in Settings → Notifications, clients on the portal's notifications page, where the
  new events appear.
- **The admin card holds a per-document-type default for the switch.**

## 5. Design

### 5.1 The mailbox connection

One row per tenant, `document_mail` (new schema file in `packages/db`, re-exported, with its
migration), written only by a new `apps/server/src/document-mail.ts`:

| column | |
|---|---|
| `tenant_id` | primary key |
| `settings` | jsonb `{ types: Partial<Record<DocEntity, { notify: boolean; from?: string }>> }` (the CLAUDE.md jsonb-document convention); absent type = switch off, send from the account |
| `account` | the connected mailbox's address (`/me` `mail`, else `userPrincipalName`); null = not connected |
| `ms_tenant_id` | the customer's Entra tenant (`tid`) |
| `refresh_token` | `encryptSecret` (`crypto.ts`), as the agent's secret is |
| `connected_by`, `connected_at` | who connected it, when |
| `error` | the last token failure (`invalid_grant` …): the card's *Reconnect* |
| `updated_at` | |

**Connect** is two plain GET routes on the staff process, beside `files.ts` (the Vite dev proxy already
forwards `/api`):

- `GET /api/mail/microsoft/connect?tenant=<slug>` — signed in, and admin/owner of that tenant through
  the membership join (`tenant.ts` reads the slug; the same rule as `adminProcedure`). It stores a
  single-use state in Better Auth's `verification` table (identifier `mail-oauth:<random>`, value
  `{ tenantId, userId }`, 10 minutes — the pairing code's pattern), then redirects to Microsoft's
  authorize URL with `prompt=select_account`.
- `GET /api/mail/microsoft/callback` — consumes the state, checks again that the user is admin there,
  exchanges the code, reads `GET /v1.0/me?$select=mail,userPrincipalName`, stores the row, and
  redirects to `/<slug>/settings?tab=email`. A failure (consent refused, admin approval needed, state
  expired) redirects there too, with a code the card turns into words. On "admin approval needed"
  the card offers the admin-consent link
  (`https://login.microsoftonline.com/organizations/adminconsent?client_id=…`).

**The app registration** is Confire's existing Microsoft sign-in app (`MICROSOFT_CLIENT_ID`/`_SECRET`,
`auth.ts`). It gains the delegated permissions above and the redirect URIs
`https://app.<DOMAIN>/api/mail/microsoft/callback` and `http://localhost:5173/api/mail/microsoft/callback`.
Scopes are requested per flow, so sign-in keeps asking for what it asks for today.

**Using the token:** `graphToken(tenantId)` redeems the refresh token, stores the new one, and keeps
the access token in memory until about 5 minutes before it expires. An `invalid_grant` writes `error`
and fails the send with "reconnect the mailbox". **Disconnect** clears `account` and the token.
Microsoft has no way to revoke one refresh token without signing the user out everywhere, so the card
says to remove Confire under the account's Microsoft *My Apps* as well.

### 5.2 Settings → Email

A new `email` tab in `apps/app/src/routes/$slug/settings.tsx`, admin-only like `agent`, `portal` and
`assistant`. It holds one card:

- **The connection:** the account, who connected it and when, the error, and *Connect* / *Reconnect*
  / *Disconnect*. Connect is a link to the route above, a full page load.
- **The four types** (Quotations, Orders, DeliveryNotes, Invoices), one row each: *Notify the client*
  on by default (Switch), and *Send from* (optional email input, placeholder the account).

Procedures, in a new router: `documentMail.settings` and `documentMail.save` / `disconnect`, all
`adminProcedure`. A separate `documentMail.status` is `userProcedure` (`{ connected, defaults }`) for the
create pages. *Send from* is checked as an email address only; whether the account may send as it is
Microsoft's answer, which reaches the failure notice (§5.5).

### 5.3 The switch on the create pages

- `ObjectPage` gets a slot in its create footer, before the Create button, for the switch (a UI5
  `Switch` or `CheckBox`, label "Notify the client"). The three create pages fill it for the four
  document types only.
- **It is drawn only when the workspace has a connected mailbox** (`documentMail.status`), with the
  type's default as its initial state.
- `configs.createQuote`, `entities.create` and `entities.copy` take `notify?: boolean`. Absent means
  false: the server never defaults it on. `entities.create` refuses `notify` for an entity outside
  `PRINTABLE`.
- Their answer gains `mail`: `{ to: string[] }`, or `{ skipped: "NO_EMAIL" | "NOT_CONNECTED" }`, or
  `null` when `notify` was off. The recipients (§5.4) are read during the request, one BP read, so
  the toast can say "sending to facturaprov@agui.com" or "not sent: no email in SAP for this
  customer". Printing and sending run after the response.
- `createQuote` sends whenever the call itself performs the `quote` transition. That includes its two
  `reused: true` paths: the key is found on the open quotation, or a quotation with our key is found
  before the create. Both are reached only when an earlier call failed before its transition, so
  nothing was sent then. The early return (already `quoted` in this company) sends nothing. A re-quote
  in place (`mode: "updated"`) sends the revised quotation.

### 5.4 Recipients

`recipientsOf(doc, bp)`, pure and tested, plus the one read that feeds it:
`BusinessPartners('<CardCode>')` selecting `EmailAddress`, `LanguageCode`, `ContactEmployees`.

1. The contact whose `InternalCode` is the document's `ContactPersonCode`, if it is active (`tYES` or
   `Y`) and has an `E_Mail`.
2. Otherwise the BP's `EmailAddress`.
3. Otherwise none: `NO_EMAIL`.

Each address field is split on `;` and `,`, trimmed, and invalid entries are dropped. The language is
`mailLang(bp.LanguageCode)`. The document's `CardCode` and `ContactPersonCode` come from the posted row
(create and copy answer the representation); `createQuote`'s update and dedup paths read them.

### 5.5 Sending

All of this runs after the post commits, off the request path, tracked like `notify.ts`'s
`background()` so tests can await it (export one settled-promise for both). The **project side runs
whether or not the document mail goes out**: a portal client still finds the document and its PDF on
the timeline when SAP has no email for them, or when Microsoft refuses the send.

0. Nothing to do — no recipients (`NO_EMAIL`, or `NOT_CONNECTED` because the mailbox was disconnected
   since the page loaded) and no project (§5.6) — means no print and nothing else.
1. `printDocument(tenantId, entity, docEntry, row)` → the PDF.
2. If there are recipients and a connected mailbox: Graph `sendMail` as the type's *Send from*
   (`/users/{from}/sendMail`) or as the account (`/me/sendMail`). To = the recipients, the PDF
   attached, `saveToSentItems: true`. A PDF of 3 MB or more is refused with its own message
   (`// ponytail:` upload session when one shows up).
3. For each project the document belongs to (§5.6), in one transaction: a `project_file` row (the PDF;
   visibility `external` for a portal project) and a `document_sent` event. Its payload is
   `{ entity, docEntry, docNum, company, fileId, to, error? }`, where `to` lists the addresses the
   mail went to (empty when it did not go) and `error` says why not (`NO_EMAIL`, `NOT_CONNECTED`, or
   Microsoft's or the token's message). The poster is the actor, internal side, visibility `external`.
   A new writer exported by `project-lifecycle.ts` writes it, so that module stays the only writer of
   `config_project_event` and of a project's files. The event is written after the send, so it never
   claims a mail that did not leave. The send's error lives in the payload and not in `mailError`,
   which stays the column for Confire's own notification mail (`notify.ts`).
4. After step 3 commits, the portal notification (§5.7). It goes whether or not step 2 did: the
   document and its PDF are on the timeline either way.
5. Any failure — print, token, Graph — sends a staff notification `document.mail_failed` to the
   poster (§5.7). `NO_EMAIL` is not a failure: the toast already said it. A print failure ends the
   run: no file, no event, no portal notice. Nothing retries.

### 5.6 Which project a document belongs to

- `createQuote`: its own project, internal or portal.
- `entities.copy`: walk back from the copy's source documents through their lines'
  `BaseType`/`BaseEntry` to quotations. This is the walk `quotationsBehind` already does in
  `portal/orpc/docs.ts`: move it, unfenced, beside `documentChain` in `doc-chain.ts`, and keep the
  portal's seat check on its first hop. Then take the projects whose `quoted` events name one of those
  quotations in the connector's company (`payload.company ?? b1Company`, as `projectDocuments` does).
  Several projects (one order merging quotations from two projects) each get their own entry.
- `entities.create`: none.
- An internal configuration (`portalCardCode` null) gets the staff timeline entry and nothing else. A
  portal project also gets the portal's entry and the notification.

### 5.7 Notifications

`NOTIFICATION_TYPES` (`notifications.ts`), with i18n in both SPAs:

- Client, group `portal`: `project.order`, `project.delivery`, `project.invoice`. Quotations keep
  `project.quoted`, unchanged.
- Staff, new group `documents`: `document.mail_failed`, to the poster only (bell + Confire mail,
  `notify@`).

`notify.ts` maps a `document_sent` event to its type by `payload.entity` (Quotations → none,
`quoted` covers them). Who is eligible is the existing client rule (`creator`: the project's creator
while still seated at its company). The mail is Confire's client mail: the tenant's branding, its slug
as sender, the company's language, and a link to the project on the portal. It has **no attachment**;
the PDF is on the timeline, and the document mail carries it.

### 5.8 The timeline

- `PROJECT_EVENT_KINDS` gains `document_sent`, and its payload joins `ProjectEventPayload`.
- `ProjectTimeline` draws it as "Invoice 240991 sent to facturaprov@agui.com", or "Invoice 240991"
  when `to` is empty, with the PDF as a file link (`/files/<slug>/<fileId>`, as `file` events). Staff
  also see `error` ("not emailed: no email in SAP" / "not emailed: …"). `externalPayload` strips
  `error` for the portal.
- The live SAP document rows stay as they are.

### 5.9 The document mail

A React Email template in `apps/server/src/mail/`, written like a business letter rather than a
notification: no Confire frame, no button. "Please find attached our invoice 240991", signed with the
tenant's brand name (`tenantBrand`). English or Spanish by §5.4's language, in the wording the
portal's Spanish uses (usted, "oferta"). Subject: `<Brand> — Invoice 240991` / `Factura 240991`. It
is rendered to HTML with `render` and sent through Graph, not `sendMails`: that seam stays Resend's.

### 5.10 Security

- The refresh token is encrypted at rest and never selected into an answer; procedures return the
  account and the status only.
- Connect, save and disconnect are admin-only. The OAuth state is single-use, bound to (tenant,
  user), and expires in 10 minutes.
- The send takes its recipients only from SAP (§5.4) and its attachment only from `printDocument`. No
  procedure accepts a To, subject, body or file, so a staff member cannot use the tenant's mailbox as
  a general mailer.
- The scopes send and nothing else: no `Mail.Read`.

### 5.11 Tests and dev

- `bunfig.toml`'s preload also drops `MICROSOFT_CLIENT_SECRET`. Without a secret, the Graph send goes
  to the console and an outbox the tests read, as `mailer.ts`' `devOutbox` does: tests never reach
  Microsoft.
- `recipientsOf`: contact found, inactive, without email, several addresses, the BP fallback, none.
- One server test per channel: a copy to an invoice under a portal project with `notify` writes the
  file, the event, the `project.invoice` bell and the document mail. A failing print writes no event
  and sends `document.mail_failed` to the poster.

### 5.12 Docs and ops

- **CLAUDE.md**: the Mail section (two senders: Confire's for notifications, the tenant's Microsoft
  365 for documents) and the notification catalog.
- **DEPLOY.md**: the app registration's permissions and redirect URIs, publisher verification, and
  what a customer's IT approves.

## 6. Left to the builder

Names (table, module, router, the `ObjectPage` slot), the toast and card wording, the Settings tab's
layout, the timeline entry's look within `ProjectTimeline`'s existing style, the test layout, and
plain `fetch` for Graph and the token endpoint (no SDK).

## 7. Calls made in the conversation, for review

- No contact email → the BP's general `EmailAddress`. B1's Send would leave the recipient empty.
- One Microsoft app for sign-in and mail. Per-type *Send from*. No admin-editable text.
- The switch is drawn only when a mailbox is connected, so a workspace without one also gets no
  portal notice for orders, deliveries and invoices.
- `project.quoted` keeps firing on every quote, switch or not: it is the status change the client
  answers. The switch governs a quotation's document mail only.
- The timeline keeps the PDF as sent (a `project_file`), not a fresh print.
- The poster hears of a failure by bell (and Confire mail). Nothing retries; there is no re-send.
- Assistant and MCP posts send nothing.
- The project side (PDF on the timeline, portal notice) runs even when the document mail does not go
  (no email in SAP, Microsoft refuses). The timeline entry is written after the send, so it only says
  "sent to …" for a mail that left.
- `createQuote` sends on every call that performs the `quote` transition, including its two recovery
  paths after a lost B1 response.
- No change to Confire's write paths for the contact person: B1 fills it in (§3).

## 8. As built

- Names: `document_mail` (`packages/db/src/schema/document-mail.ts`, migration 0017),
  `apps/server/src/document-mail.ts` (routes, token, settings, `recipientsOf`, `afterPost`),
  `mail/document-mail.tsx` (the letter and the staff notice), router `documentMail.*`,
  `addDocumentSent` in `project-lifecycle.ts`, `ObjectPage`'s `createControls`, the app's
  `useNotifyClient`, `components/settings/EmailSettings.tsx`.
- **`openid` is added to the scopes** (§3, §5.1): without it the token endpoint returns no ID token,
  and `ms_tenant_id` (`tid`) would have to be read off Graph's access token, which Microsoft says not
  to rely on. It asks for nothing beyond "sign you in".
- **`mail` can also answer `{ skipped: "FAILED" }`** (§5.3): the BP (or, for createQuote's update and
  dedup paths, the document) could not be read after the post. The toast says so; the project side
  still runs, its entry's `error` being SAP's message; it is not a `document.mail_failed`.
- Verified on hera 2026-11-06: `BusinessPartners('C168')?$select=EmailAddress,LanguageCode,ContactEmployees`
  answers (B1 rejects selecting `Items`' `ItemPrices`, not this collection); `Active` reads `"tYES"`.
- The admin-consent link carries `state=consent:<slug>` and returns to the callback, which sends the
  admin back to Settings → Email (`?mail=consented`).
- The attachment and the timeline file are named in the customer's language (`Factura 240991.pdf`).
- `notificationsSettled()` now waits until nothing is in flight, since a document mail's run starts
  its event's notification.

