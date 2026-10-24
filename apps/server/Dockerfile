# The SAP agent (apps/agent): a Windows exe, built here so the image serves the very build it was made
# with at /download/confire-agent.exe and knows its version for "update available". cloudflared is
# pinned — version and SHA-256 — and embedded, so install day needs no download a proxy could block.
# A newer cloudflared: change both ARGs (the digest is on the GitHub release page).
# Both exes must load on Windows Server 2012 R2 (6.3), and Go 1.27 stamps the PE header "Windows
# 10" (subsystem 10.0), which that loader refuses outright. So Go 1.26 here, and cloudflared
# 2026.10.0, the last release built with go1.26 (2026.10.3 is go1.27). The check after the build
# fails the image rather than ship an exe the customer's server cannot start.
FROM golang:1.26 AS agent
ARG AGENT_VERSION=dev
ARG CLOUDFLARED_VERSION=2026.10.0
ARG CLOUDFLARED_SHA256=86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c
WORKDIR /src
COPY apps/agent/ .
RUN curl -fsSL -o bin/cloudflared.exe "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe" \
 && echo "${CLOUDFLARED_SHA256}  bin/cloudflared.exe" | sha256sum -c - \
 && go vet ./... && GOOS=windows go vet ./... && go test ./... \
 && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -X main.version=${AGENT_VERSION}" \
      -o /out/confire-agent.exe . \
 && for f in bin/cloudflared.exe /out/confire-agent.exe; do \
      objdump -p "$f" | grep -qP '^MajorSubsystemVersion\t6$' || { echo "$f requires Windows 10: Server 2012 R2 cannot load it"; exit 1; }; \
    done \
 && echo "${AGENT_VERSION}" > /out/VERSION

FROM oven/bun:1.4
WORKDIR /app

# Install deps against the committed lockfile, then build the two SPAs the two processes serve. They
# carry no setting: each reads its origins off its own location (@confire/ui/host.ts), so one image
# serves any DOMAIN.
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:app && bun run build:portal
# Where agent-pairing.ts looks for it.
COPY --from=agent /out apps/agent/dist

# After the build so it only shapes runtime. Better Auth enables rate limiting only when
# NODE_ENV=production, and Bun never sets it — without this line sign-in is unthrottled.
ENV NODE_ENV=production
# The commit this image was built from (CI's --build-arg): Sentry's release, so an error names its deploy.
ARG SENTRY_RELEASE
ENV SENTRY_RELEASE=$SENTRY_RELEASE
EXPOSE 3000 3001
# Schema once per deploy (deploy/update.sh): bun --cwd packages/db drizzle-kit migrate
# cwd = apps/server so ../app/dist and ../portal/dist resolve.
# The internal server; compose's `portal` service runs the same image with `start:portal`.
CMD ["bun", "run", "--cwd", "apps/server", "start"]
