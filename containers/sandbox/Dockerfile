# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.8

FROM oven/bun:${BUN_VERSION}-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS install
WORKDIR /opt/lush

COPY . .
RUN bun install --frozen-lockfile --production --filter @lush/agent

FROM docker.io/cloudflare/sandbox:0.12.4@sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738

ARG VERSION=0.0.0
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Lush Agent Sandbox" \
      org.opencontainers.image.description="Digest-pinned Lush harness runtime for isolated managed-agent execution" \
      org.opencontainers.image.source="https://github.com/openbydesign/lush" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /workspace
COPY --from=install /opt/lush/package.json /opt/lush/bun.lock /opt/lush/
COPY --from=install /opt/lush/node_modules /opt/lush/node_modules
COPY --from=install /opt/lush/packages /opt/lush/packages
COPY --from=install /opt/lush/services /opt/lush/services

# The Cloudflare base image owns ENTRYPOINT and the sandbox control port.
# Agent turns invoke the fixed harness host through the Sandbox SDK.
