# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.8
ARG VERSION=0.0.0
ARG REVISION=unknown

FROM oven/bun:${BUN_VERSION}-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS build
WORKDIR /app
ARG VERSION
ARG REVISION

COPY . .
RUN bun install --frozen-lockfile --filter @lush/app
RUN bun scripts/web-distribution.ts build "$VERSION" "$REVISION"

FROM nginxinc/nginx-unprivileged:1.30.3-alpine@sha256:b3f2436575bd5be7386518084d842dac414ab4962712afa31e99e0942a56e3b2 AS runtime

ARG VERSION=0.0.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Lush Web" \
      org.opencontainers.image.description="Web client for the Lush control plane" \
      org.opencontainers.image.source="https://github.com/openbydesign/lush" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV LUSH_API_URL=

COPY --from=build --chown=101:101 /app/apps/lush/dist /usr/share/nginx/html
COPY containers/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chmod=755 containers/web/05-lush-runtime-config.sh /docker-entrypoint.d/05-lush-runtime-config.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
