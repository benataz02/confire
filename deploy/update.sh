#!/bin/sh
# Ship the latest main to this server (DEPLOY.md, "Updating"). As the deploy user: GitHub Actions runs it
# after pushing the image (.github/workflows/deploy.yml), or run it by hand.
# Needs COMPOSE_PROFILES=full in the repo's .env, so every compose command here covers the whole stack.
set -eu
# One block: sh has parsed all of it before `git pull` rewrites this file under it.
{
cd "$(dirname "$0")/.."

git pull --ff-only
# The app image comes from CI, built from this same commit; only the small backup image builds here.
docker compose pull server portal
docker compose build backup
# The schema before the new code starts (CLAUDE.md: committed migrations, never `push` here). The old
# containers keep serving meanwhile; a failed migration rolls back and stops the deploy here.
docker compose run --rm -T server bun --cwd packages/db drizzle-kit migrate
# Caddy bind-mounts ../site (the marketing site, deploy/site.sh). Made here, as deploy: a missing bind
# source is created by Docker as root, and the site's deploys could never write to it.
mkdir -p ../site
docker compose up -d
docker image prune -f
docker compose ps
exit
}
