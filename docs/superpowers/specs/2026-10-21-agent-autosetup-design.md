# Agent auto-setup: one download, one code, the SAP password

**Date:** 2026-10-21
**Status:** Decided through Q&A; not built.
**Replaces:** DEPLOY.md §8's per-customer runbook, the agent step of `routes/onboarding.tsx`, the
Settings → SAP agent form, and the Bun agent in `apps/agent/src`.

## 1. Goal

Connecting a customer's SAP B1 to Confire is about ten manual steps today, spread over three places:
the Cloudflare dashboard (Access hostname, tunnel, token), Confire (agent URL, Access ID and secret,
a generated agent secret to copy), and the customer's SAP server (a Bun build, a hand-written
`agent.json`, a PowerShell script, a separate `cloudflared` install). Every secret is copied by hand
between two of them.

After this work, install day is: in Confire, *Download for Windows* and read off a pairing code; on the
SAP server, run the exe, answer the SAP questions, type the code. Confire's page turns green on its
own. Nobody opens the Cloudflare dashboard per customer, and nobody sees or copies a secret.

**Anti-goals** — this fails even if it works when:
- SAP credentials reach the cloud (they stay on the box, as today);
- an agent hostname can go live without the Access guard in front of it (DEPLOY.md §8: hostnames under
  `<DOMAIN>` receive the session cookie);
- a forgotten old server keeps serving part of a tenant's traffic after a move.

## 2. Decisions

Marked **(user)** where the user decided, **(call)** where it is the designer's call made during the
Q&A and open to correction.

