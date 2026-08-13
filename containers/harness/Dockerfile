# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.8

FROM oven/bun:${BUN_VERSION}-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS install
WORKDIR /opt/lush

COPY . .
RUN bun install --frozen-lockfile --production --filter @lush/agent

FROM oven/bun:${BUN_VERSION}-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS runtime

ARG VERSION=0.0.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Lush Agent Harness" \
      org.opencontainers.image.description="Provider-neutral Lush harness runtime for isolated managed-agent execution" \
      org.opencontainers.image.source="https://github.com/openbydesign/lush" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /workspace
COPY --from=install /opt/lush/package.json /opt/lush/bun.lock /opt/lush/
COPY --from=install /opt/lush/node_modules /opt/lush/node_modules
COPY --from=install /opt/lush/packages /opt/lush/packages
COPY --from=install /opt/lush/services /opt/lush/services

USER bun
ENTRYPOINT ["bun", "run", "/opt/lush/services/agent/src/harness/harness-host.ts"]
