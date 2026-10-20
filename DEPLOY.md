# Deploying Confire

The runbook for production: `app.confire.ai` (staff), `portal.confire.ai` (customers), one Hetzner VPS,
Cloudflare for DNS, tunnels and backups. Follow it top to bottom the first time. After that, an
update is one command ([§8](#8-updating)).

```
 app.confire.ai    ─┐   Cloudflare DNS only (grey cloud)
 portal.confire.ai ─┼─▶ Hetzner VPS: Caddy :443 (Let's Encrypt) ─┬─▶ server :3000  staff app + sign-in
 confire.ai        ─┘                                            └─▶ portal :3001  customer portal
                        Postgres (both servers) ─▶ backup ─▶ Cloudflare R2, nightly

 server ─HTTPS─▶ acme-agent.confire.ai ─▶ Cloudflare Access ─▶ Tunnel ─▶ confire-agent (customer's Windows box) ─▶ SAP B1
```

Everything on the VPS is `docker-compose.yml` with `COMPOSE_PROFILES=full`. The whole deployment is
configured by one `.env` file. Nothing in the code changes between dev and prod: `DOMAIN=confire.ai`
does it (`apps/server/src/tenant.ts`).

**You will collect these secrets.** Keep each in your password manager as you go: the VPS root SSH key,
`BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, the Resend API key, the R2 keys, the Cloudflare Access service
token, and each customer's agent secret.

---

## 1. The server (Hetzner)

1. Hetzner Cloud Console → *New project* → *Add server*:
   - **Location:** Nuremberg or Falkenstein (Germany), or Helsinki.
   - **Image:** Ubuntu 24.04.
   - **Type:** the cheapest shared x86 plan with **2 GB RAM** is enough: the image is built by GitHub
     Actions ([§8](#8-updating)), not here.
   - **SSH key:** add yours. Do not use a root password.
   - **Firewall:** create one with inbound **TCP 22, 80, 443** (plus ICMP) and attach it.
   - Write down the **IPv4 address**.
2. Prepare the box (as root, once):

   ```bash
   ssh root@<IP>
   apt update && apt upgrade -y
   apt install -y unattended-upgrades git        # security patches install themselves
   apt install -y docker.io docker-compose-v2     # Docker Engine + compose plugin, patched by the above

   # Swap: insurance for the memory peaks of two Bun processes + Postgres on 2 GB
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab

   # Container logs rotate instead of filling the disk
   cat > /etc/docker/daemon.json <<'EOF'
   { "log-driver": "local", "log-opts": { "max-size": "20m", "max-file": "5" } }
   EOF
   systemctl restart docker

   # A non-root user that runs the stack
   adduser --disabled-password --gecos "" deploy
   usermod -aG docker deploy
   mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
   chown -R deploy:deploy /home/deploy/.ssh
   ```

3. Clone the repository (it is public; the server only ever pulls):

   ```bash
   ssh deploy@<IP>
   git clone https://github.com/benataz02/confire.git ~/confire
   ```

   If the repository goes private, give the server a read-only GitHub *deploy key* and clone over SSH;
   the GHCR package then needs a `docker login ghcr.io` with a `read:packages` token too.

## 2. DNS (Cloudflare)

Cloudflare dashboard → `confire.ai` → **DNS → Records**. Add three records, all with **Proxy status:
DNS only (grey cloud)**:

| Type | Name | Content |
|---|---|---|
| A | `app` | `<IPv4>` |
| A | `portal` | `<IPv4>` |
| A | `@` (confire.ai) | `<IPv4>` |

Why grey: with the proxy off, Caddy gets its own Let's Encrypt certificates over HTTP and sees each
visitor's real IP, which Better Auth's sign-in rate limiting is keyed on. With the proxy on, every
visitor would share Cloudflare's IPs and both of those would need extra configuration.

Two rules:

- **No wildcard record (`*`), ever.** Every `*.confire.ai` host receives the session cookie. The only
  other names under `confire.ai` are the mail records ([§3](#3-mail-resend)) and the customer agent
  hostnames, which sit behind Cloudflare Access ([§7](#7-connecting-a-customers-sap-agent)).
- If the zone has a **CAA** record, it must allow `letsencrypt.org`. If there is none, leave it that way.

## 3. Mail (Resend)

Sign-up verification, password resets, invitations and notifications all go out from
`notify@mail.confire.ai`. Without a key, the app prints mail to the log and nobody can verify an
account. You need the key before the first sign-in.

1. resend.com → *Domains → Add domain* → `mail.confire.ai`. Set the **region to EU (Ireland)**. The
   region cannot be changed later.
2. Add the DNS records Resend shows (DKIM `TXT`, plus an `MX` and an SPF `TXT` on `send.mail`). Use its
   *Auto configure* with Cloudflare, or enter them by hand, set to **DNS only**. Click *Verify*.
3. Add DMARC yourself in Cloudflare: `TXT` record, name `_dmarc`, content `v=DMARC1; p=none;`.
4. *API Keys → Create*: permission **Sending access**, domain `mail.confire.ai`. This is
   `RESEND_API_KEY`.

(`RESEND_ADMIN_KEY` turns on per-tenant sender domains in Settings → Portal. Leave it unset until you
want that.)

## 4. Backups bucket (Cloudflare R2)

1. Cloudflare dashboard → **R2** (enable it once; the free tier is plenty) → *Create bucket*: name
   `confire-backups`, location **Jurisdiction: European Union**.
2. Bucket → *Settings → Object lifecycle rules → Add rule*: delete objects **30 days** after upload.
   Retention lives here; the backup job never deletes anything.
3. R2 → *Manage API tokens → Create API token*: permission **Object Read & Write**, applied to
   **only** `confire-backups`. Copy the **Access Key ID**, the **Secret Access Key** and the **EU
   jurisdiction S3 endpoint** (`https://<account-id>.eu.r2.cloudflarestorage.com`).
4. Optional, recommended: a free check at healthchecks.io (period 1 day, grace 2 hours). Its ping URL
   is `BACKUP_PING_URL`, and you get an email the first night a backup does not happen.

## 5. Configure and start

On the server, as `deploy`:

```bash
cd ~/confire
openssl rand -base64 32    # → BETTER_AUTH_SECRET
openssl rand -hex 32       # → POSTGRES_PASSWORD
nano .env
```

```ini
COMPOSE_PROFILES=full
DOMAIN=confire.ai

BETTER_AUTH_SECRET=<base64 from above>
POSTGRES_PASSWORD=<hex from above>
RESEND_API_KEY=re_...

R2_ENDPOINT=https://<account-id>.eu.r2.cloudflarestorage.com
R2_BUCKET=confire-backups
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
BACKUP_PING_URL=https://hc-ping.com/...
```

```bash
chmod 600 .env
./deploy/update.sh
```

Do this after the first GitHub Actions run has pushed the image ([§8](#8-updating)); that run then calls
`update.sh` itself. It pulls the image, applies the migrations, and starts db, server, portal, caddy
and backup. Then:

```bash
docker compose ps              # all "running"; backup may say "restarting" only if an R2_* is missing
docker compose logs -f caddy   # watch for "certificate obtained successfully" for app. and portal.
```

**Two secrets can never change:**

- `BETTER_AUTH_SECRET` signs every session and also **encrypts each tenant's SAP agent secret in the
  database** (`apps/server/src/crypto.ts`). If you lose it, every agent connection must be set up
  again.
- `POSTGRES_PASSWORD` is read once, when the database volume is first created.

The database backups do **not** contain `.env`. Your password manager is the only copy.

## 6. Smoke test and first workspace

1. `https://confire.ai` redirects to `https://app.confire.ai/login`.
2. `https://portal.confire.ai/` loads.
3. Sign up at `https://app.confire.ai/signup`. The verification mail arrives (check spam on the first
   try) and signs you in. Workspace setup asks for a company name and URL slug, which becomes
   `app.confire.ai/<slug>/`, then the SAP agent ([§7](#7-connecting-a-customers-sap-agent)). You can
   finish that step later in *Settings*.
4. Run one backup by hand and check that it appears in the R2 bucket:

   ```bash
   docker compose run --rm backup now
   ```

## 7. Connecting a customer's SAP agent

Each workspace reaches its customer's SAP B1 through `confire-agent`, a Windows service on the
customer's network. The cloud calls it at `https://<slug>-agent.confire.ai`, a Cloudflare Tunnel
hostname. The tunnel dials out from the customer's side, so their firewall needs no inbound rule.

**Cloudflare Access in front of every agent hostname is mandatory.** These hostnames are under
`confire.ai`, so a browser sends them the session cookie. Access stops every request at Cloudflare's
edge unless it carries Confire's service token, so a browser (and its cookie) never reaches a machine
the customer controls. Never publish an agent hostname without it.

### One-time: the Access guard

Cloudflare dashboard → **Zero Trust** (free plan; pick any team name):

1. *Access → Service credentials → Service Tokens → Create*: name `confire-cloud`. Copy the **Client
   ID** and **Client Secret**; the secret is shown only once. If you give it an expiry, put a renewal
   date in your calendar.
2. *Access → Applications → Add → Self-hosted*: name `Confire agents`. Add a policy with action
   **Service Auth** that includes **Service Token = `confire-cloud`**. Add no other policy. Add
   hostnames to it per customer, below.

### Per customer (here: slug `acme`)

1. **Guard first:** add the public hostname `acme-agent.confire.ai` to the `Confire agents`
   application. Use the flat `<slug>-agent` form: a deeper name like `acme.agent.confire.ai` falls
   outside Cloudflare's free certificate.
2. **Tunnel:** *Zero Trust → Networks → Tunnels → Create → Cloudflared*, name `acme`. Copy the
   **token** from the install command. Add a published route: hostname `acme-agent.confire.ai`,
   service **HTTP** `localhost:4000`.
3. **In Confire** (workspace setup, or *Settings* → agent): agent URL `https://acme-agent.confire.ai`,
   the `confire-cloud` Client ID and Secret, and copy the **agent secret** the page generates.
4. **Build the agent**, on any machine with Bun, from the repo:

   ```bash
   cd apps/agent && bun build --compile --target=bun-windows-x64 --outfile confire-agent.exe src/index.ts
   ```

5. **On the customer's Windows server**, the one that reaches the Service Layer: install `cloudflared`
   (`winget install --id Cloudflare.cloudflared`), then lay out:

   ```
   C:\Confire\confire-agent.exe
   C:\Confire\agent.json
   C:\Confire\deploy\install-service.ps1      (from apps/agent/deploy/)
   ```

   ```json
   {
     "port": 4000,
     "secret": "<agent secret from step 3>",
     "b1": {
       "url": "https://<sap-host>:50000",
       "companyDb": "<SBO company database>",
       "user": "<B1 user>",
       "pass": "<B1 password>",
       "allowSelfSigned": true
     }
   }
   ```

   In an elevated PowerShell in `C:\Confire`: `.\deploy\install-service.ps1 -TunnelToken <token>`.
   The SAP credentials stay in this file and never reach the cloud.
6. **Check:**
   - On the box, `curl http://localhost:4000/health` returns `{"ok":true,...}`.
   - The tunnel shows *Healthy* in Zero Trust.
   - From anywhere, `curl -i https://acme-agent.confire.ai/health` is **refused by Access**. That
     proves the guard works.
   - With headers, it answers:

     ```bash
     curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" https://acme-agent.confire.ai/health
     ```

   - In Confire, a B1 list (e.g. Business Partners) loads.

One SAP-side precondition: the `U_CF_Key` user-defined field must exist in the customer's company
database, or quote write-back refuses to run. That is by design: the field is what stops a quotation
being posted twice.

## 8. Updating

Push to `main`. GitHub Actions (`.github/workflows/deploy.yml`) builds the image, refuses it if the
schema changed without a migration, pushes it to `ghcr.io/benataz02/confire` (`:latest` and `:<sha>`)
and runs `deploy/update.sh` on the server: pull, `drizzle-kit migrate`, restart what changed, prune old
images. Expect a few seconds of downtime per restart. By hand: `ssh deploy@<IP> ~/confire/deploy/update.sh`.

**A schema change ships as a migration.** In dev, after `bun run db:push`, run `bun run db:generate`
and commit `packages/db/drizzle/`. Read the generated SQL: it is exactly what production runs. Any
question (is this a rename or a drop + add?) is asked by `generate`, in dev; `migrate` asks nothing.

To roll back, set `CONFIRE_TAG=<sha>` in `.env` and run `docker compose up -d server portal`; delete the
line before the next update. A migration is not rolled back by this; restore a backup for that.

### One-time: the CI deploy key

Actions reaches the server with its own key, which `authorized_keys` forces to run `update.sh` and
nothing else (`restrict`: no shell, no forwarding):

```bash
ssh-keygen -t ed25519 -N "" -C github-deploy -f ci_key        # on your machine
# on the server, appended to /home/deploy/.ssh/authorized_keys:
command="/home/deploy/confire/deploy/update.sh",restrict ssh-ed25519 AAAA… github-deploy
```

On GitHub (*Settings → Secrets and variables → Actions*): secret `DEPLOY_SSH_KEY` = the contents of
`ci_key`, secret `DEPLOY_KNOWN_HOSTS` = `ssh-keyscan -t ed25519 <IP>`, variable `DEPLOY_HOST` = `<IP>`.
Then delete `ci_key`. The GHCR package needs no login: the image's `org.opencontainers.image.source`
label links it to the repository, whose public visibility it inherits.

The server's checkout must already have this `update.sh`: the forced command runs the copy on disk,
and only then does its `git pull` fetch the new one.

## 9. Backups and restore

`backup` dumps the whole database (including uploaded project files, which are stored in Postgres)
every night at 02:00 UTC to `confire-backups/confire-<timestamp>.dump`. R2 keeps 30 days. To change
the time, set `BACKUP_AT=HH:MM` (UTC) in `.env` and run `docker compose up -d backup`.

**Restore** (download a `.dump` from the R2 dashboard, copy it to the server):

```bash
cd ~/confire
docker compose stop server portal
docker compose cp confire-<timestamp>.dump db:/tmp/restore.dump
docker compose exec db pg_restore -U confire -d confire --clean --if-exists /tmp/restore.dump
docker compose start server portal
```

Test a restore once, early, while nothing depends on it. To rebuild a lost server: repeat §1, put back
the same `.env` from your password manager, run `./deploy/update.sh`, restore the latest dump, then
update the DNS A records if the IP changed.

## 10. Day to day

| What | Command (in `~/confire`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f --tail=200 server` (or `portal`, `caddy`, `backup`) |
| Restart one | `docker compose restart server` |
| Backup now | `docker compose run --rm backup now` |
| psql | `docker compose exec db psql -U confire` |
| Disk | `df -h` and `docker system df` |
| OS updates | automatic (`unattended-upgrades`); `sudo reboot` now and then, after which the stack comes back by itself |

Certificates renew themselves (Caddy). Nothing else is scheduled.

## 11. Optional: Google / Microsoft sign-in

Without these, the buttons do nothing (Better Auth logs a warning at boot). To turn them on:

- **Google** (Cloud Console → Credentials → OAuth client, *Web application*): redirect URI
  `https://app.confire.ai/api/auth/callback/google`.
- **Microsoft** (Entra → App registrations, multi-tenant): redirect URI
  `https://app.confire.ai/api/auth/callback/microsoft`. Add the optional `xms_edov` claim to the ID
  token. Without it, a Microsoft address never counts as verified.

Put the IDs and secrets in `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`,
`MICROSOFT_CLIENT_SECRET`), then run `docker compose up -d`.
