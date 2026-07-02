# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: build (installs all deps incl. native, builds web + server bundle)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install workspace deps first for better layer caching.
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install

# Build both workspaces (web -> web/dist, server -> server/dist/server.cjs).
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: runtime (bundled server + its production deps + web assets)
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app/server

# Install ONLY the server's production dependencies (fastify, drizzle,
# better-sqlite3, argon2, ...). The server bundle keeps packages external.
COPY server/package.json ./package.json
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && npm install --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# App artifacts.
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/drizzle ./drizzle
COPY --from=build /app/web/dist /app/web/dist

WORKDIR /app
ENV PORT=8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server.cjs"]
