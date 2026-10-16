FROM oven/bun:1.4
WORKDIR /app

# Install deps against the committed lockfile, then build the two SPAs the two processes serve.
COPY . .
RUN bun install --frozen-lockfile
# Bake each SPA's zone into it (apps/web/src/lib/tenant.ts, apps/portal/src/lib/host.ts) and the
# portal's Turnstile site key. Defaults suit a bare build; compose passes them from DOMAIN.
ARG VITE_APP_BASE_DOMAIN=localhost
ARG VITE_PORTAL_BASE_DOMAIN=portal.localhost
ARG VITE_TURNSTILE_SITE_KEY=
RUN VITE_APP_BASE_DOMAIN="$VITE_APP_BASE_DOMAIN" bun run build:web
RUN VITE_PORTAL_BASE_DOMAIN="$VITE_PORTAL_BASE_DOMAIN" VITE_TURNSTILE_SITE_KEY="$VITE_TURNSTILE_SITE_KEY" bun run build:portal

# After the build so it only shapes runtime. Better Auth enables rate limiting only when
# NODE_ENV=production, and Bun never sets it — without this line sign-in is unthrottled.
ENV NODE_ENV=production
EXPOSE 3000 3001
# Run migrations once per deploy:  docker compose run --rm server bun run db:migrate
# cwd = apps/server so the default WEB_DIST (../web/dist) and PORTAL_DIST (../portal/dist) resolve.
# The internal server; compose's `portal` service runs the same image with `start:portal`.
CMD ["bun", "run", "--cwd", "apps/server", "start"]
