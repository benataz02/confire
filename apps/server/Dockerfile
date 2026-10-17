FROM oven/bun:1.4
WORKDIR /app

# Install deps against the committed lockfile, then build the two SPAs the two processes serve.
COPY . .
RUN bun install --frozen-lockfile
# Bake each SPA's zone and the sign-in host both send people to into it (apps/web/src/lib/tenant.ts,
# apps/portal/src/lib/host.ts). Defaults suit a dev-domain build; compose passes them from DOMAIN.
ARG VITE_AUTH_URL=https://lvh.me
ARG VITE_APP_BASE_DOMAIN=app.lvh.me
ARG VITE_PORTAL_BASE_DOMAIN=portal.lvh.me
RUN VITE_AUTH_URL="$VITE_AUTH_URL" VITE_APP_BASE_DOMAIN="$VITE_APP_BASE_DOMAIN" bun run build:web
RUN VITE_AUTH_URL="$VITE_AUTH_URL" VITE_PORTAL_BASE_DOMAIN="$VITE_PORTAL_BASE_DOMAIN" bun run build:portal

# After the build so it only shapes runtime. Better Auth enables rate limiting only when
# NODE_ENV=production, and Bun never sets it — without this line sign-in is unthrottled.
ENV NODE_ENV=production
EXPOSE 3000 3001
# Run migrations once per deploy:  docker compose run --rm server bun run db:migrate
# cwd = apps/server so the default WEB_DIST (../web/dist) and PORTAL_DIST (../portal/dist) resolve.
# The internal server; compose's `portal` service runs the same image with `start:portal`.
CMD ["bun", "run", "--cwd", "apps/server", "start"]
