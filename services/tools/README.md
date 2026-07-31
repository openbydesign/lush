# Tools

Mediated access layer for MCP, OpenAPI, and other tool integrations. Models
receive scoped capabilities rather than raw URLs or credentials.

`services/tools` is the only path from an agent to an external tool. See
`docs/plans/managed-agents-tools-runtime.md` for the full design.

## What exists today (MVP)

### Connector plane (`src/connectors/`)

- `native.ts` — trusted, in-process Lush tools with explicit schemas and policy
  annotations. Ships one read-only tool (`current_time`).
- `mcp/` — a stateful **MCP Streamable HTTP client** (spec revision 2025-11-25)
  implemented without an external SDK: JSON-RPC 2.0, `initialize` and version
  negotiation, `Mcp-Session-Id` handling, `notifications/initialized`, paginated
  `tools/list`, `tools/call` over both `application/json` and bounded
  `text/event-stream` responses, and best-effort session termination. Sampling
  and elicitation are intentionally not honored — no MCP feature may bypass the
  run capability or approval model.
- OpenAPI is stubbed (`501`) until the normalized contract is exercised by both
  native and MCP sources.

Every connector normalizes into a Lush-owned `ToolResult`. External tool
descriptions and annotation hints are untrusted. Remote definitions receive the
restrictive Lush-owned risk class until an explicit review surface exists.

### Control plane (`src/runtime.ts`)

CRUD for organization- and user-scoped connections, encrypted credential
storage (`src/secrets.ts`), and catalog discovery/normalization. Reads are
scoped so a user never sees another user's private connection, and an
administrator gets governance metadata but not another user's secret. Shared
catalog refresh is a management operation and therefore administrator-only.

### Invocation plane (`src/gateway.ts`)

The single mediated call path: verifies principal + connection + definition
digest, validates input (`src/validate.ts`), makes a policy/approval decision,
resolves credentials server-side, invokes the connector under time/byte bounds,
normalizes and bounds the result, and persists an attributable `tool_call` with
audit. Callers must pass `expectedDefinitionDigest` (exposed on each
`ToolDefinition`) so a catalog change since capability resolution fails closed.
Idempotency keys are scoped to the initiating
principal, bound to the exact run/tool/definition/input, and reserve
approval-pending calls as well as running calls. Approvals are bound to the exact
normalized input digest and are atomically single-use: the approved call row is
reused on the follow-up invocation, and a later call with the same input requires
a fresh approval.

### SSRF-safe egress (`src/net/egress.ts`)

All remote connector traffic goes through an egress guard that enforces HTTPS,
blocks private/loopback/link-local/metadata destinations (defeating DNS
rebinding by connecting directly to the validated address with the original
Host/SNI identity), rejects cross-origin redirects before forwarding credentials,
and bounds JSON, SSE, and error bodies before buffering.

## Persistence

Migration `012_tool_gateway` adds `tool_connections`,
`tool_credential_bindings`, `tool_definitions`, `tool_calls`, and
`tool_approvals`. The HTTP surface is disabled by default through the
organization-level `tool_gateway_enabled` rollout flag.

## Not yet implemented

Full agent capability resolution, OpenAPI import, `stdio` MCP servers,
broker-issued run capability tokens, and MCP resources/prompts/roots.
