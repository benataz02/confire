#!/bin/sh
# Ship a marketing-site build (spec 2026-10-30 §11.2; DEPLOY.md, "The marketing site"). The forced
# command of the site's own deploy key, so it never runs anything else:
#   tar -C apps/site/dist -czf - . | ssh deploy@<host> <commit sha>
# The build lands in ~/site/releases/<sha>, then ~/site/current switches to it in one rename, which
# Caddy serves read-only. A copy fix is never an app release: no image, no restart.
set -eu

sha=${SSH_ORIGINAL_COMMAND:-}
# The command is the only input a holder of the key controls: a lowercase hex sha, nothing else.
case $sha in '' | *[!0-9a-f]*) echo "site.sh: expected a commit sha, got '$sha'" >&2; exit 2 ;; esac
[ ${#sha} -ge 7 ] && [ ${#sha} -le 40 ] || { echo "site.sh: a sha is 7 to 40 characters" >&2; exit 2; }

mkdir -p "$HOME/site/releases"
cd "$HOME/site"
if [ -d "releases/$sha" ]; then
  cat > /dev/null # a re-run of a kept build (a rollback): drain the upload, switch back
else
  rm -rf "releases/$sha.tmp"
  mkdir "releases/$sha.tmp"
  # A broken upload fails here and leaves the live site as it was.
  tar -xzf - -C "releases/$sha.tmp" || { rm -rf "releases/$sha.tmp"; exit 1; }
  [ -f "releases/$sha.tmp/index.html" ] || { rm -rf "releases/$sha.tmp"; echo "site.sh: not a site build (no index.html)" >&2; exit 1; }
  mv "releases/$sha.tmp" "releases/$sha"
fi

# Atomic: a new link under a temporary name, renamed over the old one.
ln -sfn "releases/$sha" current.tmp
mv -T current.tmp current

# The last five deploys stay for rollback; `deploys` lists them oldest first.
{ grep -vx "$sha" deploys 2>/dev/null || true; echo "$sha"; } > deploys.tmp
n=$(wc -l < deploys.tmp)
if [ "$n" -gt 5 ]; then
  for old in $(head -n $((n - 5)) deploys.tmp); do rm -rf "releases/$old"; done
fi
tail -n 5 deploys.tmp > deploys
rm deploys.tmp
echo "site $sha live"
