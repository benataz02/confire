#!/usr/bin/env bash
# Runs on the VPS, from the checkout CI has just moved to the deployed commit (docs/deployment.md §8):
#   bash scripts/deploy.sh ghcr.io/<owner>/confire:<sha>
# The image was built and tested in CI; this box never builds. The order is the point: the schema is
# pushed with the NEW image while the old containers keep serving, and only then do they switch — so
# a push that stops for a decision leaves the running version untouched.
set -euo pipefail
image=${1:?usage: scripts/deploy.sh <image>}
cd "$(dirname "$0")/.."

docker pull --quiet "$image"
# A shell variable beats .env in compose interpolation: the push runs the new build, nothing else moves.
export CONFIRE_IMAGE=$image

# drizzle-kit push is the only migration path. Without a TTY it cannot ask about a rename or a
# data-loss statement, and (verified on 0.31.10) it then prints "Interactive prompts require a TTY
# terminal" and EXITS 0. So the exit code proves nothing: success is one of its two success lines.
out=$(docker compose --profile full run --rm -T server bun --cwd packages/db drizzle-kit push 2>&1) || true
echo "$out"
if ! grep -qE 'Changes applied|No changes detected' <<<"$out"; then
  echo "::error::The schema push did not complete: it needs an answer, or it failed (above). Nothing was deployed; the old version still runs."
  echo "Run it by hand on the VPS, then re-run the deploy:"
  echo "  cd ~/confire && CONFIRE_IMAGE=$image docker compose --profile full run --rm server bun --cwd packages/db drizzle-kit push"
  exit 1
fi

# Pin it in .env, so a later `docker compose … up` by hand runs this build too, not a local one.
{ grep -v '^CONFIRE_IMAGE=' .env || true; echo "CONFIRE_IMAGE=$image"; } >.env.next
chmod 600 .env.next && mv .env.next .env

docker compose --profile full up -d --no-build --remove-orphans

# Caddy mounts the Caddyfile as a single file — by inode — and a checkout replaces the file, so a
# `caddy reload` would re-read the old one. Recreate the container, only when its copy differs.
if ! docker compose --profile full exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - Caddyfile; then
  docker compose --profile full up -d --no-deps --force-recreate caddy
fi

# Both processes answer before the deploy counts as done (Better Auth's own health endpoint).
for port in 3000 3001; do
  curl -fsS --retry 15 --retry-delay 2 --retry-all-errors -o /dev/null "http://127.0.0.1:$port/api/auth/ok"
done

# Unused builds older than a week. A rollback to one just pulls it again from GHCR.
docker image prune -af --filter "until=168h" >/dev/null
echo "Deployed $image"
