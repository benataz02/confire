FROM oven/bun:1.4
WORKDIR /app

# Install deps against the committed lockfile, then build the two SPAs the two processes serve. They
# carry no setting: each reads its origins off its own location (@confire/ui/host.ts), so one image
# serves any DOMAIN.
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:web && bun run build:portal

# After the build so it only shapes runtime. Better Auth enables rate limiting only when
# NODE_ENV=production, and Bun never sets it — without this line sign-in is unthrottled.
ENV NODE_ENV=production
EXPOSE 3000 3001
# Schema once per deploy:  docker compose --profile full run --rm server bun --cwd packages/db drizzle-kit push
# cwd = apps/server so ../web/dist and ../portal/dist resolve.
# The internal server; compose's `portal` service runs the same image with `start:portal`.
CMD ["bun", "run", "--cwd", "apps/server", "start"]
