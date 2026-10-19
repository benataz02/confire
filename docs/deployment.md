# Deploying Confire

One host, one `docker compose --profile full up`, one domain. Everything below uses `confire.ai` as
the example; substitute your own. Nothing in the code changes per environment, and nothing is baked
into the image — the domain is one `.env` line plus DNS (see `docker-compose.yml`'s header and
`Caddyfile`).

```
                               DNS (three A records)
                                        │
             confire.ai  ─┐             │
         app.confire.ai  ─┤   :443    ┌─────────── your VPS ──────────────────────────┐
      portal.confire.ai  ─┴─────────▶ │ Caddy ──▶ server :3000  (sign-in + staff app) │
                                      │       └─▶ portal :3001  (customer portal)     │
                                      │             └──── Postgres 17 (volume) ───────┘
                                      └──────────────────────│────────────────────────┘
                                                             │ HTTPS + Bearer secret (+ CF Access)
                                                             ▼
                         <customer>.agents.<separate-domain>  (Cloudflare Tunnel)
                                                             │
                              customer network: confire-agent ──▶ SAP B1 Service Layer
```

| Host | Serves |
|---|---|
| `app.confire.ai` | sign-in, sign-up, the `/login` dispatcher, `/api/auth`; the staff app of workspace `<slug>` at `/<slug>/` |
| `portal.confire.ai` | the customer portal of workspace `<slug>` at `/<slug>/`, and the mail logo |
| `confire.ai` | redirects to `app.confire.ai/login` (until a marketing site exists) |
| `mail.confire.ai` | Confire's sending domain (Resend) — no website |

The workspace is the path, not the host: there are no per-tenant names, so no wildcard DNS and no
wildcard certificate.

---

## 1. Domain

1. **Buy the domain.** Any registrar and any DNS host work: Caddy gets its certificates over the HTTP
   challenge, so it needs no DNS API.
2. **Decide the domain once.** `DOMAIN` is not baked into the image, but it is in every OAuth redirect
   URI and the Resend domain. Changing it later means re-registering those.
3. **Buy a second, separate domain for agent tunnels** (e.g. `confire-agents.net`) — see §6. The
   session cookie is set on `.confire.ai`, so every host under it receives every user's session. A
   tunnel hostname terminates on a *customer's* machine and therefore must never live under
   `confire.ai`.

## 2. Hosting

A single Linux VPS running Docker is what the compose file is built for.

- **Size:** 2 vCPU / 4 GB RAM / 40 GB SSD is comfortable to start (Bun ×2, Postgres, Caddy). The image
  build (`bun install` + two Vite builds) is the peak; 2 GB RAM can OOM during it.
- **Provider:** any with a static public IPv4 (Hetzner, DigitalOcean, OVH, AWS Lightsail…). Pick the
  region near your customers — and match it to your Resend region (§4) for data-residency answers.
- **OS setup:**
  ```bash
  # Debian/Ubuntu
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker $USER            # log out/in
  # Firewall: only SSH, HTTP, HTTPS
  sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
  ```
  Docker bypasses ufw for published ports, which is why compose binds Postgres, `:3000` and `:3001` to
  `127.0.0.1` only. Keep it that way: a public `:3000` would serve plain HTTP.
- Disable SSH password login; use keys.

## 3. DNS

On Cloudflare, keep the records **DNS only (grey cloud)**: Caddy terminates TLS itself and answers the
Let's Encrypt HTTP challenge on `:80`.

| Type | Name | Content |
|---|---|---|
| A | `confire.ai` (`@`) | VPS IPv4 |
| A | `app` | VPS IPv4 |
| A | `portal` | VPS IPv4 |
| AAAA | same three | VPS IPv6 (optional, only if the VPS has one) |
| CAA | `@` | `0 issue "letsencrypt.org"` (optional hardening) |

Plus the mail records from §4.

Caddy issues exactly **three certificates**, one per name, all three issued as soon as the stack is up
and port 80 is reachable. A tenant never gets a name of its own — and so never a certificate, which
would publish your customer list in the Certificate Transparency logs.

