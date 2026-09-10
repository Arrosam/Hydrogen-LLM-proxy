# syntax=docker/dockerfile:1
# The console on its own: the built dashboard plus a small server that
# forwards the API paths to the gateway named by BACKEND_URL. Build from the
# repository root:  docker build -f apps/console/Dockerfile .

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/console/package.json apps/console/package.json
RUN npm install --no-audit --no-fund --workspace apps/console
COPY apps/console apps/console
RUN npm run build --workspace apps/console

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/apps/console/dist ./dist
COPY apps/console/serve.mjs ./serve.mjs

# The gateway this console talks to. Override at run time.
ENV BACKEND_URL=http://gateway:8080
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "serve.mjs"]
