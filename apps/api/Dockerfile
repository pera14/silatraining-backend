# syntax=docker/dockerfile:1.7
#
# SILA API (NestJS + Prisma 7). Build from the backend repo root (the pnpm workspace):
#
#   docker build -f apps/api/Dockerfile -t ghcr.io/pera14/sila-api:dev .
#
# Stages: deps (pnpm install, cached on manifests) → build (contracts, API, CLI, pruned prod deploy)
#         → runtime (non-root, prod deps + Prisma CLI for migrations, no sources/devDependencies).
# On start the container runs `prisma migrate deploy` and then the API (SPEC §7).

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    HUSKY=0
# openssl: lets Prisma detect libssl 3 so it fetches the matching schema-engine build (same as runtime)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# pnpm version comes from "packageManager" in package.json
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
# the API's postinstall runs `prisma generate`, which needs the schema and config
COPY apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma/schema.prisma apps/api/prisma/
# prisma.config.ts reads DATABASE_URL; generate only needs a syntactically valid one
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @sila/contracts build:clean \
 && pnpm --filter @sila/api build \
 && pnpm --filter @sila/api build:cli
# Production-only node_modules for the API, flat (hoisted) so the runtime needs no pnpm symlink farm;
# @sila/contracts is copied in as a real package. Scripts are skipped: the API's postinstall (`prisma generate`)
# is already done (the client is compiled into dist/), and argon2 ships prebuilt binaries loaded at runtime.
#
# `prisma migrate deploy` on start needs the Prisma CLI: it is in the prod tree as @prisma/client's peer
# (same pinned version, recorded in the lockfile; the RUN below fails the build if that ever changes).
# Its schema engine (a native binary) is fetched by @prisma/engines' postinstall, run explicitly here because
# scripts were skipped; otherwise the CLI would try to download it at runtime into a read-only node_modules.
# prisma.config.ts also imports dotenv (a devDependency), copied in from the full install.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @sila/api deploy --prod --legacy --ignore-scripts --config.node-linker=hoisted /out \
 && test "$(node -p "require('/out/node_modules/prisma/package.json').version")" = \
         "$(node -p "require('./apps/api/package.json').devDependencies.prisma")" \
 && (cd /out/node_modules/@prisma/engines && node scripts/postinstall.js) \
 && cp -rL apps/api/node_modules/dotenv /out/node_modules/dotenv

# ---------------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# openssl: Prisma's schema engine (migrate) links against libssl; tini: PID 1 that forwards signals and reaps.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    PATH=/app/node_modules/.bin:$PATH \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma.config.ts ./prisma.config.ts
COPY --from=build /repo/apps/api/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build /repo/apps/api/prisma/migrations ./prisma/migrations

ARG GIT_SHA=unknown
# com.silatraining.component: lets infra/deploy.sh prune only these images
LABEL com.silatraining.component="api" \
      org.opencontainers.image.title="sila-api" \
      org.opencontainers.image.source="https://github.com/pera14/silatraining-backend" \
      org.opencontainers.image.revision="${GIT_SHA}"

# Files stay root-owned and read-only for the app user.
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
# SPEC §7: migrations run on API start. One API replica, so no migration race. `exec` makes node the
# direct child of tini so SIGTERM reaches Nest's shutdown hooks.
CMD ["sh", "-c", "prisma migrate deploy && exec node dist/main.js"]