## 4. Mail

There are up to three separate concerns. Keep them on separate names so their DNS never collides.

### 4a. Confire's outgoing mail — Resend on `mail.confire.ai` (required)

Sign-up verification, password resets and staff notifications come from `notify@mail.confire.ai`
(always `mail.<DOMAIN>`). Sign-in **requires a verified email**, so without
this nobody can sign up in production.

1. Create a Resend account; *Domains → Add* `mail.confire.ai`. **Choose the region first** (EU
   `eu-west-1` vs US `us-east-1`) — it is fixed when the domain is added.
2. Add the records Resend shows in Cloudflare (grey cloud). They look like:

   | Type | Name | Content |
   |---|---|---|
   | TXT | `resend._domainkey.mail` | `p=MIGfMA0…` (DKIM) |
   | MX | `send.mail` | `feedback-smtp.<region>.amazonses.com` priority 10 |
   | TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` |

   Copy the exact values from Resend, not from here.
3. Add DMARC for the whole domain:

   | Type | Name | Content |
   |---|---|---|
   | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@confire.ai` |

   Start with `p=none`, watch the reports for a few weeks, then move to `p=quarantine`.
4. Click *Verify* in Resend and wait for green.
5. *API Keys → Create*, permission **Sending access**, domain `mail.confire.ai`. This is
   `RESEND_API_KEY`. (Sending-only on purpose: a leak cannot touch domains or keys.)

### 4b. Tenant sender domains (optional)

Client-facing portal mail can go out from a tenant's own subdomain (e.g. `notify@mail.mueller-gmbh.de`,
Settings → Portal). That needs a second key, **Full access**, as `RESEND_ADMIN_KEY` — only the
sender-domain handlers use it; without it Settings → Portal shows sender domains as unavailable. The
tenant adds the DNS records Confire shows them on their own domain; until it verifies (or if Resend
refuses it), mail falls back to `mail.confire.ai`.

### 4c. Human mailboxes (optional, separate provider)

`notify@` has no inbox. For `support@confire.ai`, `dmarc@confire.ai`, etc., use Google Workspace,
Fastmail, Zoho, Microsoft 365… on the **apex**: their MX + SPF (`v=spf1 include:<provider> ~all`) +
DKIM go on `confire.ai` itself. That never collides with Resend, which lives on `mail.` and
`send.mail.`. (Cloudflare Email Routing — free forwarding to an existing inbox — is enough for a
start.)

## 5. Sign-in providers (optional)

Email + password works with nothing extra. For social sign-in, one redirect URI per provider:

- **Google** (Cloud Console → Credentials → OAuth client, *Web application*):
  `https://app.confire.ai/api/auth/callback/google` (dev: `http://localhost:5173/api/auth/callback/google`)
- **Microsoft** (Entra ID → App registrations, *Accounts in any organizational directory and personal
  accounts*): `https://app.confire.ai/api/auth/callback/microsoft`. Under *Token configuration*, add the
  optional claim **`xms_edov`** — a Microsoft address only counts as verified with it.

An unset client ID just leaves that button dead (Better Auth logs a warning at boot).

## 6. SAP agent on the customer's network

The agent never needs an inbound firewall hole: `cloudflared` dials out.

1. In **your** Cloudflare account, on the separate agent domain (§1.3), create a Tunnel per customer
   (*Zero Trust → Networks → Tunnels*), public hostname e.g. `acme.confire-agents.net` →
   `http://localhost:4000`. Copy the tunnel token.
2. Protect it with **Cloudflare Access**: an application for `*.confire-agents.net` with a
   *Service Auth* policy, and a service token per customer (Client ID + Secret). The cloud sends these
   as `CF-Access-Client-Id/Secret` on every call.
3. On the customer's Windows server (with network reach to the Service Layer):
   ```powershell
   bun --cwd apps/agent build             # on your machine → confire-agent.exe
   # copy confire-agent.exe, deploy\install-service.ps1 and an agent.json to the server, then elevated:
   .\deploy\install-service.ps1 -TunnelToken <token>
   curl http://localhost:4000/health
   ```
   `agent.json` holds the SAP credentials (they never reach the cloud) and a long random `secret`
   (`openssl rand -base64 32`).
