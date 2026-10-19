# Path tenancy: two fixed hosts, customers inside the supplier's organization

**Date:** 2026-10-19
**Status:** Decided through Q&A and built the same day.
**Supersedes:** the host-based tenancy of `2026-10-07-portal-redesign.md` (D2, §3, the `portal_member`
table of §4.2 and §6, §4.3's "host → tenant"), and the sign-in host on the apex of the single sign-in
design (`confire.ai/login`, the `<slug>.app` / `<slug>.portal` zones, `lvh.me` in dev).

## 1. Goal

Deployment simplicity: no tenant subdomains, so no wildcard DNS, no wildcard certificates, no DNS-API
token and no custom Caddy build. One sign-in page for staff and customers. A customer is a member of
the supplier's Better Auth organization, told apart from staff inside it, and the sign-in sends each
person to the staff app or the portal by what they are.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| T1 | Hosts | `app.<DOMAIN>` (staff app **and** sign-in) and `portal.<DOMAIN>` (customer portal). The apex only redirects to `app.<DOMAIN>/login`. Two processes stay (spec D1: customer traffic never shares an event loop with staff). |
| T2 | Tenant | The **first path segment**: `app.<DOMAIN>/<slug>/…`, `portal.<DOMAIN>/<slug>/…`. The path decides; nothing else does. |
| T3 | Session | `session.activeOrganizationId` **remembers** the last tenant a request was scoped to (each app's `me` writes it). The dispatcher lands a fresh `/login` there. It never decides a request's tenant, so two tabs on two suppliers both stay correct. |
| T4 | Customer | A Better Auth `member` of the supplier's organization with role **`external`** and two extra fields: `cardCode` (→ `portal_company`, keyed (tenant, CardCode)) and `portalRole` (`owner`/`buyer`/`viewer`). `portal_member` is gone. Staff keep `owner`/`admin`/`member`. |
| T5 | Memberships | Staff of one workspace at most, a customer of any number of suppliers. One place → straight there; several → the session's active one, else "Where to?". |
| T6 | Sign-in host | `app.<DOMAIN>/login` (dev `http://localhost:5173/login`). |
| T7 | Data | No production data existed: `db:push` drops `portal_member`, seeds are re-run. The leftover `member.role = "client"` handling (portal spec D23) is removed with it. |
| T8 | Settings | One deployment setting, `DOMAIN`. Unset is dev (localhost). The SPAs carry no build setting. |

## 3. How a request finds its tenant

- **SPA:** `@confire/ui/host.ts` `slugOf(pathname)` reads the first segment (not one of the reserved
  names: the staff SPA's own pages `login`, `signup`, `forgot-password`, `reset-password`,
  `onboarding`; the server's `api`, `rpc`, `files`, `assets`; a few kept back). The router is created
  with `basepath: /<slug>`, so routes and links never name it; `location.pathname` inside the router
  is slug-free (TanStack's basepath is a rewrite). Moving to another tenant is always `hardRedirect`,
  so one page load holds one tenant's cache.
- **Calls:** the oRPC link sends the slug as `x-tenant`. A plain file route carries it in its path
  (`/files/<slug>/<id>`, `POST /files/<slug>/<projectId>`, `POST /files/<slug>/logo`), because a
  download is a link. The branding logo stays `/files/<id>`: mail links to it signed out.
- **Server:** `tenant.ts` `tenantSlug()` validates it; `orpc/base.ts` `membershipOf` joins it against
  a non-`external` member (staff), `portal/orpc/base.ts` `tenantOf` + `seatOf` against the `external`
  member row ⋈ its `portal_company` (customers). A forged `x-tenant` can only select an org the user
  is already in, with the role they already have there.

## 4. Better Auth

- `organization({ ac, roles: { owner, admin, member, external } })`: Better Auth's three roles
  unchanged, and `external` with no permission on any statement.
- `schema.member.additionalFields`: `cardCode`, `portalRole`, both `input: false`; regenerated into
  `schema/auth.ts` by `bun run auth:generate`. A company has no id: it is (organization, CardCode), so
  every match carries the organization — a CardCode alone names a company at every tenant. No FK (the
  generated schema cannot carry one); nothing deletes a company. `config_project.portalCardCode` is
  the same key with the project's `tenantId`.
- `organizationLimit` is a function counting **staff** rows only: a customer may still found their
  own workspace.
- **The organization endpoints are off but `create` and `check-slug`** (`disabledPaths`, computed
  from the plugin's endpoints so a new one starts off). Verified on 1.7.7: `list-members`,
  `get-full-organization` and `get-active-member-role` require only membership, so a customer could
  read the supplier's staff and every other customer; `update-member-role` lets an admin turn a
  customer into staff. Confire's procedures write members (`portal/members.ts`) and the path picks the
  organization, so the browser needs neither. `auth.api.*` is unaffected (disabledPaths is the HTTP
  router's), which is why `beforeUpdateOrganization` keeps guarding the slug.
- Invitations are Better Auth's `invitation` table (`portal_invitation` is gone): role `external`,
  plus `cardCode` (null = a new client until its onboarding submit), `portalRole` and
  `registerDomain`. An invitation joins the supplier's organization; it never creates one. Better
  Auth's `acceptInvitation` stays off — verified on 1.7.7 it inserts `{organizationId, userId, role}`
  only, before a new client has a company, and never checks an existing membership — so accept and
  submit end in `addPortalMember`, in the same transaction as the invitation's status. `role` is never
  a portal role: `owner` there would make Better Auth's accept create an organization owner. One open
  invitation per address is a lock on the organization row, not an index.
- One member row per (organization, user) is the exclusivity rule. The generated schema cannot carry a
  composite unique index, so `addPortalMember` locks the user row (`FOR UPDATE`) before it reads and
  writes: two concurrent joins run one after the other.
- `baseURL` is passed (`authUrl`), not read from `BETTER_AUTH_URL`. The cookie is on `DOMAIN`
  (`crossSubDomainCookies.domain`), host-only on `localhost` in dev. `trustedOrigins` is the portal's
  origin; `BETTER_AUTH_TRUSTED_ORIGINS` (read by Better Auth itself) adds a LAN IP in dev.

## 5. The dispatcher

`/login` signed in: a safe `redirect` (an absolute URL on one of the two origins) → the place
`sap.lobby` marks `active` → the only place → "Where to?". `?choose` skips straight to "Where to?"
(the portal's *Switch supplier*, which would otherwise land back on the active portal). No place at
all is workspace setup. Guards that refuse (a customer on the staff app, staff on the portal) send the
user to `/login`, and the dispatcher only ever picks a place the user has, so nothing ping-pongs.

## 6. Settings and deployment

| Was | Now |
|---|---|
| `BETTER_AUTH_URL`, `PORTAL_URL`, `APP_BASE_DOMAIN`, `PORTAL_BASE_DOMAIN`, `MAIL_DOMAIN` | `DOMAIN` (`https://app.<d>`, `https://portal.<d>`, cookie on `<d>`, mail from `mail.<d>`) |
| `VITE_AUTH_URL`, `VITE_*_BASE_DOMAIN` (baked into the image) | none: each SPA reads its origins off its own location |
| `PORT`, `PORTAL_PORT`, `WEB_DIST`, `PORTAL_DIST` | fixed: 3000 / 3001, `../web/dist` / `../portal/dist` |
| `APP_TRUSTED_ORIGINS` (a LAN IP in dev) | gone: a LAN origin cannot share the localhost cookie anyway |
| `CONFIRE_SECRET_KEY` (never passed by compose) | gone: SAP secrets are keyed off `BETTER_AUTH_SECRET` |
| `B1_PAGE_SIZE` (never set) | fixed at 100 (`ponytail:` a `sap_connection` column if a slow WAN needs less) |
| `CLOUDFLARE_API_TOKEN`, `CADDY_TLS=cloudflare`, a custom Caddy build | stock `caddy:2`, `CADDY_TLS=acme` (HTTP challenge) |

DNS is three A records (`@`, `app`, `portal`). Dev is `localhost:5173` (staff app + sign-in) and
`localhost:5180` (portal); Google accepts `http://localhost` redirect URIs.
