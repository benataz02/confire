#!/bin/sh
# Nightly pg_dump of the whole database to Cloudflare R2 (DEPLOY.md, "Backups").
#   (no argument)  wait for BACKUP_AT (UTC, default 02:00), dump, upload, repeat — the compose service
#   now           one dump right away, then exit:  docker compose run --rm backup now
# Retention is an R2 lifecycle rule on the bucket, not code here, so the token never needs delete.
# ponytail: a sleep loop, not cron — one process, logs on stdout. A missed night (container down at
# BACKUP_AT) is skipped, not caught up; BACKUP_PING_URL (healthchecks.io) is how a silent stop shows.

: "${R2_ENDPOINT:?set R2_ENDPOINT (https://<account-id>.r2.cloudflarestorage.com)}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"

# rclone reads a remote named `r2` from these; no config file to mount. NO_CHECK_BUCKET: a token
# scoped to one bucket may not create or list buckets.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

backup() {
  name="confire-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
  tmp=/tmp/confire.dump
  # To a file first, never piped: a dump that dies halfway must not upload as a good-looking backup.
  # -Fc is pg_restore's format (compressed, restorable table by table).
  pg_dump -h db -U confire -d confire -Fc -f "$tmp" \
    && rclone copyto "$tmp" "r2:$R2_BUCKET/$name" \
    && echo "backup: uploaded $name ($(du -h "$tmp" | cut -f1))"
  status=$?
  rm -f "$tmp"
  if [ "$status" -ne 0 ]; then
    echo "backup: FAILED ($name)" >&2
  elif [ -n "${BACKUP_PING_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_PING_URL" || echo "backup: ping failed" >&2
  fi
  return "$status"
}

if [ "${1:-}" = now ]; then
  backup
  exit
fi

at="${BACKUP_AT:-02:00}"
echo "backup: daily at $at UTC to r2:$R2_BUCKET"
while :; do
  now=$(date -u +%s)
  next=$(date -u -d "today $at" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  backup
done
