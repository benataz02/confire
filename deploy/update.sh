#!/bin/sh
# Ship the latest main to this server (DEPLOY.md, "Updating"). Run from anywhere, as the deploy user.
# Needs COMPOSE_PROFILES=full in the repo's .env, so every compose command here covers the whole stack.
set -eu
cd "$(dirname "$0")/.."

git pull --ff-only
docker compose build
# The schema before the new code starts (CLAUDE.md: `drizzle-kit push` is the only migration). The old
# containers keep serving meanwhile. It asks before anything destructive — answer it, don't script it.
docker compose run --rm server bun --cwd packages/db drizzle-kit push
docker compose up -d
docker image prune -f
docker compose ps
