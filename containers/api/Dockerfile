# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.8

FROM oven/bun:${BUN_VERSION}-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS install
WORKDIR /app

COPY . .
RUN bun install --frozen-lockfile --production --filter @lush/api

FROM oven/bun:${BUN_VERSION}-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS runtime

ARG VERSION=0.0.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Lush API" \
      org.opencontainers.image.description="Open control plane for multi-model AI applications and agent runtimes" \
      org.opencontainers.image.source="https://github.com/openbydesign/lush" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    LUSH_API_HOST=0.0.0.0 \
    LUSH_API_PORT=7330

WORKDIR /app
COPY --from=install --chown=bun:bun /app/package.json /app/bun.lock ./
COPY --from=install --chown=bun:bun /app/node_modules ./node_modules
COPY --from=install --chown=bun:bun /app/packages ./packages
COPY --from=install --chown=bun:bun /app/services ./services

USER bun
EXPOSE 7330

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "const response = await fetch('http://127.0.0.1:7330/health'); if (!response.ok) process.exit(1)"]

CMD ["bun", "run", "services/api/src/server.ts"]
