# Deploying Confire

One Hetzner VPS, one `docker compose --profile full` stack, one domain. Every push to `main` is
checked, built into an image and deployed by GitHub Actions over SSH (§8). Everything below uses
`confire.ai` as the example; substitute your own. Nothing in the code changes per environment, and
nothing is baked into the image — the domain is one `.env` line plus DNS (see `docker-compose.yml`'s
header and `Caddyfile`).

```
                               DNS (three A records)
                                        │
             confire.ai  ─┐             │
         app.confire.ai  ─┤   :443    ┌─────────── Hetzner VPS ───────────────────────┐
      portal.confire.ai  ─┴─────────▶ │ Caddy ──▶ server :3000  (sign-in + staff app) │
                                      │       └─▶ portal :3001  (customer portal)     │
  GitHub Actions ── ssh deploy@ ────▶ │             └──── Postgres 17 (volume) ───────┘
   (image in ghcr.io)                 └──────────────────────│────────────────────────┘
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

**In order:** domains (§1) → Hetzner server (§2) → DNS (§3) → Resend, early, because verification
waits on DNS (§4) → GitHub secrets (§8.1) → checkout and `.env` on the server, first
deploy (§7) → sign-in providers (§5) and backups (§9) → per customer, the SAP agent (§6). §10 is the
same list as a checklist.

---

## 1. Domain

1. **Buy the domain.** Any registrar and any DNS host work: Caddy gets its certificates over the HTTP
   challenge, so it needs no DNS API. Putting the zone on Cloudflare (free plan) keeps it next to the
   agent domain below, which must be there.
2. **Decide the domain once.** `DOMAIN` is not baked into the image, but it is in every OAuth redirect
   URI and the Resend domain. Changing it later means re-registering those.
3. **Buy a second, separate domain for agent tunnels** (e.g. `confire-agents.net`) — see §6. The
   session cookie is set on `.confire.ai`, so every host under it receives every user's session. A
   tunnel hostname terminates on a *customer's* machine and therefore must never live under
   `confire.ai`.

## 2. Hosting — Hetzner Cloud

The compose file is built for a single Linux VM running Docker. On Hetzner that is a Cloud server (not
a dedicated "Robot" machine).

### Which server

- **Location:** Falkenstein or Nuremberg (DE) or Helsinki (FI) for European customers — and match it
  to your Resend region (§4) for data-residency answers.
- **Type:** x86. **CX33** (4 vCPU, 8 GB, 80 GB) is comfortable; **CX23** (2 vCPU, 4 GB, 40 GB) is
  enough to start, because the server never builds — CI does (§8) — and runs only Bun ×2, Postgres and
  Caddy. The CX line is offered in the German and Finnish locations; elsewhere take the CPX
  equivalent. Avoid the ARM CAX types unless you also build the image for `linux/arm64` (an
  `ubuntu-24.04-arm` runner in `.github/workflows/ci.yml`). Resizing later is a reboot.
- **Price:** Hetzner repriced cloud servers on 15 June 2026 — check hetzner.com/cloud. Add the
  public IPv4 address, and +20 % if you enable Backups.

### Create it

Cloud Console → your project → **Add Server**:

1. Location and type as above; image **Ubuntu 24.04**.
2. **Networking:** public IPv4 **on** (GitHub's runners have no IPv6, nor do many of your users), and
   IPv6 too.
3. **SSH keys:** add your own public key. It becomes root's key; no root password is mailed.
4. **Firewalls:** create one (below) and attach it here.
5. **Backups:** on (§9).
6. **Cloud config:** paste the cloud-init below, with your key and the CI key from §8.1 filled in
   (or add the CI key to `/home/deploy/.ssh/authorized_keys` later).

```yaml
#cloud-config
# Docker, plus a `deploy` user for you and for CI. Password logins off.
ssh_pwauth: false
package_update: true
package_upgrade: true
users:
  - name: deploy
    shell: /bin/bash
    ssh_authorized_keys:
      - ssh-ed25519 AAAA… you@laptop
      - ssh-ed25519 AAAA… github-actions
