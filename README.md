# lush

Open control plane for multi-model AI applications and agent runtimes.

## Workspace Layout

- `apps/*` - end-user applications. `apps/lush` is the shared React app packaged for web, desktop, iOS, and Android through Tauri.
- `services/*` - deployable backend services and control-plane boundaries.
- `packages/*` - shared domain packages such as skills and memory.

## Prerequisites

- Bun 1.3.x. This repo is pinned to `bun@1.3.8` in `package.json`.
- Docker with the Docker daemon running. Local development uses Docker Compose
  for PostgreSQL.
- Rust 1.88 or newer only if you are running or building the Tauri desktop app.

## Dependencies

Install workspace dependencies from the repository root:

```sh
bun install
```

Local development defaults live in `.env.template`. The root dev target creates
`.env.development` from that template the first time it runs, generating a
local-only JWT keypair, `LUSH_SECRET_KEY`, and independent
`LUSH_TOOL_CREDENTIAL_KEY` on the fly. `.env.development` is
ignored by git.

## Quickstart

```sh
bun run dev
```

The root dev command is a local development orchestrator. It preflights Docker
with `docker ps`, fails fast if Docker is not running, creates
`.env.development` if needed, starts the
`lush-postgres` Compose service, waits for PostgreSQL, applies migrations, runs
API client codegen, starts the local Hono API gateway, starts the Lush app,
starts the docs site, prefixes logs by service, and writes service logs to
`logs/<service>.log`.

Local services:

- App: `http://localhost:5874`
- API: `http://localhost:7330`
- Docs: `http://localhost:7332`

The app uses port `5874` because those are the touch-tone phone digits for
`LUSH`.

Open the app URL printed by the app service, register with an email/password,
then verify that email in a second terminal:

```sh
bun run auth:verify-email -- user@example.com
```

After verification, sign in with the same email/password.

Email verification is required before any account can receive or use an app
session. Hosted deployments must prove that a user controls the email address
before granting access. Local development simulates the email link by updating
the same database state a real verification flow would update; there is no
environment variable to bypass this requirement.

The browser app keeps durable login state in an HttpOnly refresh cookie issued
by the API. It caches only the short-lived access JWT in tab-scoped
`sessionStorage`, so reloads and hot updates can reuse a valid access token
without exposing the refresh token to JavaScript.

Press `Ctrl-C` to stop the local stack. The dev orchestrator stops child
processes and stops the `lush-postgres` container while preserving its data
volume.

## Useful Commands

- `bun run app:dev` - Vite app only.
- `bun run api:dev` - local API gateway only.
- `bun run agent:dev` - standalone agent service only.
- `bun run docs:dev` - local docs site only.
- `bun run api:codegen` - regenerate `@lush/api-client`.
- `bun run db:up` - start local PostgreSQL.
- `bun run db:down` - stop local PostgreSQL and remove compose resources.
- `bun run db:logs` - follow local PostgreSQL logs.
- `bun run db:migrate` - apply PostgreSQL migrations.
- `bun run auth:keygen` - generate a dotenv-ready JWT signing key and keyed
  verification set.
- `bun run auth:verify-email -- user@example.com` - mark a local development
  account email as verified.

## Checks

```sh
bun test
```

The root test command runs repo-wide checks: API client codegen, `tsgo`
typechecking for the shared API client and app, and bundle checks for the API
and agent services.

## Deployment and releases

Lush publishes version-matched API and browser-app container images for both
managed and self-hosted deployments. See the [self-hosting guide](services/docs/content/docs/setup/self-hosting.mdx)
for an end-to-end single-host deployment, email-provider integration, and the
external-auth extension boundary. [Deployment artifacts](docs/deployment.md)
defines the image runtime contract, and [Releases](docs/releases.md) defines the
repository-wide SemVer policy and release process.
