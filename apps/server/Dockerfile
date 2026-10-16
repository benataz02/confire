FROM oven/bun:1.4
WORKDIR /app

# Install deps against the committed lockfile, then build the SPA the server will serve.
COPY . .
RUN bun install --frozen-lockfile
# Bake the subdomain base domain into the SPA (apps/web/src/lib/tenant.ts). Defaults to
# localhost for a bare build; compose passes APP_BASE_DOMAIN.
ARG VITE_APP_BASE_DOMAIN=localhost
RUN VITE_APP_BASE_DOMAIN="$VITE_APP_BASE_DOMAIN" bun run build:web

# After the build so it only shapes runtime. Better Auth enables rate limiting only when
# NODE_ENV=production, and Bun never sets it — without this line sign-in is unthrottled.
ENV NODE_ENV=production
EXPOSE 3000
# Run migrations once per deploy:  docker compose run --rm server bun run db:migrate
# cwd = apps/server so the server's default WEB_DIST (../web/dist) resolves to the SPA build.
CMD ["bun", "run", "--cwd", "apps/server", "start"]