write_files:
  - path: /etc/docker/daemon.json
    content: |
      {"log-driver": "local"}
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - usermod -aG docker deploy
```

A few minutes after it boots, `ssh deploy@<ipv4> docker ps` should print an empty table. Use `root`
for OS work and `deploy` for everything Confire. **`deploy` can run Docker, which is root-equivalent
on this box**: treat every key in its `authorized_keys` — yours and CI's — as a root key.

### Firewall

Cloud Console → **Firewalls** → create `confire`, inbound rules for any IPv4 and IPv6:

| Protocol | Port | Why |
|---|---|---|
| TCP | 22 | SSH — you and GitHub Actions |
| TCP | 80 | Let's Encrypt HTTP challenge, redirect to HTTPS |
| TCP | 443 | the two apps |
| ICMP | — | ping, path MTU |

No outbound rules (= all allowed). A Hetzner firewall filters *before* the VM, so Docker's iptables
rules cannot bypass it the way they bypass `ufw` — but compose still binds Postgres, `:3000` and
`:3001` to `127.0.0.1` only; keep it that way, since a public `:3000` would serve plain HTTP. Port 22
stays open to the world because GitHub's runners come from address ranges too wide to allowlist;
key-only login is the control. (Another provider: the same three ports with `ufw`.)

Hetzner blocks outgoing ports 25 and 465 on new accounts. That does not matter here: mail goes to
Resend over its HTTPS API.

## 3. DNS

On Cloudflare, keep the records **DNS only (grey cloud)**: Caddy terminates TLS itself and answers the
Let's Encrypt HTTP challenge on `:80`.

| Type | Name | Content |
|---|---|---|
| A | `confire.ai` (`@`) | VPS IPv4 |
| A | `app` | VPS IPv4 |
| A | `portal` | VPS IPv4 |
| AAAA | same three | VPS IPv6 (optional; Hetzner gives a /64, the server is `<prefix>::1`) |
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

Do §8.1 first (the GitHub side). Then on the VPS, as `deploy` — the checkout must be `~/confire`,
where CI looks for it:

```bash
ssh deploy@<ipv4>
# A private repo: a read-only deploy key (GitHub → repo → Settings → Deploy keys, write access off).
ssh-keygen -t ed25519 -N "" -C confire-vps -f ~/.ssh/id_ed25519 && cat ~/.ssh/id_ed25519.pub
git clone git@github.com:<owner>/confire.git ~/confire && cd ~/confire   # check GitHub's published host key fingerprint
cat > .env <<'EOF'
DOMAIN=confire.ai
BETTER_AUTH_SECRET=...            # openssl rand -base64 32
POSTGRES_PASSWORD=...             # openssl rand -hex 32 — read once, when the database volume is created
RESEND_API_KEY=re_...
# RESEND_ADMIN_KEY=re_...         # §4b, tenant sender domains
# GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
# MICROSOFT_CLIENT_ID= / MICROSOFT_CLIENT_SECRET=
EOF
chmod 600 .env
```

Then deploy: GitHub → **Actions → CI → Run workflow** on `main` (or push to `main`). The deploy job
creates the database, pushes the schema and starts the stack; the first one adds `CONFIRE_IMAGE` to
`.env` itself. On the VPS, `cd ~/confire && docker compose logs -f caddy` shows the three certificates
being issued.

Then: open `https://app.confire.ai/signup`, verify the email, create the first workspace, and you land
on `https://app.confire.ai/<slug>/`. Configure the SAP connection (§6) and Settings → Portal.

**Back up `.env`, above all `BETTER_AUTH_SECRET`,** somewhere that is not the VPS (a password manager).
The secret signs sessions and is also the key that encrypts stored SAP agent secrets. Losing or
rotating it makes every stored `sap_connection.secret` unreadable.

## 8. Continuous deployment — GitHub Actions

`.github/workflows/ci.yml`, three jobs:

```
PR or push to main ─▶ check   bun install, build both SPAs, typecheck all 8 projects,
                              schema push + the four test suites against Postgres 17
                                │  (a PR stops here)
push to main ──────────────────▶ image   docker build → ghcr.io/<owner>/confire:<commit sha>
                                │         (GHCR keeps the last 20)
                                ▶ deploy  ssh deploy@VPS:
                                          git checkout <sha>, then scripts/deploy.sh <image>:
                                          pull → schema push with the new image while the old one
                                          still serves → pin CONFIRE_IMAGE in .env → up -d →
                                          recreate Caddy if the Caddyfile changed → both
                                          /api/auth/ok answer → prune week-old images
```

The VPS never builds and holds no registry credential: the deploy job logs it into GHCR with its own
`GITHUB_TOKEN` (valid only while the job runs) and logs out afterwards. Runs on `main` queue rather
than overlap, so an older commit can never deploy over a newer one.