4. In the staff app, the tenant's SAP connection gets: agent URL `https://acme.confire-agents.net`,
   the agent `secret`, and the Access client ID/secret. Stored encrypted (`crypto.ts`).

## 7. First deploy

On the VPS:

```bash
git clone <repo> confire && cd confire
cat > .env <<'EOF'
DOMAIN=confire.ai
BETTER_AUTH_SECRET=...            # openssl rand -base64 32
RESEND_API_KEY=re_...
# RESEND_ADMIN_KEY=re_...         # §4b, tenant sender domains
# GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
# MICROSOFT_CLIENT_ID= / MICROSOFT_CLIENT_SECRET=
EOF
chmod 600 .env

docker compose --profile full build
docker compose up -d db
# Schema: drizzle-kit push is the only migration path. Answer its prompts on destructive changes.
docker compose --profile full run --rm server bun --cwd packages/db drizzle-kit push
docker compose --profile full up -d
docker compose logs -f caddy          # watch the three certificates get issued
```

Then: open `https://app.confire.ai/signup`, verify the email, create the first workspace, and you land
on `https://app.confire.ai/<slug>/`. Configure the SAP connection (§6) and Settings → Portal.

**Back up `BETTER_AUTH_SECRET`.** It signs sessions and is also the key that encrypts stored SAP agent
secrets. Losing or rotating it makes every stored `sap_connection.secret` unreadable.

## 8. Updates

```bash
git pull
docker compose --profile full build
docker compose --profile full run --rm server bun --cwd packages/db drizzle-kit push   # if the schema changed
docker compose --profile full up -d
```

There is a few seconds' downtime while the two containers restart; Caddy holds connections.

## 9. Operations

- **Backups:** nightly `pg_dump` off the box, plus `.env`.
  ```bash
  # crontab -e
  0 3 * * * cd ~/confire && docker compose exec -T db pg_dump -U confire -Fc confire > ~/backups/confire-$(date +\%F).dump
  ```
  Ship `~/backups` to object storage (restic/rclone to S3, Backblaze, Hetzner Storage Box) and test a
  restore once. Project files are `bytea` rows, so the dump is the whole state.
- **Caddy's volume** (`caddy_data`) holds certificates; losing it just means re-issuing (watch Let's
  Encrypt rate limits if you recreate it repeatedly).
- **Logs:** `docker compose logs -f server portal`. Set Docker's log rotation
  (`/etc/docker/daemon.json`: `{"log-driver":"local"}`).
- **Uptime:** an external check (UptimeRobot, Better Stack) on `https://app.confire.ai/login` and
  `https://portal.confire.ai/api/auth/ok`.

## 10. Checklist

- [ ] Domain bought; separate agent domain bought
- [ ] VPS with Docker, ufw 22/80/443, SSH keys only
- [ ] A records: `@`, `app`, `portal` (grey cloud on Cloudflare)
- [ ] Resend: `mail.<domain>` verified in the right region, sending key created
- [ ] DMARC record on the apex
- [ ] OAuth redirect URIs (+ `xms_edov` for Microsoft), if used
- [ ] `.env` written, `chmod 600`, backed up with `BETTER_AUTH_SECRET`
- [ ] Schema pushed, stack up, three certs issued
- [ ] Sign-up mail arrives (check spam score at mail-tester.com)
- [ ] Nightly `pg_dump` shipped off-box; one restore tested
- [ ] Per customer: tunnel + Access service token + agent installed + SAP connection set

## Known gaps in the deploy files

Worth fixing before a real launch:

1. **Postgres password is `confire`, hard-coded** in `docker-compose.yml`. The database is reachable
   only on loopback and the compose network, but read it from `.env` (`POSTGRES_PASSWORD` and
   `DATABASE_URL`) anyway.
2. The root `db:push` script reads `../../.env`, which the image does not contain (`.dockerignore`), so
   call `drizzle-kit` directly in the container, as above.
