# Agent

Service for agent harnesses and execution contexts. The first harness is
`lush`, a basic streaming chat agent with no tools.

For now, the harness uses the inference service runtime directly. The API
gateway remains the public entry point for first-party clients.

## Development

```sh
bun run agent:dev
```

The service listens on `http://127.0.0.1:7331`.

## Local Code sidecar

The desktop app launches a compiled sidecar from `src/code/sidecar.ts`. It owns
local Git worktrees, installed-harness discovery, process supervision, native
session bindings, normalized Code events, and the local session store. The
sidecar binds a random loopback port and requires a per-launch capability token
delivered over stdin by Tauri; it is not a public localhost API.

The dogfood adapters use one structured transport each:

- `codex exec --json`;
- `claude --print --output-format stream-json`; and
- `opencode run --format json`.

Run a credentialed two-turn behavioral canary in a temporary repository with:

```sh
bun run code:canary codex
bun run code:canary claude-code
bun run code:canary opencode openai/gpt-5.4-mini
```

Pull-request tests use sanitized fixtures and do not make inference calls.

## Auth

The standalone agent service verifies the same short-lived bearer access JWTs as
the API gateway:

- `GET /session` returns the active session profile.
- `POST /sessions/:sessionId/runs` atomically starts or reattaches to a durable
  chat run and streams persisted events.
- `GET /runs/:runId` and `GET /runs/:runId/events?after=<sequence>` fetch and
  resume an owned run.
- `POST /runs/:runId/cancel` durably cancels an owned run.
- `POST /agents/:agentSlug/chat` requires `Authorization: Bearer <token>`.
- `POST /agents/:agentSlug/prompt` requires `Authorization: Bearer <token>`.

Sign in and refresh through the API auth routes, then pass the returned
`accessToken` to direct agent requests. Set `LUSH_AUTH_JWT_PUBLIC_KEYS` to the
same keyed verification set so the agent can verify tokens during rotations.

## Chat Context

First-party Chat uses `POST /sessions/:sessionId/runs`. The server locks the
owned session, persists the user message, snapshots the built-in agent revision,
model, project context, and empty Phase 1 capability set, then executes the turn
through the subprocess harness. Assistant messages and sequenced events are
persisted before terminal completion, so disconnecting only detaches the event
subscriber. An exact idempotency-key retry reattaches to the same run.

`POST /agents/:agentSlug/chat` remains a compatibility endpoint for older
clients. `POST /agents/:agentSlug/prompt` is the raw programmatic inference
surface and does not create a Chat product run.

## Inference Configuration

- `LUSH_APP_ORIGIN` - CORS origin for the app; defaults to `*`.

Inference providers are organization-scoped database state managed through the
API/UI.
