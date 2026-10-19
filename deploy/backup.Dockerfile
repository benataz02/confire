# The nightly backup (compose service `backup`): Postgres' own image, so pg_dump always matches the
# server's major version, plus rclone for the upload to Cloudflare R2 and curl for the optional ping.
# Bump the tag together with compose's `db` image.
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends rclone curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/backup.sh /usr/local/bin/backup.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/backup.sh"]