### 8.1 One-time setup

1. **A CI key pair**, on your laptop:
   ```bash
   ssh-keygen -t ed25519 -N "" -C github-actions -f confire-deploy
   ```
   `confire-deploy.pub` goes into `deploy`'s `authorized_keys` (the cloud-init in §2, or append it
   later). The private half goes into the secret below; then delete the local copy.
2. **The server's host key**, pinned so a deploy never trusts whoever answers on that IP. From your
   laptop, once you have logged in to the server and accepted its key:
   ```bash
   ssh-keyscan -t ed25519 <ipv4>                     # → DEPLOY_KNOWN_HOSTS
   ```
3. **GitHub → repo → Settings → Secrets and variables → Actions → New repository secret**, three times:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | the VPS IPv4 (the same address you keyscanned) |
   | `DEPLOY_SSH_KEY` | the whole private key file `confire-deploy` |
   | `DEPLOY_KNOWN_HOSTS` | the `ssh-keyscan` line from step 2 |

   Repository secrets, because a private repository on GitHub Free has no *environments*. On Pro or
   Team, put them in an environment `production` limited to `main` instead and add
   `environment: production` to the `deploy` job: then only `main` can ever read them. (Required
   reviewers on a private repository need Enterprise.)
4. **Protect `main`** (GitHub Pro/Team, or a public repository): Settings → Rules → a branch ruleset
   requiring a pull request and the `check` status check. On Free, the habit does it: work on a branch,
   open a PR, merge once `check` is green.
5. **GHCR needs nothing.** The first `image` job creates the package `ghcr.io/<owner>/confire`, private
   and linked to the repository. If a deploy's pull ever says `denied`: the package → *Package
   settings → Manage Actions access* → add this repository with *Read*. The same job deletes all but
   the last 20 images.

A private repository's Actions minutes come out of the plan's quota (GitHub Free: 2,000 a month); a
push to `main` costs roughly ten.

### 8.2 Day to day

Merge to `main`; it is live a few minutes later. Downtime is the few seconds while the two app
containers restart; Caddy holds connections. What runs is in two places on the VPS: `git -C ~/confire
log -1` and the `CONFIRE_IMAGE` line of `.env`.

### 8.3 When the schema push needs an answer

`drizzle-kit push` is the only migration path, and it asks before a rename or a data-loss statement.
CI cannot answer, so the deploy stops **before** anything switches: the old version keeps running and
the schema is unchanged. The failed log prints the exact command; run it on the VPS with a terminal,
answer, then *Re-run failed jobs*:

```bash
cd ~/confire && CONFIRE_IMAGE=ghcr.io/<owner>/confire:<sha> docker compose --profile full run --rm server bun --cwd packages/db drizzle-kit push
```

(drizzle-kit without a terminal prints its error and exits 0, which is why `scripts/deploy.sh` looks
for its success line instead of trusting the exit code.)

### 8.4 Rolling back

- **Code only:** Actions → the last good run → the `deploy` job → *Re-run this job*. Its image is still
  in GHCR if it is among the last 20, and the checkout moves back with it.
- **Past a schema change:** the old build's push would want to drop the new columns, so that re-run
  stops at §8.3 — and you usually don't want that push anyway: the old code ignores columns it doesn't
  know. On the VPS:
  ```bash
  cd ~/confire && git checkout -f --detach <old sha>
  sed -i 's|^CONFIRE_IMAGE=.*|CONFIRE_IMAGE=ghcr.io/<owner>/confire:<old sha>|' .env
  docker compose --profile full up -d --no-build
  ```
  If that image was pruned (§9), `docker login ghcr.io` first with a classic token that has
  `read:packages`.

### 8.5 Without CI

On the VPS, building there (give it 4 GB of RAM or more: the build is the peak, and 2 GB can OOM):

```bash
cd ~/confire && git fetch && git checkout -f --detach origin/main
sed -i '/^CONFIRE_IMAGE=/d' .env      # back to the locally built image
docker compose --profile full build
docker compose --profile full run --rm server bun --cwd packages/db drizzle-kit push
docker compose --profile full up -d
```

## 9. Operations

