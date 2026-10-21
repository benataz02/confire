FROM oven/bun:1.4
WORKDIR /app

# Install deps against the committed lockfile, then build the two SPAs the two processes serve. They
# carry no setting: each reads its origins off its own location (@confire/ui/host.ts), so one image
# serves any DOMAIN.
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build:app && bun run build:portal

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