| # | Topic | Decision |
|---|---|---|
| A1 | Transport | Cloudflare Tunnel from the customer's SAP server, as today. **(user)** |
| A2 | Cloudflare work | Confire's server creates the tunnel, its route, the Access guard and the DNS record through the Cloudflare API, at pairing time. Guard first, DNS last. **(user)** |
| A3 | Secrets onto the box | A one-time **pairing code** shown in Confire, typed into the agent. The agent redeems it for its agent secret and tunnel token. **(user)** |
| A4 | SAP settings | Asked by a wizard in the agent, on the box, each tested with a real login before it is saved. Credentials are never sent to Confire. **(user)** The company database *name* is (A16). |
| A5 | Beas, printing | Configured in the same wizard the same way (URL, credentials…), each **skippable**. SAP B1 is not skippable. **(user)** |
| A6 | `beasEnabled` | Removed. Confire always builds the Beas transport; an agent without Beas answers 503 "not configured", as `/print` already does. **(user: "remove beas active check")** |
| A7 | Binary | **Go**, one self-installing Windows exe that runs as a real Windows service and runs `cloudflared` as its child. **(user: Go acceptable; Windows only)** |
| A8 | Linux | Not now. A planned next step (B1 on HANA runs on SUSE): OS-specific code stays behind `_windows.go` files so Linux is an addition, not a restructure. **(user)** |
| A9 | Dev | The agent runs in the foreground on the dev machine against a test B1, started by `bun run dev`, and pairing works locally without Cloudflare. **(user: "a dev server for the agent")**; the shape below is **(call)** |
| A10 | Thin agent | The agent holds the SAP sessions and forwards an **allowlist** of requests; Service Layer URLs are still built only by `packages/b1/src/query.ts`, now on the cloud side. Most future changes ship with Confire and need no agent update. **(call)** |
| A11 | Agent hostname | Stays `<slug>-agent.<DOMAIN>`, guarded by **one Access application per tenant** using one reusable Service Auth policy. **(call)** — see §11 for the separate-domain alternative. |
| A12 | Access service token | One for all tenants, so it moves from `sap_connection` to server env. The two Access fields leave every form. **(call)** |
| A13 | Updates | Manual in v1: running a newer exe replaces the installed one and keeps its config. Settings shows "update available". No auto-update (it would let Confire push code onto customers' SAP servers; that needs code signing and a trust story first). **(call)** |
| A14 | Distribution | The exe is built by CI into the app image and served by Confire at `/download/confire-agent.exe`. The bundled build *is* "latest". **(call)** |
| A15 | Existing connections | None in production. No compatibility with the Bun agent's wire protocol; a dev tenant re-pairs. **(call — confirm)** |
| A16 | Company identity | A workspace is bound to **one** B1 company, set by its first pairing (`sap_connection.company_db`). Confire assumes it never changes (`b1DocEntry` re-quotes PATCH in place, `portal_company` is keyed by CardCode, `localCurrency`/`entity_meta`/the masterdata cache are never reset), so a switch is **refused**, never silently followed. Supporting a deliberate switch (cache reset, portal review) is later work. **(call)** |

## 3. Install day

**In Confire** (onboarding's agent step, or Settings → SAP agent → *New pairing code*):

1. *Download for Windows* — a plain link, also typeable on the server: `https://app.<DOMAIN>/download/confire-agent.exe`.
2. A code, e.g. `K7QM-2XPA`, valid **60 minutes**, single use. *New code* replaces it.
3. A waiting state that polls until the agent answers, then goes green (onboarding: into the workspace).

**On the SAP server** (double-click; the exe's manifest asks for elevation):

```
Confire agent setup

SAP B1 Service Layer
  URL [https://localhost:50000]:
  Company database: ALUMIGRAF
  User [manager]:
  Password: ****
  Testing… ✓ logged in to ALUMIGRAF

Beas — configure? [y/N]: y
  URL: …   User [manager]:   Password [same as SAP B1]:
  Testing… ✓

Printing (SAP API Gateway) — configure? [y/N]: y
  URL [https://<SL host>:60020]:   Company database [ALUMIGRAF]:   User [manager]:   Password [same as SAP B1]:
  Layout for Quotations (blank = not printable): QUT20009
  Layout for Orders: RDR20011   Layout for DeliveryNotes: …   Layout for Invoices: …
  Testing… ✓

Pairing code from Confire: K7QM-2XPA
  ✓ paired with workspace "acme"

Installing service… ✓   Tunnel… ✓ connected
Done. Confire now shows this server as connected. You can close this window.
```

- A failed test re-asks that section; the wizard never saves an untested service. The code is asked
  **last** so a long SAP section cannot eat its validity, and a mistyped code costs only the code.
- Defaults pre-fill from earlier answers (Beas/print reuse B1's company DB, user, and "same as SAP B1"
  password). Self-signed certificates are accepted on all three services (stock installs ship them);
  the wizard does not ask.
- **Running it again** (double-click, or `confire-agent setup`) on an installed box offers: change SAP B1 /
  Beas / printing, re-pair, uninstall — and, when the running exe is newer than the installed one,
  update. Changing a service needs no new code; re-pair does.

## 4. Pairing (server)

**Issuing a code.** `sap.pairingCode` — onboarding through `ownedTenant` (as `sap.connect` today),
Settings through `adminProcedure` (as `sap.reconfigure` today). 8 characters from an unambiguous
alphabet (Crockford base32), shown as `XXXX-XXXX`. Stored in Better Auth's existing **`verification`**
table (identifier `agent-pair:<sha256(code)>`, value = tenantId, `expiresAt` = +60 min) — no new table.
Issuing a code deletes the tenant's earlier unredeemed codes.

ponytail: no rate limit on redeem. 40 bits against a handful of live codes is ~10¹¹ guesses on
average; add a per-IP limit if codes ever live longer or get shorter.

**Redeeming.** `POST /api/agent/pair` on the staff process — a plain Hono route like `files.ts` (the
caller is the Go agent, not a browser, and the code is its only credential). Body
`{ code, port, version, companyDb }`. In order:

1. Look up the hashed code; refuse if missing or expired. Refuse if the tenant already has a
   `company_db` and this one differs (A16) — the message names both, and the code stays valid.
2. **Provision** (§5) — or, when Cloudflare is not configured, skip it: `agentUrl = http://localhost:<port>`, no token.
3. Generate the agent secret server-side (32 random bytes), upsert `sap_connection`
   (`agentUrl`, `secret` encrypted by `crypto.ts`, `tunnelId`, `companyDb`, `status: ok`).
4. Delete the code. Return `{ slug, agentUrl, secret, tunnelToken | null }`.

A failure before step 4 leaves the code valid so the agent can retry; provisioning is idempotent
(§5). Two concurrent redeems of one code must not both succeed (lock the verification row, or delete
it with `RETURNING` and restore it on failure — builder's choice).

`needsAgent` keeps its meaning (no `sap_connection` row). The onboarding page does not trust the row:
it waits for `sap.agentStatus` to answer.

## 5. Cloudflare provisioning (server)

New module `apps/server/src/cloudflare.ts`. Configured by env; **`CF_API_TOKEN` unset = dev**, and
the module returns the localhost answer of §4 step 2 — the same seam as mail (Resend when its key is
set, the console otherwise). `DOMAIN` set but `CF_API_TOKEN` unset is a misconfigured deployment:
pairing is refused, so production can never store a localhost `agentUrl`.

| Env | What |
|---|---|
| `CF_API_TOKEN` | Account: *Cloudflare Tunnel Edit*, *Access: Apps and Policies Edit*; Zone (`<DOMAIN>`): *DNS Edit* |
| `CF_ACCOUNT_ID`, `CF_ZONE_ID` | ids, so nothing is looked up per pairing |
| `CF_ACCESS_POLICY_ID` | the reusable Service Auth policy that includes the `confire-cloud` service token |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | that service token; `agentPost` sends them on every agent call (were per-tenant columns) |

`provisionAgent(slug, port, oldTunnelId)` → `{ agentUrl, tunnelId, token }`, host = `<slug>-agent.<DOMAIN>`:

1. **Guard:** ensure a self-hosted Access application for the host exists (name `Confire agent <slug>`,
   policy `CF_ACCESS_POLICY_ID`). Created once per tenant and kept across re-pairs.
2. **Tunnel:** `POST /accounts/{id}/cfd_tunnel` `{ name: "confire-<slug>-<n>", config_src: "cloudflare" }`;
   `PUT …/configurations` with ingress `host → http://localhost:<port>`, then the catch-all `http_status:404`.
3. **DNS:** upsert the proxied CNAME `host → <tunnelId>.cfargotunnel.com` (update the record if it exists).
4. **Retire** `oldTunnelId` if any: clean up its connections, delete it. The old box's `cloudflared`
   stops authenticating, and its agent secret was already replaced — the "forgotten old server" anti-goal.
5. Token: from the create response, or `GET …/cfd_tunnel/{id}/token`.

Guard before DNS is the order of this function, not a runbook step. Retrying after a partial failure
must not leave orphan tunnels piling up (e.g. reuse a tunnel created by a failed attempt) — builder's
choice how.

ponytail: one Access app per tenant; Cloudflare's default limits are 500 Access applications and 1,000
tunnels per account. Past that: multi-domain apps (50 hostnames each), or §11's separate domain with one
wildcard app.

## 6. The agent (Go, `apps/agent`)

**One binary**, commands:

| Command | Does |
|---|---|
| *(none / double-click)*, `setup` | the wizard of §3: first install, or modify an installed one |
| `run` | foreground server, no service; what dev uses (`--config <path>`) |
| `uninstall` | stop and remove the service, the files, the config |
| *(started by the Service Control Manager)* | service mode: the server plus the `cloudflared` child |

`--server <url>` overrides the Confire origin the wizard pairs with (default `https://app.confire.ai`;
dev passes `http://localhost:3000`).

**Windows layout.** The exe copies itself to `C:\Program Files\Confire\Agent\`, extracts the embedded
`cloudflared.exe` beside it, writes `C:\ProgramData\Confire\agent.json` (ACL: Administrators and
SYSTEM only; plain JSON as today — ponytail: DPAPI later if a customer asks), logs to
`C:\ProgramData\Confire\logs\` (bounded size), and registers the service through
`golang.org/x/sys/windows/svc/mgr` with restart-on-failure. Service mode uses `x/sys/windows/svc` — a
plain exe under `sc.exe` is killed by the Service Control Manager after ~30 s (error 1053), which is
likely why today's `install-service.ps1` has never worked as a service.

**Config** (`agent.json`, written by the wizard; dev writes it by hand):

```json
{
  "port": 4000,
  "secret": "<from pairing>",
  "tunnelToken": "<from pairing, absent in dev>",
  "b1":   { "url": "https://localhost:50000", "companyDb": "ALUMIGRAF", "user": "manager", "pass": "…" },
  "beas": { "url": "…", "auth": "session", "companyDb": "…", "user": "…", "pass": "…" },
  "print": { "url": "https://sap:60020", "companyDb": "…", "user": "…", "pass": "…",
             "layouts": { "Quotations": "QUT20009", "Orders": "RDR20011" } }
}
```

`beas` and `print` are absent when skipped. `basePath` (B1 `/b1s/v2/`; Beas its own) and `auth`
(session login or basic) carry over from today's `ServiceConfig`; how the wizard asks for Beas's is the
builder's choice.

**Listening.** `127.0.0.1:<port>` only — `cloudflared` is on the same machine, so the agent no longer
answers the LAN at all. `port` defaults to 4000; the wizard picks a free one if 4000 is taken, and
sends it at pairing so the tunnel's ingress matches.

**Tunnel.** In service mode the agent starts `cloudflared tunnel --no-autoupdate --metrics 127.0.0.1:<m> run`
with the token in the child's `TUNNEL_TOKEN` env (never on the command line), restarts it if it exits,
and stops it on service stop. The wizard's "Tunnel… ✓ connected" waits on `cloudflared`'s `/ready`.
`cloudflared`'s version is pinned in the repo; CI downloads that release, checks its SHA-256, and
embeds it (`go:embed`), so install day needs no download a proxy could block.

**Sessions.** Ported behaviour, all load-bearing (CLAUDE.md, `packages/b1`): one in-flight login per
service (N cold requests = one licence slot), every `Set-Cookie` kept whole (`net/http/cookiejar` —
`ROUTEID` survives), re-login once on 401, logout on stop, request timeouts, B1's error body parsed into
`{ status, code, message }` as `B1Error.parse` does. The API Gateway client keeps `api-gateway.ts`'s
rules (its own `POST /login`, `ExportPDFData?DocCode=`, `DocKey@`, the three accepted response shapes).

### 6.1 Wire protocol

Replaces the operation endpoints (`/b1/entity-set`, `/b1/create`, …).

| Route | Auth | Body → reply |
|---|---|---|
| `GET /health` | none | `{ ok, version, companyDb, services: { b1: true, beas: bool, print: string[] } }` (`print` = entity sets with a layout) |
| `POST /{b1\|beas}/request` | Bearer | `{ method, path, headers?, body? }` → `{ status, data }`; `data` is parsed JSON, or the text for a non-JSON reply (`$metadata`) |
| `POST /print` | Bearer | unchanged: `{ entity, docEntry }` → `{ pdf, fileName }` |

Errors keep today's envelope `{ error: { status, code, message } }`; Beas or print not configured →
503. The bearer check stays a constant-time compare of hashes.

**Company check (A16).** `agentPost` sends the workspace's `company_db` as `X-Confire-Company` on every
Bearer call; an agent whose B1 company differs answers **409** naming both, before touching SAP. So a
company changed in the wizard after pairing stops every call with a clear message rather than quoting
into the wrong company. The wizard warns when the company of a paired box is changed. One header, no
extra round trip.

**The allowlist** (`/request`), equal to what today's agent permits — a leaked agent secret still
cannot issue arbitrary Service Layer calls:

- `path` is relative and is resolved under the service's base; anything resolving outside it is refused
  (this subsumes today's `readNext` origin check). `Login`/`Logout` are refused — the agent owns the session.
- `GET`: any path. `POST`: a single segment (`Quotations`, `SeriesService_GetDocumentSeries`), or
  `<Set>(<key>)/<Action>` only for allowlisted actions (`Quotations/Close`). `PATCH`, `DELETE`: `<Set>(<key>)` only.
- Headers passed through: `Prefer`, `If-Match`, `B1S-ReplaceCollectionsOnPatch`. Nothing else. The
  agent sets `Accept`/`Content-Type` itself, as the TS `ServiceLayer` does today (including whatever
  `fetchMetadata` sends for `$metadata`).

ponytail: parity with today. Writes could be narrowed to the sets the cloud actually writes
(`entity-profiles.ts`, doc-copy targets, the service calls) once that list is stable.

**Cloud side.** `DirectTransport`'s logic (paths from `query.ts`, `pageHeader`, lifting `@odata.etag`,
`Prefer: return-representation`) becomes the cloud's: the natural shape is `DirectTransport` over an
agent-backed `request()` in place of `ServiceLayer`, so `RemoteTransport`'s eight wire methods collapse.
`agentPost` stays the one place that adds the bearer, the Access headers and the timeout. The TS
`ServiceLayer` then serves no runtime path — delete it unless a script still needs it.

## 7. Confire changes

**Schema** (`sap_connection`, a migration): drop `access_client_id`, `access_client_secret`,
`beas_enabled`; add `tunnel_id text` (null in dev) and `company_db text` (A16). Pairing codes need no
table (§4).

**Server.**
- `sap.connect`, `sap.reconfigure`, `sap.agent` go; `sap.pairingCode` (§4) and `sap.agentStatus` come.
  `agentStatus` calls the agent's `/health` through `agentPost`'s headers and, when it answers, does
  the `CompanyService_GetAdminInfo` read `tenantCurrency` already does, so "green" means B1 really
  answered (and fills `localCurrency`). Returns `{ connected, version, latestVersion, services, lastOkAt, error }`.
- `b1.ts`: `tenantConnector` always builds the Beas transport; `transportFor`'s "Beas is not enabled"
  becomes the agent's 503. `TenantAgent` loses `beasEnabled`; `agentTarget` reads the Access pair from env.
- `seed-agent.ts`/`upsertSapConnection` and `scripts/seed-dev.ts` follow the new columns.
- Reserve the new top-level path names (`download`; check `api`) in `tenant.ts`.

**Onboarding agent step** (`routes/onboarding.tsx`): download link + code + expiry + *New code*, then
the waiting state; the URL, secret, Access and Beas fields go, and so does `lib/agent-secret.ts` (both
its callers go). *Not now — sign out* stays. Texts through i18n (`messagebundle_*.properties`);
remove the obsolete `SHELL_AUTH_*`/`ADMIN_*` agent keys.

**Settings → SAP agent** (`$slug/_admin/settings.tsx`): a status card — connected or the error, agent
version (and "update available" against the bundled build), B1 ✓, Beas ✓/—, printing with its
document types, last OK — plus *New pairing code*, which says plainly that pairing a server replaces
the current one.

## 8. Dev

- `apps/agent` becomes a Go module. `dev:agent` runs `go run ./apps/agent run --config apps/agent/agent.json`
  (hand-written, untracked, as today). Go must be installed on dev machines. The Windows-only files build
  only on Windows, so `run` works on the Linux dev box.
- With `CF_API_TOKEN` unset, `go run ./apps/agent setup --server http://localhost:3000 --config …`
  exercises the whole pairing flow locally: no tunnel, `agentUrl = http://localhost:<port>`.
- `apps/server/test/mock-agent.ts` speaks the new wire: it reads `{ method, path }` and parses the
  entity set, key and `$filter` out of `path` for its in-memory store.

## 9. Build and release

- CI (`.github/workflows/deploy.yml` / the Dockerfile): build `GOOS=windows GOARCH=amd64` with
  `-ldflags "-X main.version=<v>"` — an **orderable** version (e.g. `YYYY.MM.DD.<CI run number>`; a commit
  SHA cannot say "newer"; dev builds say `dev`) — the pinned `cloudflared` embedded, into the image; the staff
  server serves it at `/download/confire-agent.exe` (public: the exe holds no secret) and knows its
  version for "update available".
- The exe is **unsigned**: Windows SmartScreen will warn on first run. DEPLOY.md says so; signing
  (e.g. Azure Trusted Signing) is later work.

## 10. Verification

- Go: one test for the allowlist (methods × paths × headers, the outside-base and `Login` refusals) —
  it is the security boundary. One for the session's single in-flight login.
- Server: pairing redeem in dev mode (code → row → code gone; expired and reused codes refused);
  `cloudflare.ts` against a stubbed `fetch` asserting call order (Access before DNS, old tunnel retired
  last); the existing B1/print tests green over the rewritten mock agent; `sap-connect.test.ts` rewritten
  for the new procedures.
- By hand once, on a real Windows SQL Server B1 box with Cloudflare configured: the §3 walk-through,
  then `curl https://<slug>-agent.<DOMAIN>/health` refused by Access, a B1 list loading in Confire, a
  re-pair from a second machine retiring the first.

## 11. Out of scope, and what was weighed

- **Linux / B1 on HANA** — A8.
- **Several company databases on one agent** — one agent, one company, as today.
- **Auto-update, code signing, DPAPI-encrypted config, reading print layouts from B1** — later.
- **Separate agent domain** (e.g. `confire-agents.net`, one wildcard Access app made once): removes
  the cookie exposure by construction and the per-tenant Access app. Not taken: a new domain to own,
  and A11 already makes the guard a step the code cannot skip.
- **Agent dials Confire over a WebSocket** (no Cloudflare at all): rejected by A1.

## 12. Docs to update

- **DEPLOY.md §8:** becomes the one-time Cloudflare setup (service token, reusable Service Auth policy,
  the API token and the env of §5) and the customer's steps of §3. The per-customer dashboard steps go.
- **CLAUDE.md:** the agent paragraph (Go, thin, allowlist, pairing), `b1.ts` (no `beasEnabled`), the
  `packages/b1` notes that describe `DirectTransport` running on the agent.
- `apps/agent/deploy/install-service.ps1` is deleted.
