# Managed Agents, Tool Gateway, and Sandboxed Runtime

Status: proposed

Date: July 20, 2026

## Decision summary

Lush should evolve the current direct chat-to-inference path into one agent
platform with five durable control-plane nouns:

1. **Tool connection**: a configured integration, owned by an organization or
   privately by a user within an organization.
2. **Managed agent**: a versioned agent definition plus a scoped installation
   that selects tools, skills, memories, instructions, model policy, and an
   execution profile.
3. **Agent run**: one durable execution of an agent in a session, with an
   immutable configuration and capability snapshot.
4. **Tool call**: one gateway-mediated invocation made by a run on behalf of
   its calling principal.
5. **Agent environment**: the execution venue for a run, providing the isolation
   boundary whenever capabilities are enabled; it is ephemeral for ordinary chat
   or bound to a session when work, such as coding, must persist across turns.

`services/tools` is the only path from an agent to an external tool.
`services/agent` resolves agent configuration and orchestrates runs.
Capability-enabled managed-agent runs always execute in an isolated sandbox
provided by a pluggable isolation provider. The sandbox receives definitions and
short-lived capabilities, never provider or tool credentials. The temporary
no-capability execution exemption does not bypass the durable run lifecycle. The
`services/agent` orchestrator is a stateless coordinator, which keeps the API tier
horizontally scalable. First-token latency is protected by warm provider capacity
(see [Execution model and scaling](#execution-model-and-scaling)).

The existing Lush chat becomes the first managed agent rather than remaining a
special-case inference endpoint. From Phase 1 onward, every Chat product turn is
a durable `AgentRun`, including a turn with no tools, brokered memory, or
executable skills. Run identity and execution venue are separate: the temporary
no-capability exemption changes where that run's model loop may execute, not
whether the turn receives durable events, idempotency, cancellation, and
recovery. Programmatic consumers may still call the raw inference API outside
Chat; those calls do not create a session or agent run.

```text
App/API -> agent control plane -> isolated runner
                                  |-- inference capability -> inference broker
                                  |-- tool capability ------> tool gateway -> connector
                                  `-- scoped handles -------> memory/artifact brokers
```

The control plane resolves identity and policy. The isolated runner performs
the bounded model loop. Brokers retain credentials, authorization, durable
state, and external side effects outside the sandbox.

The orchestrator-to-runner boundary follows the contracts of Google's
open-source [Agent Executor (AX)](https://github.com/google/ax) distributed
agent runtime: the isolated runner is a pluggable, AX-compatible harness. Lush
adopts AX's *contracts* (harness stream, durable `ConversationEvent` log,
protocol-neutral message model), not AX as a dependency or its transport as the
domain model. See
[Agent Executor (AX) protocol alignment](#agent-executor-ax-protocol-alignment).

## Goals

- Support organization-shared and user-private tool configuration without
  leaking a user's connection, credentials, or data to other organization
  members.
- Let an agent receive only a subset of the tools available to the calling
  principal. Agent configuration must never expand that principal's authority.
- Put model and skill execution behind a replaceable sandbox boundary with
  explicit filesystem, network, time, compute, and spend limits.
- Unblock hosted coding-agent sessions by reusing the managed sandbox,
  environment lifecycle, harness adapters, and durable event contract from any
  client. Code is currently limited to the desktop-launched local sidecar.
- Preserve a fast first-token path for ordinary chat while making tool calls,
  approvals, cancellation, reconnection, and background continuation durable.
- Make `lush` the built-in managed agent and use the same model for future
  organization and user agents.
- Make instructions, tools, skills, memories, models, and execution policy
  explicit, independently governable inputs to an immutable agent revision.
- Support MCP, OpenAPI, and native Lush tools without making any external SDK
  or protocol Lush's canonical domain model.
- Keep all consequential actions attributable to the initiating user,
  organization, agent revision, run, tool connection, and tool call.

## Non-goals

- A general workflow/DAG builder in the first release.
- Autonomous privilege acquisition or silent escalation from chat into a more
  capable execution environment.
- Passing raw user access tokens, tool secrets, or inference credentials into
  a sandbox.
- Running arbitrary local MCP commands on an API host.
- Treating a skill's declared dependencies as authorization to use them.
- Exposing every installed tool to every model invocation. Progressive tool
  discovery can be added after the explicit-capability path is correct.

## Current repository state

The current implementation already has useful seams:

- `services/agent/src/runtime.ts` builds the Lush system prompt and directly
  calls `streamInferenceChat`.
- `services/agent/src/agents/lush.ts` defines one hard-coded `lush` agent whose
  session discriminator is `lush-chat`.
- `services/api/src/server.ts` and the standalone agent server expose
  `/agents/:agentSlug/chat` and `/agents/:agentSlug/prompt`.
- `services/sessions` owns sessions, messages, project instructions, project
  memory, and context items. A session currently stores an unconstrained text
  `agent_id`.
- `services/inference` emits only text chunks. Its provider interface does not
  yet represent tool definitions, tool calls, usage, or structured stop
  reasons.
- The app's agent stream and message-part contracts already support reasoning,
  tool input/output, sources, and artifacts. The backend currently emits only
  the text lifecycle subset.
- The browser currently creates the user message, invokes the agent, consumes
  the stream, and then persists the assistant message. A dropped connection
  can therefore lose the authoritative completion.
- `services/tools`, `services/skills`, `packages/skill-catalog`, and
  `packages/memory` are intentional but mostly empty boundaries.
- Code execution currently runs through the Tauri-launched local sidecar, which
  owns local repositories, worktrees, harness processes, and bindings. The
  hosted app has no managed executor even though `docs/plans/code.md` already
  defines managed sandbox mode as the intended cross-client path.
- `docs/session-orchestration.md` already establishes sessions and delegated
  child sessions as the product model for chat, code, background work, and
  custom agents.

The plan should extend these boundaries rather than add a parallel chat or
automation stack.

## Ownership and scope

### Tool scope

A tool connection always belongs to one organization. It has exactly one of
two visibility scopes:

```text
organization scope: organization_id = O, owner_user_id = null
user scope:         organization_id = O, owner_user_id = U
```

A "personal" connection is intentionally not global to a user. The same user
may connect different accounts in different organizations, and switching the
active organization must not carry a private connection across the boundary.

- Organization administrators create, update, disable, and set policy for
  organization connections.
- A normal user may use an organization connection only when its policy allows
  the principal's role and requested operation.
- A user creates and uses their own user-scoped connections. Organization
  administrators may see governance metadata and disable the feature, but do
  not receive the secret or the ability to invoke as that user merely by being
  an administrator.
- Organization policy may deny a tool, cap risk, require approval, constrain
  resources, or disallow private connections. It cannot silently convert a
  private credential into an organization credential.

### Agent scope

Managed agent definitions have one of three ownership classes:

- **system**: shipped and signed by Lush; readable but not directly editable;
- **organization**: managed by organization administrators and available under
  organization policy; or
- **user**: private to a user inside one organization.

An agent installation makes a specific definition available at organization or
user scope and carries the mutable local configuration. Publishing creates an
immutable revision. A run pins the exact definition revision and resolved
installation revision so later edits do not change an in-flight or historical
run.

The built-in `lush` definition is system-owned and automatically installed for
each organization. Organization policy can constrain it. Each user may apply a
private overlay for user instructions, personal tool connections, skills, and
memory namespaces. The canonical Lush base prompt remains immutable.

Installation inheritance is deliberately shallow: an optional user
installation overlay references one organization installation, and both pin a
managed-agent revision. Arbitrary chains and mixins are not supported. The
resolver records both installation revisions on the run so the final
configuration remains explainable.

## Core domain model

### Tools

```ts
type ToolConnection = {
  id: string;
  organizationId: string;
  ownerUserId: string | null;
  source: "mcp" | "openapi" | "native";
  label: string;
  endpointConfig: unknown;
  credentialMode: "none" | "organization" | "user_delegated";
  enabled: boolean;
  policy: ToolConnectionPolicy;
  catalogVersion: string | null;
};

type ToolCredentialBinding = {
  id: string;
  connectionId: string;
  subjectUserId: string | null;
  credentialRef: string;
};

type ToolDefinition = {
  id: string;                 // stable Lush id
  connectionId: string;
  externalName: string;
  qualifiedName: string;      // stable model-facing alias
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations: {
    readOnly: boolean;
    destructive: boolean;
    idempotent: boolean;
    openWorld: boolean;
  };
  definitionDigest: string;
};
```

`ToolConnection` is the configured integration. `ToolCredentialBinding`
separates the account used for a call from connection ownership: an
organization service credential has no `subjectUserId`; a private or delegated
OAuth credential is bound to the user. `ToolDefinition` is a discovered or
registered capability. Keeping these separate allows one MCP server or OpenAPI
document to expose many tools, permits a future shared connection with
per-user OAuth, and lets catalog changes be reviewed independently from
credentials.

Secrets belong in an encrypted secret store behind opaque `credentialRef`
values. Database rows may contain encrypted envelopes during the first
implementation, following the inference provider pattern, but domain APIs and
run payloads must never expose ciphertext or plaintext.

### Managed agents

```ts
type ManagedAgentRevision = {
  id: string;
  agentId: string;
  version: number;
  baseInstructions: string;
  modelPolicy: ModelPolicy;
  executionProfile: ExecutionProfile;
  capabilityPolicy: AgentCapabilityPolicy;
  defaultToolSelectors: ToolSelector[];
  skillBindings: VersionedSkillBinding[];
  memoryBindings: MemoryBinding[];
  limits: AgentLimits;
  digest: string;
};

type AgentInstallationRevision = {
  id: string;
  installationId: string;
  agentRevisionId: string;
  parentInstallationRevisionId: string | null;
  additionalInstructions: string;
  capabilityPolicy: AgentCapabilityPolicy;
  toolSelectors: ToolSelector[];
  skillBindings: VersionedSkillBinding[];
  memoryBindings: MemoryBinding[];
  modelOverride: ModelPolicy | null;
  digest: string;
};
```

Selectors reference stable connection and tool definition ids, not copied
names or credentials. New tools discovered on a connection are denied by
default. An explicit selector such as "all read-only tools from this
connection, including future additions" is allowed only as a visible,
intentional policy choice.

The agent revision defines the broadest capability classes the agent is
compatible with. An organization installation narrows that ceiling and decides
whether user overlays may add private tools under bounded source/risk classes.
A user overlay can only narrow policy further, even when its explicit selectors
add a private connection to the selected set.

Skills are pinned by immutable version or content digest. A skill may declare
required tools and runtime features for validation and UX, but those
declarations do not grant capabilities. Memory bindings identify namespaces,
read/write modes, retrieval limits, and ACL scope; they do not embed the
retrieved memory in the agent definition.

### Runs and calls

```ts
type AgentRun = {
  id: string;
  organizationId: string;
  sessionId: string;
  originMessageId: string;
  initiatedByUserId: string;
  agentRevisionId: string;
  installationRevisionIds: string[];
  environmentId: string;
  status: "queued" | "running" | "waiting_for_approval" |
          "needs_acknowledgment" | "completed" | "failed" | "cancelled";
  capabilityDigest: string;
  isolationProvider: string;   // provider kind, e.g. "subprocess"
  untrustedContentIngested: boolean;
  limits: AgentLimits;
};

type AgentEnvironment = {
  id: string;
  organizationId: string;
  ownerUserId: string;
  sessionId: string;
  profile: "chat" | "code" | "work";
  status: "provisioning" | "ready" | "running" | "idle" |
          "hibernated" | "failed" | "destroyed";
  isolationProvider: string;   // provider kind, e.g. "subprocess"
  imageDigest: string;
  limits: EnvironmentLimits;
};

type ToolCall = {
  id: string;
  runId: string;
  toolDefinitionId: string;
  connectionId: string;
  initiatedByUserId: string;
  status: "proposed" | "waiting_for_approval" | "running" |
          "succeeded" | "failed" | "denied" | "cancelled" |
          "outcome_unknown";
  idempotencyKey: string;
  input: unknown;
  outputRef: string | null;
  policyDecision: unknown;
};

type RunAcknowledgment = {
  id: string;
  runId: string;
  toolCallId: string;
  decidedByUserId: string;
  decision: "retry" | "abandon";
  inputDigest: string;
  toolDefinitionDigest: string;
  createdAt: string;
};
```

A run is normally one user turn. A session contains many runs. An ordinary
chat run can receive a fresh ephemeral environment. A Code session binds its
runs to one environment so repository and harness state can survive between
turns. Long-running or delegated work uses the same run contract in a child
session; it is not a new agent type.

## Effective capability resolution

The calling principal is the upper bound. A revision's capability policy is a
ceiling; installation selectors choose tools beneath that ceiling. An
organization installation can provide shared defaults, while a user overlay
can add that user's private connections if the agent ceiling and organization
policy allow them. The effective tool set is:

```text
eligible = principal-visible tools in the active organization
           intersect organization policy
           intersect managed-agent capability ceiling
           intersect each applicable installation capability ceiling
           intersect execution-profile policy

selected = agent defaults
           union selectors from each applicable installation revision

effective = eligible intersect selected intersect optional session/run subset
```

Selection never bypasses an eligibility intersection. An absent optional user
overlay contributes neither a ceiling nor selectors; missing required policy
fails closed. A user overlay may add a private tool to an agent, but only
because the tool was already available to that user and permitted by the agent
and organization ceilings; it does not elevate the principal.

The resolver returns both the effective definitions and a structured reason
for every exclusion. This powers configuration UX and avoids presenting an
agent as configured when its tools are unavailable to the current user.

The resolved set is snapshotted for model consistency and audit, but the
gateway rechecks live membership, connection status, revocation, policy, and
approval immediately before each invocation. Removing a user from an
organization or disabling a connection stops subsequent calls in an already
running agent.

Background runs preserve attribution to the initiating user. They do not gain
a service principal by waiting. A future explicit service-agent identity is a
different principal type with its own policy and should not be simulated with
an organization credential.

## Tool gateway

`services/tools` owns three related planes.

### Control plane

- CRUD for organization and user tool connections.
- OAuth initiation/callback and credential lifecycle.
- Catalog discovery, schema normalization, versioning, health, and change
  review.
- Agent-facing capability resolution and human-readable policy explanations.
- Connection test calls that use the same authorization and audit path as
  runtime calls.

External descriptions and risk annotations are untrusted hints. Lush-owned
policy metadata is authoritative, and an unreviewed or changed tool defaults to
the more restrictive risk and approval class.

### Invocation plane

- Authenticate a short-lived run capability token.
- Verify the run, principal, organization, tool, connection, definition digest,
  input schema, policy, approval, budget, rate limit, and idempotency key.
- Resolve credentials server-side and invoke the source adapter.
- Bound time, redirects, response bytes, content types, and concurrency.
- Normalize success and failure into a Lush-owned `ToolResult`.
- Persist the tool call and emit audit/telemetry before returning a bounded
  result to the sandbox.

### Connector plane

- `native`: trusted Lush implementation registered in code with explicit
  schemas and policy annotations.
- `openapi`: imported operations normalized into tool definitions; the import
  UI requires review of operation selection, auth, base URL, and risk flags.
- `mcp`: a fully stateful MCP client supporting current Streamable HTTP,
  authorization and incremental scopes, initialization/version negotiation,
  pagination, tool-list changes, cancellation, tasks, and bounded results.

MCP sessions and OAuth state belong to the gateway connection worker, keyed by
connection, principal, and run as required. An MCP session id is transport
state, never authentication. Remote production endpoints require HTTPS and
SSRF-safe egress. Legacy HTTP+SSE can be an explicit compatibility mode.

The MCP worker should implement the full negotiated client lifecycle rather
than a one-off `tools/call` wrapper. Tools are the first normalized surface.
Resources can later feed context and memory, prompts can feed skill/template
imports, roots must map to explicitly granted artifact/workspace handles,
elicitation must become a Lush user-interaction event, and server-requested
sampling must route through the inference broker and normal model policy. No
MCP feature may bypass the run capability or approval model.

Local `stdio` MCP servers are deferred until there is a dedicated connector
sandbox. When introduced, the configured executable and arguments must be
shown in full for consent, pinned where possible, and run without host home,
SSH, cloud metadata, or ambient network access. They must not execute inside
the API process or inherit the API service account.

## Authorization and approval

Authorization and approval are separate decisions:

- **Authorization** answers whether this principal, agent, run, and connection
  may invoke this tool against the requested resource.
- **Approval** answers whether an otherwise authorized call requires a human to
  confirm this concrete input now.

Policy inputs include scope, user and membership, role, managed agent,
connection, tool annotations, input-derived resource identifiers, side-effect
class, cost, environment, prior approval, and organization rules.

Approval policy should support `never`, `once_per_run`, `once_per_resource`,
and `every_call`. Destructive or open-world calls default to explicit approval.
An approval binds the normalized input digest, tool definition digest, run,
principal, and expiration. Editing arguments invalidates the approval.

The Phase 2 connection-level `never` setting is an explicit manager override of
that default, including for destructive and open-world calls. Only the owner may
set it on a private connection and only an organization administrator may set it
on a shared connection. It removes the human confirmation step, not live
authorization, definition/input binding, idempotency, or audit enforcement, and
the settings surface must present the destructive-call consequence clearly.

The gateway returns `approval_required` rather than letting a sandbox invent a
consent prompt. `services/agent` persists the paused run and streams an approval
event to the client. The client submits the decision to an authenticated
control-plane endpoint; it never sends an approval token through model text.

## Sandboxed agent runtime

The provider-neutral lifecycle is tracked in
[#66](https://github.com/openbydesign/lush/issues/66); isolation, broker, and
hosted Code security requirements are tracked in
[#69](https://github.com/openbydesign/lush/issues/69).

### Boundary

The orchestrator-to-runtime boundary follows the contracts of Google's
open-source [Agent Executor (AX)](https://github.com/google/ax): durable
resumable execution, a harness-agnostic runtime seam, per-conversation
single-writer consistency, and a protocol-neutral message model. The boundary is
implementation-neutral — the same contract is satisfied by a subprocess or a
remote AX server, so swapping providers never changes the orchestrator. The full
protocol mapping is in the
[Agent Executor (AX) protocol alignment](#agent-executor-ax-protocol-alignment)
section.

`services/agent` exposes two orthogonal seams that mirror AX. The *harness
contract* says what a turn looks like; the *isolation provider* says where and
how that harness runs. Keeping them separate is what makes isolation switchable:
the orchestrator only ever holds a `Harness`, never a process, container, or
remote sandbox handle.

```ts
// Runtime contract — what a harness implements. Mirrors AX HarnessService.
// AX wire equivalent: rpc Connect(stream HarnessRequest) returns (stream HarnessResponse).
interface Harness {
  connect(
    request: HarnessStart, // { harnessConfig, messages }
    signal: AbortSignal
  ): AsyncIterable<HarnessResponse>; // Outputs* then exactly one End{state,error}
}

// Isolation provider — where/how a harness runs and how it is reached. This is
// the switchable strategy: subprocess today; Cloudflare/Vercel sandboxes,
// Substrate actors, or gVisor/Kata/microVM later. In AX terms this is the
// compute layer (Substrate actors), keyed by conversation/session id.
interface IsolationProvider {
  readonly kind: string; // "subprocess" | "cloudflare" | "vercel" | "substrate" | ...
  provision(spec: EnvironmentSpec): Promise<AgentEnvironmentHandle>;
  resume(environmentId: string): Promise<AgentEnvironmentHandle>;  // AX ResumeActor
  hibernate(environmentId: string): Promise<void>;                 // AX SuspendActor
  destroy(environmentId: string): Promise<void>;                   // AX DeleteConversation / teardown
}

// The live handle for a provisioned environment. The persisted `AgentEnvironment`
// row (see Core domain model) is the same concept at the storage layer.
interface AgentEnvironmentHandle {
  readonly id: string;
  readonly kind: string;
  harness(): Harness; // a Harness bound to this boundary's transport
  hibernate(): Promise<void>;
  destroy(): Promise<void>;
}
```

`services/agent` is the AX-equivalent controller: it drives the harness turn,
enforces one in-flight execution per conversation, appends an append-only
`ConversationEvent` log, and exposes a client-facing `Exec` stream. The durable
run/stream model below is the Lush projection of that log.

The provider provisions an isolated environment and returns a `Harness` bound to
that environment's transport (subprocess stdio or remote gRPC/HTTP). The same
orchestrator code runs against every provider.

`IsolationProvider` is a single interface with several implementations:

- `cloudflare` / `vercel` / `substrate` / `microVM` (gVisor, Kata): production
  providers, each over a real isolation boundary (read-only root, no host mounts,
  network policy, non-root, syscall filtering — see
  [Isolation defaults](#isolation-defaults)). Choosing between them is a change of
  transport, not contract.
- `subprocess`: a reference implementation for local development. It runs a
  harness in a child process over NDJSON on stdio (peer of AX's
  `CloseSend`-after-`Start` flow), with wall-clock and output bounds, cancel/
  timeout as `SIGKILL`, an empty per-environment ephemeral workspace as cwd, and
  credential scrubbing (the child inherits only an explicit env allowlist — no
  host secrets, no dotenv). It exercises the exact serialization/streaming a
  production provider needs, but it shares the kernel, filesystem, and network
  and is never a production isolation boundary.

The contract, not the infrastructure vendor, is the durable decision. Every
capability-enabled run executes in an isolating provider and fails closed when no
such provider is available. The Phase 1 no-capability Chat exemption changes only
the execution venue, not the durable `AgentRun` contract.

The environment and run lifecycles are separate. Cancelling a run stops its
processes and revokes its broker capabilities; it does not necessarily destroy
a session-bound Code environment. Archiving, policy revocation, explicit hard
termination, or retention expiry destroys that environment. Ephemeral chat
environments are destroyed after the run.

Process ownership is per run, even in a persistent environment. Processes a run
spawns are reaped at that run's boundary (completion or cancellation); they do
not leak into the next run. The one deliberate exception is an explicitly
declared long-lived service — e.g. a Code preview/dev server the user asked to
keep running across turns — which is owned by the environment, tracked as such,
and torn down when the environment is destroyed. An environment-owned service
never receives a run broker token and cannot access the broker-refresh channel;
external actions on its behalf require mediation by the active run. A run never
inherits authority over another run's transient processes; this is the same
orphan-reaping discipline the local sidecar owes, one level up.

### Execution model and scaling

Every Chat product turn from Phase 1 onward is a managed-agent run and follows
the durable run lifecycle. A no-capability run may temporarily use the
non-isolating `subprocess` development provider under the security exemption
below; a capability-enabled run requires a production isolating provider.
Programmatic raw-inference calls outside Chat create neither a session nor an
`AgentRun` and remain outside this runtime.

The `services/agent` orchestrator is a **stateless coordinator**. It drives the
provider's harness stream, appends the `ConversationEvent` log, enforces
single-writer, and relays events to the client — all I/O-bound. The model loop,
untrusted output, and executable skills run inside the provider. This keeps the
API tier horizontally scalable:

- The API performs coordination, not model compute, so a replica can carry many
  concurrent runs, and new runs load-balance to any replica.
- All durable run state lives in the event log (plus the provider environment for
  session-bound work). A run interrupted by a replica restart, deploy, or crash
  resumes on another replica from the log — the same resume/`last_step` path used
  for client reconnect. No run state is pinned to a replica's memory.
- A streaming connection is inherently tied to one replica for its duration;
  reconnects hit the event endpoint, which reads the durable log, so no sticky
  routing is required.

First-token latency is protected by **warm, paused provider capacity** — pooled
subprocess children in development, paused microVMs or clean images in production
— so a run attaches to an already-hot environment within the TTFT budget instead
of paying a cold provision. The measured warm-attach latency per provider sets
the pool sizing and the TTFT SLO.

#### Default chat once tools are enabled

The no-capability chat execution exemption is transitional: once the built-in
Lush agent enables tools (Phase 4), every default chat message is potentially
capability-enabled and must run in an isolating provider, so all chat then pays
warm-attach plus broker hops. That end state must hold the same first-token feel,
so its shape is decided now (it constrains the Phase 1 orchestrator, not just
Phase 3):

- **Budget.** Warm-attach must fit inside an explicit per-turn TTFT budget
  (target set in open decision 7). Warm-attach that cannot meet the budget is a
  provider disqualifier, not something to paper over.
- **Parallel control-plane preparation.** The orchestrator overlaps environment
  attach with independent preparation — capability resolution, context assembly,
  and run-token minting — but does not start inference. The sandbox starts the
  inference-broker call only after attach and after it receives the immutable run
  bundle, preserving the model-loop boundary. TTFT is therefore
  `max(attach, preparation) + in-sandbox-first-token`, and the Phase 1
  orchestrator is structured for this overlap even before tools exist.
- **Empty-pool degradation.** When no warm environment is available (notably
  during a deploy — a week-one event, not an edge case), the policy is explicit
  and bounded: briefly queue against a deadline, cold-provision if within budget,
  and otherwise fail closed with a retry-after signal. A capability-enabled run
  never sheds to a non-isolating path to save latency.

### Run bundle

The sandbox receives a bounded, immutable bundle:

- run, session, principal-subject, and agent revision identifiers;
- the resolved instruction stack with source labels;
- relevant conversation context and attachment/artifact references;
- effective tool definitions, not connection configuration;
- pinned skill content;
- bounded memory retrieval results and broker handles;
- model policy and execution limits; and
- short-lived, audience-bound capabilities for the inference, tool, artifact,
  and memory brokers.

It does not receive database URLs, Lush signing keys, inference API keys, tool
credentials, refresh tokens, host environment variables, or arbitrary control
plane network access.

### Isolation defaults

- Read-only root filesystem and an empty ephemeral workspace.
- No host mounts. Explicit artifact inputs are copied or mounted read-only.
- Deny network egress except authenticated broker endpoints; use a network
  policy rather than application-only URL checks.
- Non-root user, syscall filtering, no privilege escalation, bounded processes,
  CPU, memory, disk, output, model steps, wall time, and spend.
- Per-environment identity and workspace. A persistent environment is bound to
  one organization, principal, and session and is never reassigned.
- Warm immutable images or paused clean sandboxes for latency. Ephemeral chat
  receives a fresh writable layer; Code may retain its session-bound layer
  across runs, but receives fresh per-run capabilities.
- Cancellation revokes run broker capabilities and stops the active run. Hard
  termination also destroys the environment.

The runtime should treat model output, tool descriptions, tool output, skills,
memories, and retrieved documents as untrusted content. None of them can alter
the capability set by instruction.

### Broker tokens

The control plane issues short-lived, audience-specific tokens with claims for
`run_id`, `organization_id`, `user_id`, `agent_revision_id`, capability digest,
allowed broker operation, expiration, and token id. The sandbox cannot provide
or override principal fields in an invocation body. Brokers derive identity
from the token and revalidate the run and live policy.

Tokens are neither upstream OAuth tokens nor MCP access tokens. Token
passthrough is forbidden.

Runs outlive tokens. A session-bound Code run can span hours while its tokens
stay short-lived, so renewal is by **re-mint, not by lengthening lifetime**. The
control plane issues a fresh token when the current one nears expiry and delivers
it through a dedicated refresh channel bound to the active run and harness
process — never to the environment generally, an environment-owned long-lived
service, or model- or harness-authored text.

Invocation-time revalidation is the primary revocation mechanism: every broker
call checks the live run, policy, membership, and revocation state, so an existing
token fails on the first call after cancellation or revocation. Re-mint repeats
those checks and refuses to issue a replacement for an inactive run. Short TTLs
and re-mint refusal are defense in depth if invocation-time enforcement ever
regresses; they are not the normal revocation window. Long-lived tokens "for
convenience" are prohibited because they weaken that backstop.

### Hosted coding profile

The managed runtime is also the missing execution target for hosted Code. It
should reuse the normalized harness adapters and Code event model already under
`services/agent`, not create a second coding-agent implementation.

Code remains a specialized execution environment, consistent with
`docs/session-orchestration.md`, rather than a parallel session or security
model. Direct and delegated Code sessions create ordinary agent runs whose
execution profile selects a coding harness adapter and session-bound
environment. The harness is an executor, not a gateway tool or a source of
ambient authority.

A Code environment adds these scoped inputs and capabilities:

- a repository provider reference and immutable starting commit;
- an isolated checkout and session-bound writable workspace;
- a pinned, license-compatible coding harness and non-interactive credential
  path;
- process supervision, shell and filesystem containment, patch extraction, and
  bounded logs;
- approved preview-port forwarding and browser automation; and
- explicit branch/commit/pull-request publication operations.

Repository checkout and publication go through a repository broker or
equivalent external control-plane operation, so the environment does not need
the organization's long-lived Git provider credential. Private dependency
credentials require a separate explicit secret policy and short-lived delivery
mechanism; they are not inherited from the API host.

The harness keeps its native file, search, edit, and shell tools inside the
sandbox. Those are constrained by the environment rather than proxied as Lush
gateway tools. `services/tools` supplies external capabilities such as issue
trackers, deployment APIs, databases, and organization integrations through MCP
or adapter bridges, always under the session-context principal.

Desktop local Code continues to use the sidecar for local repositories and
installed subscription-authenticated harnesses. Desktop managed Code and
hosted Code use the same API, environment profile, durable events, approvals,
and resume behavior. Local paths and local harness credentials are never
uploaded or implied to work in hosted mode.

The existing local adapter/runtime bugs
[#14](https://github.com/openbydesign/lush/issues/14),
[#15](https://github.com/openbydesign/lush/issues/15),
[#16](https://github.com/openbydesign/lush/issues/16),
[#17](https://github.com/openbydesign/lush/issues/17),
[#18](https://github.com/openbydesign/lush/issues/18),
[#19](https://github.com/openbydesign/lush/issues/19), and
[#21](https://github.com/openbydesign/lush/issues/21) remain narrow hardening
prerequisites. They should not absorb the managed sandbox architecture.

## Agent Executor (AX) protocol alignment

The boundary between the agent orchestrator (`services/agent`) and the agent
runtime (the sandbox/harness) is modeled on Google's open-source
[Agent Executor (AX)](https://github.com/google/ax), a distributed, harness-agnostic
agent runtime with durable, resumable execution. Lush does not adopt AX as a
dependency or its Go/gRPC transport as the canonical domain model; it adopts AX's
*contracts* so the boundary is protocol-compatible with AX and with any
AX-compatible harness. The same principle already applied to tools (MCP/OpenAPI
normalized, no external SDK as the domain model) now applies to the runtime seam.

### Why AX

AX's architecture matches this plan's requirements: a durable append-only event
log with automatic recovery, a single-writer-per-conversation consistency rule,
isolated actors provisioned from suspendable/resumable images, and a
harness-agnostic runtime contract. Aligning to it means a production provider can
be a real AX deployment behind the same `Harness` contract. The contract is the
durable decision; AX is one conforming implementation.

### Concept mapping

| Lush noun | AX concept | Notes |
| --- | --- | --- |
| Session | `conversation_id` | Durable identity that survives resumption. One actor per conversation. |
| Agent run | one `ExecutionService.Exec` turn | A run is one turn; a session has many runs. |
| Runtime harness (`Harness`) | `HarnessService.Connect` (bidi stream) | `HarnessStart{harness_config, messages}` in; `HarnessOutputs*` then one `HarnessEnd{state,error}` out. |
| Orchestrator (`services/agent`) | AX controller + `ExecutionService` | Drives the turn, enforces single-writer, appends the log, serves `Exec`. |
| `agent_run_events` (sequenced) | `ConversationEvent{step}` append-only log | Monotonic per-conversation `step`; replay reconstructs state. |
| `GET /runs/:id/events?after=<seq>` | `ExecRequest.last_step` catch-up | Replays missed events after reconnect without rewinding. |
| Message parts (text/reasoning/tool/source) | `content.proto` `Content` oneof | text, thought, tool_call, tool_result, media, confirmation. |
| Approval request | `ConfirmationContent{question}` | The request is a message content type that flows through the event stream. The *decision* does NOT ride the stream: it is submitted to an authenticated control-plane endpoint (see Authorization and approval), never accepted in-band from model/harness text. |
| Tool call / result | `ToolCallContent.id` ↔ `ToolResultContent.call_id` | Args/results are JSON structs; correlated by id. |
| Environment lifecycle | Substrate actor `Create/Resume/Suspend` | Compute-layer control plane keyed by conversation id. |
| Run status | `State{PENDING, COMPLETED, FAILED, CANCELED}` | Terminal state carried on `HarnessEnd` and completion events. |
| Cancellation | `HarnessCancel{reason}` / context cancel | `CancelReason{USER_REQUESTED, TIMEOUT, INTERNAL_ERROR}`. |

### Contracts adopted

- **Runtime seam** = `HarnessService.Connect`: send one `HarnessStart` (opaque
  `harnessConfig` + new `messages`), read `HarnessOutputs*` then exactly one
  `HarnessEnd`. A stream that ends without an `End` frame is an error. A
  subprocess harness and a remote AX harness are interchangeable.
- **Client seam** = `ExecutionService.Exec`: a server stream of
  `ExecResponse{outputs, step}` for a `conversation_id`, resumable via
  `last_step`. This is what the durable `POST /v1beta/sessions/:id/runs` and
  `GET /v1beta/runs/:id/events` endpoints project.
- **Event model** = `ConversationEvent{conversation_id, step, exec_id,
  harness_id, harness_config, messages, state}`, appended atomically with a
  monotonic per-conversation `step`. Resumption state is derived by scanning: the
  last non-unspecified `state` is the current state; a `PENDING` tail means the
  last turn did not finish and is re-run. The bound `harness_id` is sticky —
  resuming with a different harness is rejected.
- **Safe resume** = re-running a `PENDING` tail is only safe when the interrupted
  turn had no ambiguous side effect. If the interrupted turn's log contains a
  side-effecting tool call in a non-terminal state (a mutation reached `running`
  but no `succeeded`/`failed` result landed), the run is NOT silently re-driven:
  it transitions to a human-visible `needs_acknowledgment` ("outcome unknown")
  status, the tool call becomes `outcome_unknown`, and the run requires an
  explicit decision to retry or abandon. This reconciles AX's re-run rule with
  the invariant against implicit retry on ambiguous outcome; it is the
  crashed-deploy-mid-mutation case and is a Phase 4 gate item (the tool loop is
  what puts side-effecting calls in a run's log).
- **Message model** = `Message{role, Content}` where `Content` is a single-arm
  oneof. Lush's normalized message parts are this content model. Tool calls and
  results correlate by `id`/`call_id`; arguments and results are JSON objects.
- **Single-writer** = at most one in-flight execution per conversation; a second
  concurrent `Exec` fails closed. This is the same guard as "one active run per
  session".

### Boundaries kept out of AX

- **Authorization, capability resolution, and policy** remain Lush's. AX runs a
  harness; it does not decide what a principal may do. The run capability, tool
  gateway, and approval *authority* stay in the control plane. AX
  `ConfirmationContent` is the transport for an approval interaction, but the
  binding decision (input digest, expiry, principal) is Lush's per the
  [Authorization and approval](#authorization-and-approval) section.
- **Tool invocation** stays behind `services/tools`. Inside a harness, MCP and
  other tools are the harness's `ThirdPartyExecutor` seam; Lush routes that seam
  through the gateway so every call is authorized, bounded, and audited. From the
  orchestrator's view, tool activity is just `ToolCallContent`/`ToolResultContent`
  flowing through the event log.
- **A2A** is absent from AX today and is out of scope here; agent-to-agent work
  uses the parent/child session model, not a new protocol.
- **Images/environments** are opaque compute-layer concerns selected indirectly
  via `harness_id` and `harness_config`; they are not fields on the run contract.

## Agent instruction, skill, and memory composition

The runtime builds a typed context with explicit provenance in this order:

1. Lush platform safety and protocol instructions, immutable.
2. Managed agent revision instructions.
3. Organization installation instructions and policy notices.
4. User installation instructions.
5. Project instructions and selected project context.
6. Retrieved memory, labeled as data rather than authority.
7. Session history and current user input.

Later content does not override platform policy or grant capabilities. This
order should be represented structurally until the provider adapter serializes
it; do not make one concatenated prompt the internal domain model.

Skills have a manifest, immutable content digest, provenance, compatibility
requirements, and declared capability requirements. Pure instruction skills
may be injected as structured context. Executable skills run inside the agent
sandbox and are subject to the same brokers and limits as the runner.

Memory uses scoped namespaces with ACLs and explicit modes:

- session working memory;
- project memory;
- private user memory within an organization;
- organization-shared memory; and
- agent-specific memory.

Each binding declares read, propose-write, or automatic-write behavior.
Durable writes retain provenance, run id, author principal, and source. The
current project `memory` text field can become the first project-memory source,
but it should not become the generic long-term schema.

Memory is a cross-run persistence channel, so the write side is a prompt-
injection surface even though reads are treated as data-not-authority. A run that
processed hostile external content could deposit attacker-shaped content that
later runs retrieve. Provenance is therefore an enforcement input, not merely a
forensic aid.

The implementable risk reduction is a run-level, transitive
`untrustedContentIngested` marker. It is set when a run consumes open-world tool
output, attachments, user-designated imported/pasted documents, retrieved
documents, or memory whose write provenance already carries the marker. Model
transformation never clears it. An
`automatic-write` binding degrades to `propose-write` whenever the marker is set,
and the resulting proposal retains the source provenance. This is conservative,
not complete semantic taint tracking: it makes automatic writes uncommon for
attachment- and retrieval-heavy chat, and it depends on correct source
classification. Open decision 5 retains that product tradeoff rather than
presenting the rule as a complete prevention guarantee.

## Inference changes

`services/inference` needs a provider-neutral event and message contract before
an agent loop can use tools:

```ts
type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; callId: string; name: string; inputDelta: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cost?: number }
  | { type: "completed"; stopReason: string };
```

Inference accepts normalized tool definitions and conversation parts, then
adapters translate them to provider-native formats. `services/agent`, not the
provider adapter, owns the model/tool loop, maximum steps, retries, approval
pauses, and result insertion. This preserves provider portability and keeps
tool authorization out of inference.

Inference credentials remain in `services/inference`. A sandbox calls an
inference broker using its run capability; it never calls a provider with the
organization's key directly.

## Durable run and stream model

The server should become authoritative for both sides of a turn.

Recommended API shape:

```text
POST /v1beta/sessions/:sessionId/runs
GET  /v1beta/runs/:runId
GET  /v1beta/runs/:runId/events?after=<sequence>
POST /v1beta/runs/:runId/cancel
POST /v1beta/runs/:runId/approvals/:approvalId
POST /v1beta/runs/:runId/acknowledgments
```

### Ambiguous-outcome acknowledgment

Acknowledgment reuses the authorization and bound-decision machinery used for
approval, but records a different fact. Approval authorizes an action before it
starts; acknowledgment resolves what to do after a side effect may already have
happened. The request binds the run, ambiguous tool-call id, decision, acting
principal, normalized input digest, and tool-definition digest. Only a principal
authorized to control the run may decide, and a decision is accepted exactly
once.

The allowed transitions are:

- `needs_acknowledgment -> queued` for **retry**. The gateway reuses the original
  tool-call id and idempotency key end to end. Before the model loop resumes, a
  recovery task resolves that exact call: a reconciliation-capable adapter checks
  for the prior result before redispatch, then appends the terminal tool result to
  the log. If the source cannot reconcile or deduplicate, the UI states the
  duplicate-side-effect risk and the explicit retry decision authorizes
  redispatch of the original normalized call; the system still never retries
  silently or asks the model to regenerate it.
- `needs_acknowledgment -> failed` for **abandon**. The tool call remains
  `outcome_unknown`, and the terminal run error records that the external effect
  may have occurred.

The server atomically persists a `RunAcknowledgment`, the tool/run transition,
and sequenced `acknowledgment-resolved` and status events. Entering
`needs_acknowledgment` emits `acknowledgment-required`. Reconnects replay both
events like approval events; an acknowledgment never travels through model or
harness text.

The create-run request includes the new user message, optional model choice,
and an idempotency key. The server atomically persists the user message and run,
then may return the live NDJSON stream immediately. The first event includes
the run id. If the connection drops, the app reconnects to the event endpoint
using the last durable sequence. Completion persists the assistant message
server-side before emitting `response-complete`.

The existing `AgentStreamEvent` contract should be extended, not replaced:

- add `run-start`, sequenced event ids, status, approval request/resolution,
  acknowledgment required/resolved, usage, and resumability metadata;
- retain `text-delta`, `reasoning-delta`, `tool-input`, `tool-output`, source,
  artifact, completion, and error events; and
- persist normalized tool calls separately while keeping renderable tool parts
  in assistant-message metadata.

One-off title generation should become a small internal task or a run purpose,
not a public prompt endpoint that bypasses managed-agent policy indefinitely.

## Persistence plan

The durable run/environment contract is tracked in
[#62](https://github.com/openbydesign/lush/issues/62). Durable object/artifact
storage and authoritative usage accounting are tracked separately in
[#57](https://github.com/openbydesign/lush/issues/57) and
[#54](https://github.com/openbydesign/lush/issues/54).

Add append-only migrations for these logical groups:

### Tools-owned state

- `tool_connections`
- `tool_credential_bindings`
- `tool_definitions`
- `tool_definition_versions`
- `tool_connection_policies`
- `tool_oauth_states`
- `tool_calls`
- `tool_approvals`

### Agent-owned state

- `managed_agents`
- `managed_agent_revisions`
- `agent_installations`
- `agent_installation_revisions`
- `agent_environments`
- `agent_runs`
- `agent_run_installation_revisions`
- `agent_run_capabilities`
- `agent_run_events`
- `agent_run_acknowledgments`

Bindings may begin as normalized tables
(`agent_revision_tools`, `agent_revision_skills`, and
`agent_revision_memories`) rather than opaque JSON so referential integrity,
impact analysis, and revocation queries stay tractable.

`agent_environments` records the isolation provider kind and its opaque backend
handle, execution profile, owning principal/session, image digest, limits,
lease, lifecycle state, and retention deadline. Provider-specific sandbox
identifiers remain opaque. Environment rows outlive individual runs only when the
execution profile requires persistent state.

Add `agent_installation_id`, `agent_revision_id`, and `current_run_id` where
appropriate without rewriting existing migrations. Backfill `lush-chat`
sessions to the built-in `lush` installation and retain `agent_id` as a
compatibility field until all clients use managed-agent ids. Store the run's
effective configuration and capability digests so historical behavior remains
explainable even after source records change.

Large tool outputs belong in artifacts with a bounded preview in `tool_calls`.
High-volume run events need a retention policy distinct from immutable audit
events. Security-meaningful transitions also emit to the existing audit/event
boundary.

## Product behavior

### Chat

- New Chat opens with the built-in Lush agent selected.
- Sending the first message creates the session and first run as one coherent
  operation from the user's perspective.
- Tool activity renders through the existing tool message component.
- Approval cards explain the tool, connection/account, concrete action,
  arguments, scope, and whether approval is one-time or remembered.
- A connection or permission failure explains which layer denied access and
  offers the appropriate settings action without exposing secrets.
- The user can stop a run, reload, and resume the event stream without losing
  the persisted answer.

### Tool settings

- Personal settings list private connections for the active organization.
- Organization settings list shared connections, policy, health, catalog
  changes, and which managed agents reference each tool.
- The UI visually distinguishes "available to me" from "enabled for this
  agent" and previews the exact effective set.
- OAuth/account identity is shown before saving so users do not accidentally
  connect a personal account as an organization-wide service connection.

### Managed agents

- The agent editor has explicit sections for instructions, models, tools,
  skills, memory, runtime, and limits.
- Save draft and publish revision are separate. Existing runs remain pinned.
- Validation reports missing tools, incompatible skills, inaccessible memory,
  policy denials, and unsafe runtime requirements before publish.
- Sessions display the agent and pinned revision. Switching agents creates a
  new session or delegated child session rather than silently changing the
  executor for existing history.

### Hosted Code

- Hosted clients offer only managed execution targets; they never ask for a
  browser-local path or executable.
- Starting a Code session provisions a session-bound environment, resolves a
  repository ref to a commit, and starts an approved harness through the same
  orchestration API used by desktop managed mode.
- The session can continue in the background, reconnect after a browser closes,
  and resume from desktop without moving the repository or harness state onto
  the user's machine.
- Repository publication, network expansion, external tools, and other side
  effects remain explicit authorized operations.

## Observability and audit

Runtime bootstrapping/export is tracked in
[#68](https://github.com/openbydesign/lush/issues/68), boundary instrumentation
and redaction in [#71](https://github.com/openbydesign/lush/issues/71), and the
optional collector profile in
[#70](https://github.com/openbydesign/lush/issues/70).

Use common identifiers across logs, traces, metrics, run events, and audits:

```text
organization.id
user.id
session.id
agent.id
agent.revision.id
agent.run.id
agent.environment.id
tool.connection.id
tool.definition.id
tool.call.id
sandbox.id
```

Create spans for capability resolution, sandbox allocation, inference steps,
approval waits, tool queueing, connector execution, memory retrieval, and
artifact writes. Record latency, bytes, token usage, cost, retries, and policy
outcome without recording secrets or unredacted sensitive payloads by default.

Audit connection creation/change, credential replacement, catalog changes,
agent publication, capability grants, approval decisions, invocation outcome,
memory writes, run cancellation, and administrative disable/revocation.

## Security invariants

- No sandbox receives an upstream credential or control-plane signing secret.
- A persistent coding environment is never reassigned across organizations,
  principals, or sessions, and every new run receives fresh capabilities.
- No tool call executes without the original principal, active organization,
  run, agent revision, tool definition, and policy decision being known.
- Agent, skill, model, memory, and tool content cannot grant authority.
- A user-bound credential (a user-scoped connection's secret, or a
  `user_delegated` binding on an organization-owned connection) and the right to
  invoke as that user never become visible to another organization member through
  organization administration alone. Administering the connection that hosts a
  delegated binding grants neither the secret nor the ability to invoke as its
  subject.
- Revocation and membership changes are enforced at invocation time.
- Tool inputs and outputs are schema-checked and size-bounded; tool output is
  still treated as untrusted model input.
- Remote connector discovery and OAuth metadata use SSRF-safe network paths,
  redirect validation, HTTPS, and DNS/IP controls.
- MCP session ids are bound to the connection and principal and are not used as
  authentication.
- Approval is bound to exact normalized arguments and expires.
- Tool side effects use idempotency keys where supported and never retry
  implicitly when outcome is ambiguous.
- An ambiguous side-effect outcome halts the run until a bound, authorized
  acknowledgment retries the original call with the same idempotency key or
  abandons the run as failed and outcome-unknown.
- A capability-enabled run — one that may invoke a tool, run an executable
  skill, use a runtime memory broker to retrieve or write memory, or process
  tool/external output — executes inside an isolating provider and fails closed
  if isolation or policy services are unavailable. It never falls back to the
  `subprocess` provider or any non-isolating path. Server-assembled legacy
  project context is an immutable run input, not a runtime memory capability.
- The sole exemption is the execution venue for a no-capability Chat
  `AgentRun`, whose only untrusted output is model text relayed to the client —
  exactly the pre-agent risk posture, so it is not a regression. The turn still
  receives the durable run lifecycle but may execute through the non-isolating
  `subprocess` development provider until the production isolating provider
  exists (Phase 3). The exemption never applies once the built-in agent enables
  tools (Phase 4), after which every Chat run is capability-enabled. Raw
  programmatic inference calls outside Chat create no `AgentRun` and are outside
  this invariant.

## Related open issues

[#72](https://github.com/openbydesign/lush/issues/72) is the cross-cutting
production roadmap. The current issue map is:

| Plan area | Open issues |
| --- | --- |
| Durable run, environment, event, and capability persistence | [#62](https://github.com/openbydesign/lush/issues/62) |
| Provider-neutral sandbox/environment lifecycle | [#66](https://github.com/openbydesign/lush/issues/66) |
| Sandbox isolation, broker capabilities, and hosted Code security | [#69](https://github.com/openbydesign/lush/issues/69) |
| Temporal durable/background orchestration | [#63](https://github.com/openbydesign/lush/issues/63), [#64](https://github.com/openbydesign/lush/issues/64), [#65](https://github.com/openbydesign/lush/issues/65), [#67](https://github.com/openbydesign/lush/issues/67) |
| Artifact storage and usage events | [#57](https://github.com/openbydesign/lush/issues/57), [#54](https://github.com/openbydesign/lush/issues/54) |
| Streaming/ingress and forward-only migrations | [#51](https://github.com/openbydesign/lush/issues/51), [#52](https://github.com/openbydesign/lush/issues/52) |
| OpenTelemetry | [#68](https://github.com/openbydesign/lush/issues/68), [#71](https://github.com/openbydesign/lush/issues/71), [#70](https://github.com/openbydesign/lush/issues/70) |
| Tool control plane and direct invocation | [#107](https://github.com/openbydesign/lush/issues/107), [#103](https://github.com/openbydesign/lush/issues/103) |
| Existing local Code correctness/security prerequisites | [#14](https://github.com/openbydesign/lush/issues/14), [#15](https://github.com/openbydesign/lush/issues/15), [#16](https://github.com/openbydesign/lush/issues/16), [#17](https://github.com/openbydesign/lush/issues/17), [#18](https://github.com/openbydesign/lush/issues/18), [#19](https://github.com/openbydesign/lush/issues/19), [#21](https://github.com/openbydesign/lush/issues/21) |

No dedicated issue yet covers the managed-agent definition and installation
model, provider-neutral inference tool loop,
managed-agent editor, or skill/memory phases. Those gaps are explicitly listed
in #72 and should be split into focused implementation issues before their
respective phases begin.

## Implementation sequence

Each phase should ship behind organization flags until its security and
recovery gates pass.

### Phase 0: contracts and migration spine

Primary tracking: [#62](https://github.com/openbydesign/lush/issues/62), with
forward-only migration enforcement in
[#52](https://github.com/openbydesign/lush/issues/52).

1. Add Lush-owned contracts for principals, managed agents, environments, runs,
   tool definitions, capability resolution, calls, results, approvals, and
   events.
2. Add initial append-only schema for managed agents, installations, revisions,
   environments, runs, connections, definitions, and calls.
3. Seed the system `lush` agent and organization installation; backfill current
   `lush-chat` sessions through a compatibility mapping.
4. Add authz actions for organization/user connection management, managed agent
   management, run creation/cancellation, approval decisions, and
   ambiguous-outcome acknowledgments.

Gate: existing chat and session tests pass unchanged, and cross-organization,
cross-user, and role tests prove all new rows are scoped.

### Phase 1: durable Lush runs with no tools

Primary tracking: [#62](https://github.com/openbydesign/lush/issues/62), with
streaming/ingress behavior in
[#51](https://github.com/openbydesign/lush/issues/51).

1. Introduce the AX-aligned `Harness` runtime seam and `AgentRun` orchestrator
   (`services/agent/src/harness/`), driving the built-in Lush chat (no tools,
   executable skills, or brokered memory) through the `subprocess` provider.
   Phase 1 retains today's server-assembled project context but exposes no memory
   broker handle and cannot retrieve or write memory at runtime, so it ships under
   the no-capability exemption (see Security invariants); the production
   isolating provider arrives in Phase 3. The orchestrator is the AX controller:
   it owns the `ConversationEvent` log, single-writer guard, and `Exec` stream.
2. Replace the client-owned append/invoke/append sequence with server-owned run
   creation, assistant persistence, idempotency, cancellation, and resumable
   events.
3. Resolve the built-in Lush revision, existing project instructions, legacy
   project memory/context, and model policy into the immutable run bundle through
   the new typed configuration pipeline; this is context assembly, not runtime
   memory retrieval or writing.
4. Move title generation behind an internal run/task purpose.

Gate: functional parity for ordinary chat, no duplicate turns under retry,
assistant responses survive client disconnects, cancellation is durable, and
first-token latency is measured against the current path.

### Phase 2: tool control plane and direct test invocation

Primary tracking: [#107](https://github.com/openbydesign/lush/issues/107), with
credential key separation and rotation in
[#103](https://github.com/openbydesign/lush/issues/103).

1. Implement organization and user connections, encrypted credential refs,
   normalized definitions, health, catalog versions, persistent catalog-change
   review until a manager acknowledges the exact version, and policy explanations.
2. Materialize code-owned native tools automatically as individually governed,
   top-level organization tools that are disabled by default; native is not a
   user-creatable connection source. Implement one native read-only tool and one remote MCP
   Streamable HTTP connection. Add OpenAPI import after the normalized contract
   is exercised by both native and MCP sources.
3. Implement gateway invocation, input/output bounds, live authorization,
   approval records, idempotency, audit, and telemetry.
4. Expose settings APIs and split the minimal UI into organization **Tool
   gateway** governance and personal **My tools** access/preferences.

Gate: users cannot see or invoke each other's private connections; organization
role/policy tests pass; SSRF, redirect, secret-redaction, timeout, catalog-change,
and revocation tests pass; direct test invocations use the production gateway.

### Phase 3: sandbox execution

Primary tracking: [#66](https://github.com/openbydesign/lush/issues/66) and
[#69](https://github.com/openbydesign/lush/issues/69).

1. Add a production isolating provider (Cloudflare/Vercel sandbox, Substrate, or
   gVisor/Kata/microVM) behind the existing `IsolationProvider` interface (the
   `subprocess` development provider already exists), including ephemeral and
   session-bound environment lifecycles and warm/paused capacity. `subprocess` is
   never valid for production capability-enabled runs.
2. Add capability-token issuance and inference/tool/artifact/memory broker
   authentication.
3. Run the built-in Lush chat on the production isolating provider, using warm
   clean capacity to protect first-token latency.
4. Reuse the existing Code harness adapters in a `code` environment profile;
   add repository checkout, persistent workspace, process supervision, bounded
   patch/artifact extraction, and one approved non-interactive harness path.
5. Expose the same managed Code orchestration API to hosted and desktop clients.
6. Add cancellation, lease expiry, orphan reaping, resource enforcement,
   network policy, and sandbox telemetry.

Gate: a hostile runner cannot read host files, environment secrets, cloud
metadata, another run's state, or arbitrary network destinations; an existing
token fails on its first broker call after cancellation or revocation; production
does not fall back to the `subprocess` provider; and a Code session can start in
the hosted app, complete in a managed sandbox, and resume from desktop. Harness
credential, licensing, and unit-economics approval remains a release gate for
each hosted harness.

### Phase 4: provider-neutral tool loop

1. Extend inference adapters with structured messages, tool definitions, tool
   calls, usage, and stop reasons.
2. Add the bounded model/tool loop to `services/agent` and route every call
   through the gateway.
3. Stream/persist tool input, approval, output, source, and artifact events
   through the existing message-part protocol.
4. Enable a small, explicit tool set for the built-in Lush agent.

Gate: the sandbox cannot call an ungranted tool or mutate arguments after
approval; provider contract tests cover at least OpenAI and Anthropic shapes;
disconnect/reconnect, cancellation, maximum-step limits, and both authorized
ambiguous-outcome transitions are tested end to end, including same-key retry,
reconciliation, duplicate-risk disclosure, and replay of acknowledgment events.

### Phase 5: managed agent configuration

1. Build organization and user managed-agent CRUD, drafts, publication,
   immutable revisions, installation overlays, validation, and preview of
   effective capabilities.
2. Add tools, model policy, instructions, runtime profile, and limits to the
   agent editor.
3. Generalize session creation and navigation from hard-coded `lush`/
   `lush-chat` routing to managed agent installations.
4. Make Lush's organization policy and user overlay editable through the same
   APIs while retaining its immutable system base.

Gate: revision pinning and rollback work, changing configuration does not alter
an existing run, and an agent can only select capabilities available to the
editing and eventual calling principals.

### Phase 6: skills and memory

1. Implement immutable skill packages, manifests, provenance, compatibility
   checks, and catalog resolution in the existing skills boundaries.
2. Load instruction skills as typed context and executable skills only into the
   sandbox.
3. Introduce ACL-scoped memory namespaces, bounded retrieval, proposals,
   writes, provenance, and retention.
4. Migrate project memory/context into adapters over the new interfaces while
   preserving current behavior.

Gate: a skill cannot self-grant a tool; memory retrieval and writes obey user,
organization, project, and agent ACLs; untrusted content cannot alter runtime
policy; all writes are attributable and reversible according to retention
policy; and **cross-run injection via memory is a tested threat**. Open-world
tool output, attachments, identified document imports/pastes, retrieved
documents, and transitively marked memory set `untrustedContentIngested`; the
marker survives model transformation, and automatic writes from such a run
degrade to reviewable proposals.

### Phase 7: delegation and background managed agents

Primary tracking: [#63](https://github.com/openbydesign/lush/issues/63),
[#64](https://github.com/openbydesign/lush/issues/64),
[#65](https://github.com/openbydesign/lush/issues/65), and qualification in
[#67](https://github.com/openbydesign/lush/issues/67).

1. Connect managed agent runs to the parent/child session model in
   `docs/session-orchestration.md`.
2. Let Chat create a hosted Code child session when repository-backed execution
   is required, reusing the managed Code environment from Phase 3.
3. Add scheduling, wakeups, durable waiting, notifications, and organization
   budgets without changing the capability model.
4. Add user-visible delegation cards and bounded result propagation back to
   the parent session.

Gate: delegated work cannot broaden authority, continues safely across process
restarts, and stops on revocation, budget exhaustion, cancellation, or policy
change.

## First vertical slice

The first externally useful slice should be deliberately narrow:

- system-managed Lush agent resolved from the database;
- one user-scoped and one organization-scoped connection path;
- one native read-only tool plus one remote MCP tool;
- a durable Lush run in the sandbox;
- one hosted Code session using a session-bound environment and an existing
  normalized harness adapter;
- an explicit two-tool capability set;
- one approval-required mutation test tool kept disabled outside development;
- server-persisted user, assistant, tool, run, and approval state;
- live and resumable rendering in the existing Chat UI; and
- end-to-end tests for principal propagation, scoping, subset enforcement,
  approval binding, revocation, cancellation, redaction, and sandbox escape
  boundaries.

This slice proves the complete trust chain before broad catalogs, arbitrary
agents, executable skills, or autonomous background behavior are enabled.

## Open product decisions

These decisions do not block the domain boundaries above, but should be made
before the relevant phase:

1. Whether organization administrators can prohibit all user-private tool
   connections or only specific source/risk classes.
2. Whether organization-shared connections initially support only service
   credentials or also per-user OAuth bindings under one shared connection.
3. Which approval choices other than the explicit connection-level `never`
   override may be remembered and for how long.
4. Whether users may create private agents by default or organizations must
   enable the feature.
5. Which memory writes are automatic for the built-in Lush agent versus shown
   as proposals. Risk-reduction default: propose whenever the run ingested
   marked untrusted external content; automatic writes are therefore uncommon
   for attachment- and retrieval-heavy chat. Product UX must make that tradeoff
   legible rather than implying complete semantic taint prevention.
6. The production isolation provider and latency SLO; the `IsolationProvider`
   interface allows this decision to be benchmark-driven.
7. The per-turn TTFT budget and warm-pool sizing, plus the empty-pool
   degradation policy (queue / cold-provision / fail-with-retry-after). The
   shape — parallel control-plane preparation, then in-sandbox inference, with
   warm-attach within budget — is fixed (see Default chat once tools are
   enabled); the numbers are benchmark-driven.
8. The retention split between transcripts, run event logs, tool payloads,
   artifacts, audit events, and derived memories. Phase 1 snapshots the full
   effective transcript and project context into each run configuration for
   replay and explainability. That makes session storage grow quadratically and
   means supersession or truncation is not erasure from historical runs. Treat
   this as a temporary retention choice: before Phase 3, replace full snapshots
   with immutable message/context references plus digests, or define bounded
   run-configuration retention and explicit erasure semantics.

## Protocol references

- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP protocol versioning](https://modelcontextprotocol.io/docs/learn/versioning)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [MCP client best practices](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)
