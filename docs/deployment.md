# Deployment artifacts

This repository owns portable Lush build artifacts and their runtime contract.
A managed-service repository may own cloud resources, environment-specific
configuration, secrets, rollout policy, and operational automation, but it
should deploy the same release artifacts documented here. Self-hosted
deployments can consume the images directly or serve the signed static web
distribution from purpose-built static infrastructure.

The [self-hosting guide](../services/docs/content/docs/setup/self-hosting.mdx)
provides a runnable single-host Compose stack plus configuration, SMTP,
security, upgrade, backup, and future external-auth guidance. This document is
the lower-level image contract for deployment implementations.

## Images

### `lush-api`

`ghcr.io/openbydesign/lush-api:<version>` runs the public API on port `7330` as
an unprivileged user. It also contains the database migration command, keeping
schema changes and application code on the same release coordinate.

Run migrations as a release job before starting the new API version:

```sh
docker run --rm \
  --env DATABASE_URL \
  ghcr.io/openbydesign/lush-api:0.1.0 \
  bun run db:migrate
```

Then run the service with the environment described in `.env.template`. At a
minimum, production deployments need PostgreSQL, secret and JWT key material,
the public app URL and origin, email delivery configuration, and an explicit
HTTPS/trusted-proxy policy. `GET /health` is the process health endpoint.

Migrations are forward-only and should be safe to complete before the new
application rollout. A future migration that cannot preserve that ordering
must ship as an explicit expand/migrate/contract sequence across releases.

### `lush-web`

`ghcr.io/openbydesign/lush-web:<version>` serves the browser app as an
unprivileged user on port `8080`. It is a topology-neutral static origin: it
serves built assets, SPA fallbacks, `GET /healthz`, and runtime browser
configuration, but it never proxies API traffic. Deployments terminate TLS and
route web/API traffic at their operator-managed ingress. The browser uses the
page origin by default, so the same immutable bundle works across deployments
without rebuilding environment-specific API URLs. The web origin returns `404`
for `/health`, `/v1beta`, and `/v1beta/*` so an ingress routing error cannot
masquerade as API health or return the SPA for an API request.

Runtime environment:

- `LUSH_API_URL` is the public API base URL used directly by the browser, for
  example `https://api.example.com`. It is written into a non-cacheable runtime
  config when the container starts, so changing environments does not rebuild
  the image. It defaults to empty.

When `LUSH_API_URL` is set, configure the API's `LUSH_APP_ORIGIN` to allow the
web origin. When it is empty, the browser uses its page origin. The ingress must
route `/v1beta`, `/v1beta/*`, and `/health` directly to the API and route all
remaining paths to the web image. Configure `LUSH_TRUSTED_PROXIES` on the API
with only the ingress socket peers that supply forwarding headers. If a private
gateway has dynamic peers that cannot be allowlisted, configure
`LUSH_TRUSTED_PROXY_SECRET` instead and have the gateway replace
`X-Lush-Proxy-Secret` on every request.

The ingress owns TLS, forwarding-header normalization, streaming timeouts,
response buffering policy, public exposure, and any shared rate limits.

The Tauri app is intentionally different: it is not served from a browser
origin and still requires an explicit `VITE_LUSH_API_BASE_URL` at build time.

### `lush-harness`

`ghcr.io/openbydesign/lush-harness:<version>` is the provider-neutral
managed-agent harness image. It ships the version-matched harness under
`/opt/lush` with `harness-host.ts` as its entrypoint. Provider repositories may
run it directly or copy its immutable payload into a provider-specific runtime
image. It is not a public API service and accepts no provider, database, model,
or connector credentials.

Deployments must select it by digest, run only an approved harness ID, and
broker short-lived run capabilities across an authenticated control plane.
Provider SDKs, base images, network policy, and final sandbox image publication
belong to the provider deployment rather than this repository.

`LUSH_SANDBOX_BROKER_BASE_URL` must be executor-affine: every broker request
for a run must reach the API process that owns its execution lease. A
single-instance deployment satisfies this directly; a multi-replica deployment
must route the run-ID broker path to its lease owner. If that process exits,
the active broker stream ends and normal lease recovery creates a new broker
context and capability token. Deployments must not retry an old token against
an arbitrary replica.

### Static `lush-web` distribution

`lush-web-dist-<version>.tar.gz` contains the same Vite output as the web image,
plus `lush-manifest.json` with its version and Git revision. It is an equally
supported browser deployment artifact for CDNs, object storage, and static web
servers; the image remains the supported choice when a packaged nginx origin,
startup-generated runtime configuration, and `/healthz` are useful.

Verify the archive and provenance as documented in [Releases](./releases.md),
then extract it directly into the static host's document root. Configure the
host to:

- serve existing assets normally and fall back to `index.html` for browser
  routes;
- serve `runtime-config.js` without caching;
- route `/v1beta`, `/v1beta/*`, and `/health` to the API for same-origin
  deployments.

The archive's `runtime-config.js` is deliberately empty, so same-origin hosts
need no mutation. For a split-origin deployment, replace that file at deploy
time, without rebuilding the bundle:

```js
window.__LUSH_CONFIG__ = Object.freeze({
  apiBaseUrl: "https://api.example.com"
});
```

Set the API's `LUSH_APP_ORIGIN` to the static site's origin. The static artifact
does not provide nginx's `/healthz`; use the hosting platform's native health
and availability checks.

## Deployment order

For a single release:

1. Resolve the API, harness, and chosen web artifact to the same exact version
   or recorded digests.
2. Build or select the provider sandbox from the exact harness digest and roll
   it out without product traffic.
3. Run the API image's migration command once with deployment-level locking.
4. Roll out the API image and wait for `/health`.
5. Roll out the web image or verified static distribution and verify its SPA,
   runtime config, and API routing.
6. Qualify a sandboxed agent run, then record the Git tag, image digests, and
   migration result in the deployment.

Do not run migrations implicitly in every API replica. A distinct migration
job makes failure, locking, and rollout ordering observable in both managed and
self-hosted environments.

## Local image builds

```sh
docker build -f containers/api/Dockerfile -t lush-api:local .
docker build -f containers/harness/Dockerfile -t lush-harness:local .
docker build -f containers/web/Dockerfile -t lush-web:local .
```

Pull requests build every image without publishing it. Release builds publish
the API, harness, and web images for `linux/amd64` and `linux/arm64`.