- **Backups, two layers.** Hetzner *Backups* (enabled at creation) snapshot the whole disk daily and
  keep seven: the fastest way back from a broken server, but a crash-consistent copy of a running
  Postgres, on the same account. So also dump the database nightly, off the box. Project files are
  `bytea` rows, so the dump is the whole state. A Hetzner **Storage Box** (the smallest is plenty;
  enable *SSH support*) with `restic`:
  ```bash
  # once, as root:   apt install restic
  # once, as deploy:
  ssh-keygen -t ed25519 -N "" -f ~/.ssh/storagebox
  ssh-copy-id -i ~/.ssh/storagebox -p 23 -s u123456@u123456.your-storagebox.de
  printf 'Host storagebox\n  HostName u123456.your-storagebox.de\n  User u123456\n  Port 23\n  IdentityFile ~/.ssh/storagebox\n' >> ~/.ssh/config
  openssl rand -base64 32 > ~/.restic-pass && chmod 600 ~/.restic-pass   # keep a copy off the box too
  restic -r sftp:storagebox:confire -p ~/.restic-pass init
  mkdir -p ~/backups

  # crontab -e  (as deploy)
  0 3 * * * cd ~/confire && docker compose exec -T db pg_dump -U confire -Fc confire > ~/backups/confire.dump && restic -r sftp:storagebox:confire -p ~/.restic-pass backup -q ~/backups ~/confire/.env && restic -r sftp:storagebox:confire -p ~/.restic-pass forget -q --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
  ```
  restic encrypts with that password: without it the backups are unreadable, so store it with
  `BETTER_AUTH_SECRET`. **Test a restore once:** `restic … restore latest --target /tmp/r`, then
  `pg_restore` the dump into a scratch database. (A Storage Box shares a provider account with the
  server; for that risk too, any S3-compatible bucket elsewhere works as a restic repository.)
- **Images:** each deploy prunes unused images older than a week; a rollback to one pulls it again.
- **Caddy's volume** (`caddy_data`) holds certificates; losing it just means re-issuing (watch Let's
  Encrypt rate limits if you recreate it repeatedly).
- **Logs:** `docker compose logs -f server portal`. The cloud-init's `"log-driver": "local"` rotates
  them.
- **OS updates:** Ubuntu installs security updates by itself; reboot now and then
  (`/var/run/reboot-required` says when). Docker starts at boot and `restart: unless-stopped` brings
  the stack back.
- **Uptime:** an external check (UptimeRobot, Better Stack) on `https://app.confire.ai/login` and
  `https://portal.confire.ai/api/auth/ok`.

## 10. Checklist

- [ ] Domain bought; separate agent domain bought; both zones on Cloudflare
- [ ] Hetzner: Ubuntu 24.04, x86, public IPv4, cloud-init (`deploy` user + Docker), firewall 22/80/443 + ICMP, Backups on
- [ ] A records: `@`, `app`, `portal` (grey cloud on Cloudflare)
- [ ] Resend: `mail.<domain>` verified in the right region, sending key created
- [ ] DMARC record on the apex
- [ ] GitHub: secrets `DEPLOY_HOST`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; CI key in `deploy`'s `authorized_keys`; `main` protected where the plan allows
- [ ] VPS: deploy key, `~/confire` cloned, `.env` written (incl. `POSTGRES_PASSWORD`), `chmod 600`
- [ ] First deploy green, three certs issued
- [ ] Sign-up mail arrives (check spam score at mail-tester.com)
- [ ] `.env` and the restic password stored off the box
- [ ] OAuth redirect URIs (+ `xms_edov` for Microsoft), if used
- [ ] Nightly `pg_dump` + restic to the Storage Box; one restore tested
- [ ] Per customer: tunnel + Access service token + agent installed + SAP connection set

## Notes on the deploy files

- `POSTGRES_PASSWORD` unset falls back to `confire` (so the dev `up -d db` needs no `.env`). The
  database is reachable only on loopback and the compose network, but set it in production anyway.
- `CONFIRE_IMAGE` (in `.env`, written by `scripts/deploy.sh`) names the image both app services run;
  unset, compose builds and runs a local `confire-app`, as in dev.
- The root `db:push` script reads `../../.env`, which the image does not contain (`.dockerignore`), so
  call `drizzle-kit` directly in the container, as above.
- Caddy mounts the `Caddyfile` as a single file, i.e. by inode, and a `git checkout` replaces the file —
  so a `caddy reload` would re-read the old one. `scripts/deploy.sh` recreates the Caddy container when
  its copy differs from the checkout.
