# Deploying Confire

The runbook for production: `app.confire.ai` (staff), `portal.confire.ai` (customers), one Hetzner VPS,
Cloudflare for DNS, tunnels and backups, Resend for mail, GitHub Actions for builds.

| You want to… | Read |
|---|---|
| Stand up production on a new server, or rebuild a lost one | [Part 1](#part-1-first-deploy), §1–§8, top to bottom |
| Ship a feature or a fix to the running app | [Part 2](#part-2-shipping-changes), §9–§10 |
| Change the schema, back up, restore, or look inside the database | [Part 3](#part-3-the-database), §11–§14 |
| Check on things | [§15](#15-day-to-day) |

```
 app.confire.ai    ─┐   Cloudflare DNS only (grey cloud)
 portal.confire.ai ─┼─▶ Hetzner VPS: Caddy :443 (Let's Encrypt) ─┬─▶ server :3000  staff app + sign-in
 confire.ai        ─┘                                            └─▶ portal :3001  customer portal
                        Postgres (both servers) ─▶ backup ─▶ Cloudflare R2, nightly

 git push main ─▶ GitHub Actions: build image ─▶ ghcr.io/benataz02/confire ─▶ ssh: deploy/update.sh

 server ─HTTPS─▶ acme-agent.confire.ai ─▶ Cloudflare Access ─▶ Tunnel ─▶ confire-agent (customer's Windows box) ─▶ SAP B1
```

Everything on the VPS is `docker-compose.yml` with `COMPOSE_PROFILES=full`. The whole deployment is
configured by one `.env` file. Nothing in the code changes between dev and prod: `DOMAIN=confire.ai`
does it (`apps/server/src/tenant.ts`).

**This deployment:**

| | |
|---|---|
| Server | Hetzner `ubuntu-2gb-hel1-1` (CPX12, Helsinki), `95.217.187.52` / `2a01:4f9:c013:ab71::1` |
| Login | `ssh deploy@95.217.187.52` (SSH keys only). The stack lives in `~/confire` |
| Image | `ghcr.io/benataz02/confire`, tagged `:latest` and `:<commit sha>` |
| Secrets | `~/confire/.env` on the server. Your password manager holds the only other copy |

---

# Part 1: First deploy

**You will collect these secrets.** Keep each in your password manager as you go: `BETTER_AUTH_SECRET`,
`POSTGRES_PASSWORD`, the two Resend keys, the R2 keys, the OAuth client secrets, the Cloudflare Access
service token, and each customer's agent secret.

Rebuilding a lost server is the same path: §1, the same `.env` from your password manager, §6–§7, then
restore the latest dump ([§13](#13-restore)). Update the DNS records if the IP changed.

## 1. The server (Hetzner)

1. Hetzner Cloud Console → *Add server*:
   - **Location:** Helsinki, Nuremberg or Falkenstein.
   - **Image:** Ubuntu 24.04 or newer.
   - **Type:** the cheapest shared x86 plan with **2 GB RAM**. The image is built by GitHub Actions,
     not here.
   - **SSH key:** add yours. Without one, Hetzner mails a root password that is expired on arrival.
     Until it is changed, even key logins are refused.
   - **Firewall:** create one with inbound **TCP 22, 80, 443** (plus ICMP) and attach it. Do not use ufw:
     Docker's published ports bypass it. The database port is bound to 127.0.0.1 for that reason.
   - Write down the **IPv4 and IPv6 addresses**.
2. Prepare the box (as root, once):

   ```bash
   ssh root@<IP>
   apt update && apt upgrade -y
   apt install -y unattended-upgrades git        # security patches install themselves
   apt install -y docker.io docker-compose-v2     # Docker Engine + compose plugin, patched by the above

   # Keys only. 00- sorts before cloud-init's 50-cloud-init.conf, and sshd keeps the first value it reads.
   cat > /etc/ssh/sshd_config.d/00-confire.conf <<'EOF'
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin prohibit-password
   EOF
   systemctl reload ssh

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

3. Clone the repository. It is public, and the server only ever pulls:

   ```bash
   ssh deploy@<IP>
   git clone https://github.com/benataz02/confire.git ~/confire
   ```

   If the repository goes private, give the server a read-only GitHub *deploy key* and clone over SSH.
   The GHCR package then needs a `docker login ghcr.io` with a `read:packages` token as well.

## 2. DNS (Cloudflare)

Cloudflare dashboard → `confire.ai` → **DNS → Records**. Every record is **Proxy status: DNS only
(grey cloud)**:

| Type | Name | Content |
|---|---|---|
| A | `@`, `app`, `portal` (three records) | `<IPv4>` |
| AAAA | `@`, `app`, `portal` (three records) | `<IPv6>` |
| CAA | `@` | `0 issue "letsencrypt.org"` |

The records are grey because with the proxy off, Caddy gets its own Let's Encrypt certificates over
HTTP. It also sees each visitor's real IP, which Better Auth's sign-in rate limiting is keyed on. With
the proxy on, every visitor would share Cloudflare's IPs, and both would need extra configuration.

Cloudflare adds its own certificate authorities to the CAA set. That does no harm, as long as
`letsencrypt.org` stays in it.

**No wildcard record (`*`), ever.** Every `*.confire.ai` host receives the session cookie. The only
other names under `confire.ai` are the mail records ([§3](#3-mail-resend)) and the customer agent
hostnames, which sit behind Cloudflare Access ([§8](#8-connecting-a-customers-sap-agent)).

## 3. Mail (Resend)

Sign-up verification, password resets, invitations and notifications all go out from
`notify@mail.confire.ai`. Without a key, the app prints mail to the log and nobody can verify an
account. You need the key before the first sign-in.

1. resend.com → *Domains → Add domain* → `mail.confire.ai`. Set the **region to EU (Ireland)**. The
   region cannot be changed later.
2. Add the DNS records Resend shows (DKIM, MX and SPF, set to **DNS only**), then click *Verify*.
3. Add DMARC yourself: a `TXT` record named `_dmarc` with content `v=DMARC1; p=none`.
4. *API Keys → Create*:
   - **Sending access** for `mail.confire.ai`. This is `RESEND_API_KEY`.
   - Optional: **Full access**, as `RESEND_ADMIN_KEY`. It turns on per-tenant sender domains in
     Settings → Portal. Leave it unset to keep them off.

## 4. Backups bucket (Cloudflare R2)

This step can wait. Until it is done, the `backup` container restart-loops, and the manual dump in
[§12](#12-backups) is your only backup.

1. Cloudflare dashboard → **R2** (enable it once; the free tier is plenty) → *Create bucket*: name
   `confire-backups`, location **Jurisdiction: European Union**.
2. Bucket → *Settings → Object lifecycle rules → Add rule*: delete objects **30 days** after upload.
   Retention lives here; the backup job never deletes anything.
3. R2 → *Manage API tokens → Create API token*:
   - Permission **Object Read & Write**, applied to **only** `confire-backups`.
   - Copy the **Access Key ID**, the **Secret Access Key** and the **EU jurisdiction S3 endpoint**
     (`https://<account-id>.eu.r2.cloudflarestorage.com`).
4. Optional, recommended: a free check at healthchecks.io (period 1 day, grace 2 hours). Its ping URL
   is `BACKUP_PING_URL`. You get an email the first night a backup does not happen.

## 5. Configure

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
RESEND_ADMIN_KEY=re_...

# Optional: Google / Microsoft sign-in. Unset leaves that button dead (Better Auth logs a warning at boot)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...

# §4; until these are set the backup container restart-loops
R2_ENDPOINT=https://<account-id>.eu.r2.cloudflarestorage.com
R2_BUCKET=confire-backups
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
BACKUP_PING_URL=https://hc-ping.com/...
```

```bash
chmod 600 .env
```

Each OAuth client gets exactly one redirect URI, on the sign-in host. The portal signs in there too:

- **Google** (Cloud Console → Credentials → OAuth client, *Web application*):
  `https://app.confire.ai/api/auth/callback/google`.
- **Microsoft** (Entra → App registrations, multi-tenant):
  `https://app.confire.ai/api/auth/callback/microsoft`. Also add the optional `xms_edov` claim to the ID
  token. Without it, a Microsoft address never counts as verified.

For dev, add `http://localhost:5173/api/auth/callback/…` to the same clients.

**Two secrets can never change:**

- `BETTER_AUTH_SECRET` signs every session and also **encrypts each tenant's SAP agent secret in the
  database** (`apps/server/src/crypto.ts`). If you lose it, every agent connection must be set up
  again.
- `POSTGRES_PASSWORD` is read once, when the database volume is first created. Changing it later goes
  through [§14](#14-access-and-housekeeping).

The database backups do **not** contain `.env`. Your password manager is the only other copy.

## 6. The CI deploy key

Actions reaches the server with its own key. `authorized_keys` forces that key to run `update.sh` and
nothing else (`restrict`: no shell, no forwarding):

```bash
ssh-keygen -t ed25519 -N "" -C github-deploy -f ci_key        # on your machine
# on the server, appended to /home/deploy/.ssh/authorized_keys:
command="/home/deploy/confire/deploy/update.sh",restrict ssh-ed25519 AAAA… github-deploy
```

Then set these on GitHub (*Settings → Secrets and variables → Actions*), and delete `ci_key` afterwards:

| Kind | Name | Value |
|---|---|---|
| Secret | `DEPLOY_SSH_KEY` | the contents of `ci_key` |
| Secret | `DEPLOY_KNOWN_HOSTS` | the output of `ssh-keyscan -t ed25519 <IP>` |
| Variable | `DEPLOY_HOST` | `<IP>` |

The GHCR package needs no login. The image's `org.opencontainers.image.source` label links it to the
repository, and the package inherits the repository's public visibility.

## 7. First start and smoke test

Run the workflow once: GitHub → *Actions → deploy → Run workflow*, or `gh workflow run deploy`. It
builds and pushes the image, then runs `update.sh` on the server. That pulls the image, creates the
schema on the empty database (`drizzle-kit migrate`), and starts db, server, portal, caddy and backup.
If the Deploy step fails (for example, the key is not set up yet), the image is still pushed. Run
`~/confire/deploy/update.sh` on the server by hand.

```bash
docker compose ps              # all "running"; backup may say "restarting" only if an R2_* is missing
docker compose logs -f caddy   # watch for "certificate obtained successfully" for app. and portal.
```

Then:

1. `https://confire.ai` redirects to `https://app.confire.ai/login`.
2. `https://portal.confire.ai/` loads.
3. Sign up at `https://app.confire.ai/signup`. The verification mail arrives (check spam on the first
   try) and signs you in.
4. Workspace setup asks for a company name and a URL slug, which becomes `app.confire.ai/<slug>/`.
   Then it asks for the SAP agent ([§8](#8-connecting-a-customers-sap-agent)); you can finish that step
   later in *Settings*.
5. Once R2 is set up, run one backup by hand and check that it appears in the bucket:
   `docker compose run --rm backup now`.

## 8. Connecting a customer's SAP agent

Each workspace reaches its customer's SAP B1 through `confire-agent`, a Windows service on the
customer's network. The cloud calls it at `https://<slug>-agent.confire.ai`, a Cloudflare Tunnel
hostname. The tunnel dials out from the customer's side, so their firewall needs no inbound rule.

**Cloudflare Access in front of every agent hostname is mandatory.** These hostnames are under
`confire.ai`, so a browser sends them the session cookie. Access stops every request at Cloudflare's
edge unless it carries Confire's service token. A browser, and its cookie, therefore never reaches a
machine the customer controls. Never publish an agent hostname without it.

### One-time: the Access guard

Cloudflare dashboard → **Zero Trust** (free plan; pick any team name):

1. *Access → Service credentials → Service Tokens → Create*: name `confire-cloud`. Copy the **Client
   ID** and **Client Secret**; the secret is shown only once. If you give it an expiry, put a renewal
   date in your calendar.
2. *Access → Applications → Add → Self-hosted*: name `Confire agents`. Add a policy with action
   **Service Auth** that includes **Service Token = `confire-cloud`**. Add no other policy. You add
   hostnames to it per customer, below.

### Per customer (here: slug `acme`)

1. **Guard first:** add the public hostname `acme-agent.confire.ai` to the `Confire agents`
   application. Use the flat `<slug>-agent` form: a deeper name like `acme.agent.confire.ai` falls
   outside Cloudflare's free certificate.
2. **Tunnel:** *Zero Trust → Networks → Tunnels → Create → Cloudflared*, name `acme`. Copy the
   **token** from the install command. Add a published route: hostname `acme-agent.confire.ai`,
   service **HTTP** `localhost:4000`.
3. **In Confire** (workspace setup, or *Settings* → agent): enter the agent URL
   `https://acme-agent.confire.ai` and the `confire-cloud` Client ID and Secret. Copy the **agent
   secret** the page generates.
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
   - With the token headers, it answers:

     ```bash
     curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" https://acme-agent.confire.ai/health
     ```

   - In Confire, a B1 list (e.g. Business Partners) loads.

One SAP-side precondition: the `U_CF_Key` user-defined field must exist in the customer's company
database, or quote write-back refuses to run. That is by design: the field is what stops a quotation
being posted twice.

---

# Part 2: Shipping changes

## 9. Updating

**`main` is production.** Every push to it deploys (`.github/workflows/deploy.yml`):

1. Build the image on GitHub's runner.
2. Refuse it if the schema changed without a migration.
3. Push it to GHCR.
4. Run `deploy/update.sh` on the server: `git pull`, pull the image, `drizzle-kit migrate`, restart
   what changed, prune old images.

The run takes a few minutes, and each restart means a few seconds of downtime. Never force-push
`main`: the server's `git pull --ff-only` refuses a rewritten history and stops the deploy.

### A feature, start to finish

1. **Branch from `main`**, or merge `main` into the branch you already have. That brings the
   committed migrations in `packages/db/drizzle/`.
2. **Build it in dev** (`bun run dev`). For a schema change, follow [§11](#11-schema-migrations):
   `db:push` while you iterate, then `db:generate` once the schema has settled.
3. **Run the gates CI does not run.** The image build is only `vite build`, which does not typecheck
   and runs no tests. A type error in the server, or a failing test, ships unless you catch it here:

   ```bash
   for p in packages/{b1,config-engine,db,ui} apps/{agent,server,web,portal}; do
     bunx tsc -p $p/tsconfig.json --noEmit || echo "FAIL $p"
   done
   bun run test:engine && bun run test:ui && bun run test:web && bun run test:server   # server: needs the dev db
   ```

4. **Merge to `main`** with a PR or a push. That is the deploy.
5. **Watch it:** `gh run watch`, or the Actions tab. When a step fails:

   | Step | Usually means | Fix |
   |---|---|---|
   | build (`docker build`) | `bun install --frozen-lockfile` or a Vite build failed | Run `bun install` and commit `bun.lock`; `bun run build:web` / `build:portal` locally |
   | Schema changes have a migration | The schema changed but nothing was generated | `bun run db:generate`, commit `packages/db/drizzle/`, push |
   | Deploy | `git pull` refused, the pull failed, or a migration failed. The server's output is in the log | Fix, then *Re-run jobs*, or `ssh deploy@95.217.187.52 ~/confire/deploy/update.sh` |

   Nothing after a failed step runs. A failed migration is rolled back whole, and the old version
   keeps serving.
6. **Check it:**
   - `curl -fsS https://app.confire.ai/api/auth/ok https://portal.confire.ai/api/auth/ok`
   - Open the feature.
   - On the server: `docker compose logs --since 10m server portal`.
   - `git -C ~/confire log -1 --oneline` is the commit that is running.

### Rolling back

- **The normal way:** `git revert <sha>` and push. The previous code then deploys like any change.
  This does not work for a commit that carries a migration: its schema is already in the database.
  Write a new migration that undoes it instead ([§11](#11-schema-migrations)).
- **The fast way**, while you work out the fix: in the server's `.env`, set
  `CONFIRE_TAG=<full sha of the last good commit>`, then run `docker compose up -d server portal`.
  Every commit `main` has built is on GHCR under its sha. Delete the line once the fix is out:
  until then, every deploy keeps starting that old image.

## 10. Changes a push does not apply

| Change | Also do |
|---|---|
| A new environment variable the code reads | Add it to `docker-compose.yml`. A container receives only the variables named in its `environment:` block, and `server`'s block is `portal`'s too. Put the value in the server's `.env` **before** you push. |
| A changed `.env` value (rotated key, OAuth credentials, `BACKUP_AT`) | `docker compose up -d`. It recreates only the containers whose settings changed. |
| `Caddyfile` | After the deploy, run `docker compose up -d --force-recreate caddy`. The file is bind-mounted, and `git pull` swaps in a new file, so the running Caddy keeps the old one. `up -d` does not notice the change, and `caddy reload` would re-read the stale copy. |
| Better Auth configuration (plugins, extra fields in `auth.ts`) | `bun run auth:generate`. It is then a schema change ([§11](#11-schema-migrations)). |
| The Postgres version | [§14](#14-access-and-housekeeping). |

Never edit a tracked file on the server. `git pull --ff-only` then refuses, and every later deploy
stops at its first line. Server-only settings belong in `.env`, which git ignores.

---

# Part 3: The database

Postgres 17, the compose service `db`, data in the Docker volume `confire_pgdata`. The database holds
everything except `.env`, uploaded project files included (`project_file`).

## 11. Schema migrations

Dev and production change the schema differently:

- **Dev** syncs with `bun run db:push`. It is fast, it prompts, and it is fine to throw away.
- **Production** only ever runs committed migrations. `update.sh` runs `drizzle-kit migrate` before the
  new code starts, and it never prompts. `0000_init` is the baseline, and every later file in
  `packages/db/drizzle/` is one change.

**Making one:**

1. Change `packages/db/src/schema/`. A new schema file must be re-exported from `schema/index.ts`.
2. `bun run db:push` while you iterate.
3. `bun run db:generate --name <what_it_does>` once the schema has settled. Any question (is this a
   rename, or a drop plus an add?) is asked here, in dev. Answer it carefully: a wrong "drop" is data
   loss in production.
4. **Read the generated SQL.** It is exactly what production will run. Then commit the `.sql` file,
   `meta/_journal.json` and the snapshot, all together with the schema change.

**What to look for in the SQL.** While a migration runs, the old code is still serving. Shape changes
so both versions can live with the schema:

- **Adding a `NOT NULL` column to a table with rows** needs a `DEFAULT`, or the migration fails.
- **Dropping or renaming a column or table takes two deploys.** First ship code that no longer uses it,
  then ship the migration that drops it.
- **Moving or backfilling data** needs a custom migration. `bun run db:generate --custom --name
  backfill_x` writes an empty `.sql` file for you to fill in. Separate statements with
  `--> statement-breakpoint`.

**How `migrate` behaves:**

- It applies every pending file **in one transaction**. If one statement fails, nothing is applied,
  the deploy stops, and the old version keeps running. Fix it with a new commit. A migration that has
  run in production is never edited or deleted; you undo it with another migration.
- It decides what is pending by the `when` timestamp in `meta/_journal.json`, compared with the
  newest applied one. **A file stamped older than the last applied migration is skipped silently.**
  This can happen when two branches each generate a migration. Whichever merges second must delete
  its own generated file and journal entry, merge `main`, and run `db:generate` again.
- Applied migrations are listed in `drizzle.__drizzle_migrations`.

**Rehearse a risky migration** against a copy of production, on your machine:

```bash
ssh deploy@95.217.187.52 'cd confire && docker compose exec -T db pg_dump -U confire -Fc confire' > prod.dump
docker compose exec -T db createdb -U confire rehearsal
docker compose exec -T db pg_restore -U confire -d rehearsal < prod.dump
DATABASE_URL=postgres://confire:confire@localhost:5432/rehearsal bun --cwd packages/db drizzle-kit migrate
docker compose exec -T db dropdb -U confire rehearsal && rm prod.dump   # customer data: don't keep it
```

## 12. Backups

**Nightly, once R2 is set up ([§4](#4-backups-bucket-cloudflare-r2)).** The `backup` service dumps the
whole database every night at 02:00 UTC to `confire-backups/confire-<timestamp>.dump`. R2 keeps each
dump for 30 days. To change the time, set `BACKUP_AT=HH:MM` (UTC) in `.env` and run
`docker compose up -d backup`. To take one now, run `docker compose run --rm backup now`.

**By hand, to your machine.** Do this before a risky migration or a restore, and as the only backup
until R2 exists:

```bash
ssh deploy@95.217.187.52 'cd confire && docker compose exec -T db pg_dump -U confire -Fc confire' > confire-$(date -u +%Y%m%dT%H%MZ).dump
```

`-T` matters: without it Docker allocates a terminal, which corrupts the binary dump. A dump holds
customer data and every user's password hash, so store it like a secret.

## 13. Restore

First take a dump of the current state ([§12](#12-backups)), in case the restore is the mistake. Then,
on the server, with the `.dump` file copied there (`scp file.dump deploy@95.217.187.52:`):

```bash
cd ~/confire
docker compose stop server portal
docker compose exec -T db dropdb -U confire --force confire
docker compose exec -T db createdb -U confire confire
docker compose exec -T db pg_restore -U confire -d confire < ~/confire-<timestamp>.dump
docker compose run --rm -T server bun --cwd packages/db drizzle-kit migrate   # if the dump predates a migration
docker compose start server portal
```

The restore drops the whole database rather than using `pg_restore --clean`. `--clean` would leave
behind tables created after the dump, and the next `migrate` would then fail on them. Test a restore
once, early, while nothing depends on it. The rehearsal in [§11](#11-schema-migrations) is one.

## 14. Access and housekeeping

**psql on the server:** `docker compose exec db psql -U confire`. Inside the container, no password is
needed.

**From your machine**, through an SSH tunnel, since the port is bound to the server's loopback only:

```bash
ssh -N -L 5433:127.0.0.1:5432 deploy@95.217.187.52        # leave it running
psql postgres://confire:<POSTGRES_PASSWORD>@localhost:5433/confire
DATABASE_URL=postgres://confire:<POSTGRES_PASSWORD>@localhost:5433/confire bun --cwd packages/db drizzle-kit studio
```

Anything you change there is a live production edit. **Never run `db:push` or `migrate` against the
tunnel.** The schema changes only through `update.sh`. A `push` would change it without a migration
file, and the next `migrate` would then fail on it.

**Useful queries:**

```sql
select pg_size_pretty(pg_database_size('confire'));
select relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_stat_user_tables
  order by pg_total_relation_size(relid) desc limit 10;   -- project_file (uploads) and config_masterdata_row (the SAP cache) grow
select id, created_at from drizzle.__drizzle_migrations order by id;
```

Nothing needs scheduling. Autovacuum handles the churn of the masterdata cache's delete-and-refill.

**Changing `POSTGRES_PASSWORD`.** The variable only takes effect when the volume is first created, so
change the password in the database first, then in `.env`:

```bash
docker compose exec db psql -U confire -c "ALTER USER confire PASSWORD '<openssl rand -hex 32>'"
nano .env                      # POSTGRES_PASSWORD=<the same value>
docker compose up -d
```

**A major Postgres upgrade** (17 → 18) cannot reuse the volume. The procedure is: dump, then a new
volume, then restore. `postgres:17` appears in `docker-compose.yml` and `deploy/backup.Dockerfile`, and
the two must move together. 17 is supported until November 2029; plan the upgrade as its own
maintenance window.

---

## 15. Day to day

| What | Command (in `~/confire`) |
|---|---|
| Status | `docker compose ps` |
| Logs | `docker compose logs -f --tail=200 server` (or `portal`, `caddy`, `backup`) |
| Running version | `git log -1 --oneline` |
| Restart one | `docker compose restart server` |
| Deploy by hand | `./deploy/update.sh` |
| Backup now | `docker compose run --rm backup now` (R2) or [§12](#12-backups)'s manual dump |
| psql | `docker compose exec db psql -U confire` |
| Disk | `df -h /` and `docker system df` |
| Memory | `free -h` and `docker stats --no-stream` |
| OS updates | Automatic (`unattended-upgrades`). Reboot now and then (`ssh root@95.217.187.52 reboot`); the stack comes back by itself |

Certificates renew themselves (Caddy). Old images are pruned on every deploy. Nothing else is
scheduled.
