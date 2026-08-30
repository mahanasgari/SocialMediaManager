# syntax=docker/dockerfile:1.7
#
# One build, four runtime targets. api / worker / web differ only in entrypoint;
# `all-in-one` supervises all three for single-container deploys — costing
# ~150-250MB extra RSS and losing independent worker scaling. See README.
#
# The runtime stages copy COMPILED OUTPUT ONLY. No TypeScript, no source, no
# dev dependencies. That is not tidiness: shipping source means the image
# carries a compiler, pays a transform on every cold start, and lets a build
# error surface for the first time in production rather than in CI.

# ---------- build ----------
# One build stage rather than a separate deps stage.
#
# A manifests-only deps stage is the usual trick for layer caching, but pnpm
# creates a node_modules inside EVERY workspace package, full of symlinks into
# the store and into sibling packages. Copying only the root node_modules leaves
# those missing; copying the whole tree and then overwriting it with source
# deletes them again. Either way the failure is an unresolvable @smm/* import
# partway through the build.
#
# The shared store cache below does the same job more simply: it survives across
# builds, so an unchanged lockfile downloads nothing.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY . .

# --store-dir is passed on the command rather than configured globally: pnpm's
# store defaults to the user's home, so without pointing it at the mount the
# cache is an empty directory nothing reads or writes. Setting it through
# `pnpm config --global` additionally insists on a bin directory being on PATH,
# which is ceremony for a value only this one command needs.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store     pnpm install --frozen-lockfile --store-dir /pnpm/store

# The Prisma client is generated code, not source. It must exist before
# anything that imports @smm/database can be type-checked or compiled.
RUN pnpm --filter @smm/database exec prisma generate

# Libraries first, in dependency order, then the apps. Turbo would do this from
# the graph, but it shells out to a package manager it cannot always find inside
# a container — and a build step that works locally and not in CI is worse than
# an explicit list.
RUN pnpm --filter @smm/config      build \
 && pnpm --filter @smm/auth        build \
 && pnpm --filter @smm/integrations build \
 && pnpm --filter @smm/mail        build \
 && pnpm --filter @smm/ui          build \
 && pnpm --filter @smm/storage     build \
 && pnpm --filter @smm/ratelimit   build \
 && pnpm --filter @smm/providers   build \
 && pnpm --filter @smm/media       build \
 && pnpm --filter @smm/database    build \
 && pnpm --filter @smm/publishing  build \
 && pnpm --filter @smm/api         build \
 && pnpm --filter @smm/worker      build

# Built last: it needs INTERNAL_API_URL baked into the rewrite, and it produces
# a standalone bundle that traces its own dependencies.
ARG INTERNAL_API_URL=http://api:3001
ENV INTERNAL_API_URL=${INTERNAL_API_URL}
RUN pnpm --filter @smm/web build

# Drops dev dependencies from node_modules in place, so the runtime stages copy
# only what production actually needs.
RUN pnpm prune --prod

# ---------- runtime base ----------
# ffmpeg is required by packages/media for provider-specific renditions —
# notably Instagram Reels, which needs H264/HEVC, AAC, and the moov atom at the
# front of the file. Without it the worker still runs and publishes conforming
# media untouched; non-conforming video fails with a message saying so.
#
# tini is PID 1 so signals reach Node. Without it SIGTERM is swallowed and every
# shutdown is a SIGKILL, which defeats the graceful shutdown in main.ts.
FROM node:22-alpine AS runtime
RUN apk add --no-cache ffmpeg tini
WORKDIR /app
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]

# ---------- migrate ----------
# A one-shot. Everything else waits for it to exit 0, so a first boot is one
# command and a schema change cannot race the processes that depend on it.
FROM runtime AS migrate
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/database ./packages/database
COPY docker/migrate.sh /usr/local/bin/migrate.sh
RUN chmod +x /usr/local/bin/migrate.sh
USER node
CMD ["/usr/local/bin/migrate.sh"]

# ---------- api ----------
FROM runtime AS api
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]

# ---------- worker ----------
FROM runtime AS worker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
USER node
CMD ["node", "apps/worker/dist/main.js"]

# ---------- web ----------
# The standalone output traces its own dependencies, so this stage needs no
# node_modules of its own. The server is nested under the workspace path, and
# static assets are copied in by apps/web/scripts/prepare-standalone.mjs —
# without that step the site boots and renders with no CSS.
FROM runtime AS web
COPY --from=build /app/apps/web/.next/standalone ./
USER node
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]

# ---------- all-in-one ----------
FROM runtime AS all-in-one
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/web/.next/standalone ./web-standalone
COPY docker/all-in-one.sh /usr/local/bin/all-in-one.sh
RUN chmod +x /usr/local/bin/all-in-one.sh
USER node
EXPOSE 3000
CMD ["/usr/local/bin/all-in-one.sh"]
