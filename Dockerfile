# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build (installs all deps incl. native, builds console + gateway bundle)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install workspace deps first for better layer caching.
COPY package.json package-lock.json* ./
COPY packages/common/package.json packages/common/package.json
COPY packages/wire-format/package.json packages/wire-format/package.json
COPY packages/supplier-management/package.json packages/supplier-management/package.json
COPY packages/user-management/package.json packages/user-management/package.json
COPY packages/model-services/package.json packages/model-services/package.json
COPY packages/micro-agent/package.json packages/micro-agent/package.json
COPY packages/test-support/package.json packages/test-support/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/console/package.json apps/console/package.json
RUN npm install --no-audit --no-fund

# Build the console (Vite) and the gateway bundle (esbuild inlines the
# @areelai packages from source; only third-party deps stay external).
COPY . .
RUN npm run build:console && npm run build:gateway

# ---------------------------------------------------------------------------
# Stage 2a: runtime-api (bundled gateway + its production deps, no console)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime-api
ENV NODE_ENV=production
WORKDIR /app/gateway

# Install ONLY the gateway's production dependencies (fastify, drizzle,
# better-sqlite3, argon2, ...). The @areelai packages are inlined in the bundle.
COPY apps/gateway/package.json ./package.json
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && npm install --omit=dev --no-audit --no-fund \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# App artifacts. The legacy migration chain is only ever applied to a copy of
# a pre-split hydrogen.db during the one-time import.
COPY --from=build /app/apps/gateway/dist ./dist
COPY --from=build /app/apps/gateway/legacy-migrations ./legacy-migrations

WORKDIR /app
# Bake the commit into the image so /healthz can report which build is running.
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
ENV PORT=8080
ENV DATA_DIR=/data
ENV LEGACY_MIGRATIONS_DIR=/app/gateway/legacy-migrations
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "gateway/dist/server.cjs"]

# ---------------------------------------------------------------------------
# Stage 2b: runtime (default) -- the all-in-one image: gateway + console, the
# one-container deploy Rainyun and docker-compose use.
# ---------------------------------------------------------------------------
FROM runtime-api AS runtime
COPY --from=build /app/apps/console/dist /app/console/dist
ENV WEB_DIR=/app/console/dist
