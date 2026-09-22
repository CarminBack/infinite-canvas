# Build the v0.19 Vite frontend.
FROM oven/bun:1.3.13 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# Serve the SPA and keep OAuth credentials in the server-side gateway.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/public \
    CANVAS_DATA_DIR=/app/data
WORKDIR /app
COPY --from=web-build /app/web/dist ./public
COPY server ./server
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/server.mjs"]
