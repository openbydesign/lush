import { getDb } from "@lush/db/client";
import {
  builtinLushAgentId,
  builtinLushRevisionDigest,
  builtinLushRevisionId
} from "@lush/db/schema";
import type {
  AgentRunRow,
  AgentRunStatus,
  Database,
  SessionMessageRow,
  ToolAnnotations,
  ToolSource
} from "@lush/db/schema";
import { getInferenceConfig } from "@lush/inference/runtime";
import { messageByteSize } from "@lush/sessions/runtime";
import { canonicalJson, sha256Hex } from "@lush/tools/digest";
import { decideApproval } from "@lush/tools/gateway";
import type { Kysely, Transaction } from "kysely";
import { lushAgent } from "./agents/lush";
import { normalizeAgentChatMessages } from "./chat-request";
import { configuredIsolationRuntime } from "./harness/provider";
import { allocateModelToolName } from "./model-tool-name";
import {
  attachmentsFromMetadata,
  projectContextForPrompt,
  type SessionPrincipal
} from "./session-context";
import type { AgentChatMessage, ProjectAgentContext } from "./runtime";

export type AgentRunPrincipal = SessionPrincipal;
export type AgentRunPurpose = "chat" | "title";

export type CreateAgentRunRequest = {
  idempotencyKey: string;
  originMessageId?: string;
  modelSelection?: string;
  message: AgentChatMessage;
  metadata?: unknown;
};

export type AgentRunConfigurationV1 = {
  version: 1;
  agent: {
    id: string;
    revisionId: string;
    revisionDigest: string;
    instructions: string;
  };
  installationRevisionIds: string[];
  modelSelection: string;
  messages: AgentChatMessage[];
  project?: ProjectAgentContext;
};

export type AgentRunToolCapability = {
  definitionId: string;
  connectionId: string;
  connectionLabel: string;
  connectionSource: ToolSource;
  connectionIconUrl?: string;
  /** Provider-safe name exposed to the model. */
  name: string;
  /** Original connector name used for gateway invocation. */
  externalName: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  definitionDigest: string;
  timeoutMs: number | null;
  annotations: ToolAnnotations;
};

export type AgentRunCapabilitiesV1 = {
  version: 1;
  principal: { organizationId: string; userId: string };
  inference: { modelSelection: string };
  tools: AgentRunToolCapability[];
  executableSkills: unknown[];
  runtimeMemory: unknown[];
};

export type AgentRun = {
  id: string;
  organizationId: string;
  sessionId: string;
  originMessageId: string;
  assistantMessageId: string | null;
  initiatedByUserId: string;
  agentRevisionId: string;
  environmentId: string;
  status: AgentRunStatus;
  purpose: AgentRunPurpose;
  idempotencyKey: string;
  capabilityDigest: string;
  configurationDigest: string;
  isolationProvider: string;
  untrustedContentIngested: boolean;
  modelSelection: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
};

export type AgentRunEvent = {
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};

export class AgentRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

const terminalStatuses = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled"
]);
const runLimits = { wallClockMs: 120_000, maxOutputBytes: 8_000_000 } as const;

export async function createAgentRun(
  principal: AgentRunPrincipal,
  sessionId: string,
  request: unknown
): Promise<{ run: AgentRun; created: boolean }> {
  const body = normalizeCreateRunRequest(request);
  const startDigest = await sha256Hex(
    canonicalJson({
      version: 1,
      sessionId,
      originMessageId: body.originMessageId,
      modelSelection: body.modelSelection,
      message: body.message,
      metadata: body.metadata
    })
  );
  const db = getDb();
  const prior = await db.selectFrom("agentRuns")
    .innerJoin("sessionThreads", "sessionThreads.id", "agentRuns.sessionId")
    .selectAll("agentRuns")
    .where("agentRuns.organizationId", "=", principal.organizationId)
    .where("agentRuns.initiatedByUserId", "=", principal.userId)
    .where("agentRuns.sessionId", "=", sessionId)
    .where("agentRuns.idempotencyKey", "=", body.idempotencyKey)
    .where("sessionThreads.ownerUserId", "=", principal.userId)
    .executeTakeFirst();
  if (prior) {
    if (prior.startDigest !== startDigest) {
      throw new AgentRunError(
        "idempotency_mismatch",
        "The idempotency key is already bound to a different turn",
        409
      );
    }
    return { run: toRun(prior), created: false };
  }
  const selectedModel = await resolveModelSelection(
    principal.organizationId,
    body.modelSelection
  );

  return db.transaction().execute(async (trx) => {
    const thread = await trx
      .selectFrom("sessionThreads")
      .selectAll()
      .where("id", "=", sessionId)
      .where("organizationId", "=", principal.organizationId)
      .where("ownerUserId", "=", principal.userId)
      .where("deleted", "=", false)
      .forUpdate()
      .executeTakeFirst();
    if (!thread) {
      throw new AgentRunError("session_not_found", "Session was not found", 404);
    }
    if (thread.archivedAt) {
      throw new AgentRunError("session_archived", "Session is archived", 409);
    }
    if (thread.agentId !== lushAgent.sessionAgentId) {
      throw new AgentRunError("agent_session_mismatch", "Session is not owned by this agent", 404);
    }

    const racedPrior = await trx
      .selectFrom("agentRuns")
      .selectAll()
      .where("organizationId", "=", principal.organizationId)
      .where("initiatedByUserId", "=", principal.userId)
      .where("sessionId", "=", sessionId)
      .where("idempotencyKey", "=", body.idempotencyKey)
      .executeTakeFirst();
    if (racedPrior) {
      if (racedPrior.startDigest !== startDigest) {
        throw new AgentRunError(
          "idempotency_mismatch",
          "The idempotency key is already bound to a different turn",
          409
        );
      }
      return { run: toRun(racedPrior), created: false };
    }

    const active = await trx
      .selectFrom("agentRuns")
      .select("id")
      .where("sessionId", "=", sessionId)
      .where("status", "in", [
        "queued",
        "running",
        "waiting_for_approval",
        "needs_acknowledgment"
      ])
      .executeTakeFirst();
    if (active) {
      throw new AgentRunError(
        "run_in_progress",
        "The session already has an active run",
        409
      );
    }

    const installation = await ensureBuiltinInstallation(
      trx,
      principal.organizationId
    );
    const agentRevision = await trx.selectFrom("managedAgentRevisions")
      .select(["id", "instructions", "digest"])
      .where("id", "=", builtinLushRevisionId)
      .where("agentId", "=", builtinLushAgentId)
      .executeTakeFirstOrThrow();
    const context = await loadRunContext(trx, principal, thread);
    const reusedOrigin = body.originMessageId
      ? await trx.selectFrom("sessionMessages").selectAll()
        .where("id", "=", body.originMessageId)
        .where("threadId", "=", thread.id)
        .where("organizationId", "=", principal.organizationId)
        .where("authorUserId", "=", principal.userId)
        .where("role", "=", "user")
        .where("supersededAt", "is", null)
        .executeTakeFirst()
      : undefined;
    const lastActiveMessage = body.originMessageId
      ? await trx.selectFrom("sessionMessages").select("id")
        .where("threadId", "=", thread.id)
        .where("organizationId", "=", principal.organizationId)
        .where("supersededAt", "is", null)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc")
        .executeTakeFirst()
      : undefined;
    if (body.originMessageId && (
      !reusedOrigin ||
      lastActiveMessage?.id !== reusedOrigin.id ||
      reusedOrigin.content !== body.message.content ||
      canonicalJson(reusedOrigin.metadata ?? {}) !== canonicalJson(body.metadata)
    )) {
      throw new AgentRunError(
        "invalid_origin_message",
        "The origin message cannot be reused for this turn",
        409
      );
    }
    const messages = reusedOrigin ? context.messages : [...context.messages, body.message];
    const configuration: AgentRunConfigurationV1 = {
      version: 1,
      agent: {
        id: builtinLushAgentId,
        revisionId: agentRevision.id,
        revisionDigest: agentRevision.digest,
        instructions: agentRevision.instructions
      },
      installationRevisionIds: [installation.revisionId],
      modelSelection: selectedModel,
      messages,
      ...(context.project ? { project: context.project } : {})
    };
    const configurationDigest = await sha256Hex(canonicalJson(configuration));
    const tools = await resolveRunTools(trx, principal, thread.id);
    const capabilities: AgentRunCapabilitiesV1 = {
      version: 1,
      principal: {
        organizationId: principal.organizationId,
        userId: principal.userId
      },
      inference: { modelSelection: selectedModel },
      tools,
      executableSkills: [],
      runtimeMemory: []
    };
    const capabilityDigest = await sha256Hex(canonicalJson(capabilities));
    const isolation = configuredIsolationRuntime();
    const now = new Date();
    const byteSize = reusedOrigin
      ? 0
      : messageByteSize(body.message.content, body.metadata);
    const origin = reusedOrigin ?? await trx
      .insertInto("sessionMessages")
      .values({
        threadId: thread.id,
        organizationId: principal.organizationId,
        authorUserId: principal.userId,
        role: "user",
        content: body.message.content,
        metadata: body.metadata,
        tokenCount: null,
        byteSize,
        createdAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const environment = await trx
      .insertInto("agentEnvironments")
      .values({
        organizationId: principal.organizationId,
        ownerUserId: principal.userId,
        sessionId: thread.id,
        profile: "chat",
        status: "provisioning",
        isolationProvider: isolation.kind,
        backendHandle: null,
        imageDigest: isolation.kind === "subprocess"
          ? `builtin:lush@${builtinLushRevisionDigest}`
          : isolation.imageDigest,
        limits: runLimits,
        leaseExpiresAt: null,
        // Phase 1 subprocesses retain no backend state after destruction, so
        // their environment records are immediately eligible for reclamation.
        retentionUntil: now,
        createdAt: now,
        updatedAt: now,
        destroyedAt: null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const run = await trx
      .insertInto("agentRuns")
      .values({
        organizationId: principal.organizationId,
        sessionId: thread.id,
        originMessageId: origin.id,
        assistantMessageId: null,
        initiatedByUserId: principal.userId,
        agentRevisionId: builtinLushRevisionId,
        environmentId: environment.id,
        status: "queued",
        purpose: "chat",
        idempotencyKey: body.idempotencyKey,
        startDigest,
        capabilityDigest,
        configurationDigest,
        configuration,
        isolationProvider: isolation.kind,
        untrustedContentIngested: hasUntrustedContent(body.message, context.project),
        limits: runLimits,
        modelSelection: selectedModel,
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
        cancelledAt: null
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx.insertInto("agentRunInstallationRevisions").values({
      runId: run.id,
      installationRevisionId: installation.revisionId,
      organizationId: principal.organizationId
    }).execute();
    await trx.insertInto("agentRunCapabilities").values({
      runId: run.id,
      organizationId: principal.organizationId,
      principalUserId: principal.userId,
      snapshot: capabilities,
      digest: capabilityDigest,
      revokedAt: null,
      createdAt: now
    }).execute();
    await trx.insertInto("agentRunEvents").values({
      runId: run.id,
      organizationId: principal.organizationId,
      sequence: 1,
      type: "run-start",
      payload: {
        status: "queued",
        originMessageId: origin.id,
        configurationDigest,
        capabilityDigest
      },
      createdAt: now
    }).execute();
    await trx.updateTable("sessionThreads").set({
      agentInstallationId: installation.installationId,
      agentRevisionId: builtinLushRevisionId,
      currentRunId: run.id,
      stateBytes: thread.stateBytes + byteSize,
      version: thread.version + 1,
      updatedAt: now
    }).where("id", "=", thread.id).execute();
    await recordRunAudit(trx, principal, run.id, "agent.run_created", {
      sessionId: thread.id,
      originMessageId: origin.id,
      idempotencyKey: body.idempotencyKey
    });

    return { run: toRun(run), created: true };
  });
}

async function resolveRunTools(
  trx: Transaction<Database>,
  principal: AgentRunPrincipal,
  sessionId: string
): Promise<AgentRunToolCapability[]> {
  const organization = await trx.selectFrom("organizations")
    .select("toolGatewayEnabled")
    .where("id", "=", principal.organizationId)
    .executeTakeFirst();
  if (organization?.toolGatewayEnabled !== true) return [];

  const snapshot = await trx.selectFrom("sessionStateSnapshots")
    .select("state")
    .where("threadId", "=", sessionId)
    .where("organizationId", "=", principal.organizationId)
    .where("kind", "=", "chat_tool_selection")
    .orderBy("createdAt", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  const disabled = disabledToolIds(snapshot?.state);
  const connections = await trx.selectFrom("toolConnections")
    .select(["id", "label", "source", "endpointConfig", "policy"])
    .where("organizationId", "=", principal.organizationId)
    .where("enabled", "=", true)
    .where((eb) => eb.or([
      eb("ownerUserId", "is", null),
      eb("ownerUserId", "=", principal.userId)
    ]))
    .execute();
  if (connections.length === 0) return [];
  const policyByConnection = new Map(
    connections.map((connection) => [connection.id, connection.policy])
  );
  const presentationByConnection = new Map(
    connections.map((connection) => [connection.id, {
      label: connection.label,
      source: connection.source,
      iconUrl: connectionIconUrl(connection.endpointConfig)
    }])
  );
  const definitions = await trx.selectFrom("toolDefinitions")
    .select([
      "id",
      "connectionId",
      "externalName",
      "qualifiedName",
      "title",
      "description",
      "inputSchema",
      "definitionDigest",
      "timeoutMs",
      "annotations"
    ])
    .where("connectionId", "in", connections.map((connection) => connection.id))
    .where("enabled", "=", true)
    .orderBy("qualifiedName", "asc")
    .orderBy("id", "asc")
    .execute();

  const usedNames = new Set<string>();
  const tools: AgentRunToolCapability[] = [];
  for (const definition of definitions) {
    if (disabled.has(definition.id)) continue;
    const annotations = definition.annotations as ToolAnnotations;
    if (decideApproval(annotations, policyByConnection.get(definition.connectionId)) === "deny") {
      continue;
    }
    tools.push({
      definitionId: definition.id,
      connectionId: definition.connectionId,
      connectionLabel:
        presentationByConnection.get(definition.connectionId)?.label ?? "Tool",
      connectionSource:
        presentationByConnection.get(definition.connectionId)?.source ?? "native",
      ...(presentationByConnection.get(definition.connectionId)?.iconUrl
        ? { connectionIconUrl: presentationByConnection.get(definition.connectionId)!.iconUrl }
        : {}),
      name: allocateModelToolName(definition.qualifiedName, usedNames),
      externalName: definition.externalName,
      title: definition.title,
      description: definition.description,
      inputSchema: isRecord(definition.inputSchema) ? definition.inputSchema : {},
      definitionDigest: definition.definitionDigest,
      timeoutMs: definition.timeoutMs,
      annotations
    });
  }
  return tools;
}

function connectionIconUrl(endpointConfig: unknown): string | undefined {
  if (!isRecord(endpointConfig) || typeof endpointConfig.url !== "string") {
    return undefined;
  }
  try {
    const endpoint = new URL(endpointConfig.url);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      return undefined;
    }
    return new URL("/favicon.ico", endpoint.origin).toString();
  } catch {
    return undefined;
  }
}

function disabledToolIds(value: unknown) {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.disabledToolDefinitionIds)) {
    return new Set<string>();
  }
  return new Set(value.disabledToolDefinitionIds.filter(
    (id): id is string => typeof id === "string"
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function fetchAgentRun(
  principal: AgentRunPrincipal,
  runId: string
): Promise<AgentRun> {
  return toRun(await requireOwnedRun(getDb(), principal, runId));
}

export async function listAgentRunEvents(
  principal: AgentRunPrincipal,
  runId: string,
  after = 0
): Promise<AgentRunEvent[]> {
  await requireOwnedRun(getDb(), principal, runId);
  const rows = await getDb()
    .selectFrom("agentRunEvents")
    .selectAll()
    .where("runId", "=", runId)
    .where("organizationId", "=", principal.organizationId)
    .where("sequence", ">", Math.max(0, after))
    .where("type", "not in", ["conversation", "internal-task"])
    .orderBy("sequence", "asc")
    .execute();
  return rows.map((row) => ({
    runId: row.runId,
    sequence: row.sequence,
    type: row.type,
    payload: row.payload,
    createdAt: toIso(row.createdAt)
  }));
}

export async function cancelAgentRun(
  principal: AgentRunPrincipal,
  runId: string
): Promise<AgentRun> {
  const db = getDb();
  const result = await db.transaction().execute(async (trx) => {
    const run = await requireOwnedRun(trx, principal, runId, true);
    if (terminalStatuses.has(run.status)) return toRun(run);
    const now = new Date();
    const partialRows = await trx.selectFrom("agentRunEvents")
      .select("payload")
      .where("runId", "=", run.id)
      .where("type", "=", "text-delta")
      .orderBy("sequence", "asc")
      .execute();
    const partialText = partialRows.map((row) => {
      const payload = row.payload as { delta?: unknown };
      return typeof payload?.delta === "string" ? payload.delta : "";
    }).join("");
    let assistantMessageId: string | null = null;
    if (partialText) {
      const metadata = {
        schema: "lush.message.parts.v1",
        runId: run.id,
        partial: true,
        parts: [{ type: "text", length: partialText.length }]
      };
      const byteSize = messageByteSize(partialText, metadata);
      const message = await trx.insertInto("sessionMessages").values({
        threadId: run.sessionId,
        organizationId: run.organizationId,
        authorUserId: null,
        role: "assistant",
        content: partialText,
        metadata,
        tokenCount: null,
        byteSize,
        createdAt: now
      }).returning("id").executeTakeFirstOrThrow();
      assistantMessageId = message.id;
      await trx.updateTable("sessionThreads").set((eb) => ({
        stateBytes: eb("stateBytes", "+", byteSize),
        version: eb("version", "+", 1),
        updatedAt: now
      })).where("id", "=", run.sessionId).execute();
    }
    const updated = await trx.updateTable("agentRuns").set({
      status: "cancelled",
      assistantMessageId,
      errorCode: "user_cancelled",
      errorMessage: "Run cancelled by user",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: now,
      cancelledAt: now
    }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
    await trx.updateTable("toolApprovals").set({
      status: "expired",
      decidedAt: now
    }).where("runId", "=", run.id)
      .where("status", "=", "pending")
      .execute();
    await trx.updateTable("toolCalls").set({
      status: "cancelled",
      completedAt: now
    }).where("runId", "=", run.id)
      .where("status", "=", "waiting_for_approval")
      .execute();
    await trx.updateTable("agentRunCapabilities").set({ revokedAt: now })
      .where("runId", "=", run.id).execute();
    await trx.updateTable("agentEnvironments").set({
      status: "destroyed",
      updatedAt: now,
      destroyedAt: now,
      leaseExpiresAt: null
    }).where("id", "=", run.environmentId).execute();
    await trx.updateTable("sessionThreads").set({ currentRunId: null })
      .where("id", "=", run.sessionId)
      .where("currentRunId", "=", run.id).execute();
    await appendRunEvent(trx, updated, "run-status", { status: "cancelled" }, now);
    if (assistantMessageId) {
      await appendRunEvent(trx, updated, "response-complete", {
        assistantMessageId,
        partial: true
      }, now);
    }
    await recordRunAudit(trx, principal, run.id, "agent.run_cancelled", {});
    return toRun(updated);
  });
  abortLocalRun(runId);
  return result;
}

const localRunControllers = new Map<string, AbortController>();

export function registerLocalRun(runId: string, controller: AbortController): () => void {
  const prior = localRunControllers.get(runId);
  prior?.abort();
  localRunControllers.set(runId, controller);
  return () => {
    if (localRunControllers.get(runId) === controller) {
      localRunControllers.delete(runId);
    }
  };
}

function abortLocalRun(runId: string) {
  localRunControllers.get(runId)?.abort();
}

export async function appendRunEvent(
  trx: Transaction<Database>,
  run: Pick<AgentRunRow, "id" | "organizationId">,
  type: string,
  payload: unknown,
  createdAt = new Date(),
  expectedLeaseOwner?: string,
  expectedSequence?: number
) {
  const locked = await trx.selectFrom("agentRuns")
    .select(["id", "status", "leaseOwner"])
    .where("id", "=", run.id)
    .forUpdate().executeTakeFirstOrThrow();
  if (
    expectedLeaseOwner &&
    (
      (locked.status !== "running" && locked.status !== "waiting_for_approval") ||
      locked.leaseOwner !== expectedLeaseOwner
    )
  ) {
    throw new AgentRunError("run_lease_lost", "Run execution lease was lost", 409);
  }
  const sequence = expectedSequence ?? Number((await trx
    .selectFrom("agentRunEvents")
    .select((eb) => eb.fn.max<number>("sequence").as("sequence"))
    .where("runId", "=", run.id)
    .executeTakeFirst())?.sequence ?? 0) + 1;
  await trx.insertInto("agentRunEvents").values({
    runId: run.id,
    organizationId: run.organizationId,
    sequence,
    type,
    payload,
    createdAt
  }).execute();
  return sequence;
}

export function parseRunConfiguration(value: unknown): AgentRunConfigurationV1 {
  if (!value || typeof value !== "object") {
    throw new AgentRunError("invalid_run_configuration", "Run configuration is invalid", 500);
  }
  const candidate = value as Partial<AgentRunConfigurationV1>;
  if (
    candidate.version !== 1 ||
    !candidate.agent ||
    !Array.isArray(candidate.installationRevisionIds) ||
    !Array.isArray(candidate.messages) ||
    typeof candidate.modelSelection !== "string"
  ) {
    throw new AgentRunError("invalid_run_configuration", "Run configuration is invalid", 500);
  }
  return candidate as AgentRunConfigurationV1;
}

async function ensureBuiltinInstallation(
  trx: Transaction<Database>,
  organizationId: string
) {
  let installation = await trx.selectFrom("agentInstallations")
    .select("id")
    .where("organizationId", "=", organizationId)
    .where("agentId", "=", builtinLushAgentId)
    .where("ownerUserId", "is", null)
    .executeTakeFirst();
  if (!installation) {
    await trx.insertInto("agentInstallations").values({
      organizationId,
      agentId: builtinLushAgentId,
      ownerUserId: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date()
    }).onConflict((oc) => oc.doNothing()).execute();
    installation = await trx.selectFrom("agentInstallations")
      .select("id")
      .where("organizationId", "=", organizationId)
      .where("agentId", "=", builtinLushAgentId)
      .where("ownerUserId", "is", null)
      .executeTakeFirstOrThrow();
  }
  let revision = await trx.selectFrom("agentInstallationRevisions")
    .select("id")
    .where("installationId", "=", installation.id)
    .where("agentRevisionId", "=", builtinLushRevisionId)
    .executeTakeFirst();
  if (!revision) {
    await trx.insertInto("agentInstallationRevisions").values({
      installationId: installation.id,
      agentRevisionId: builtinLushRevisionId,
      parentInstallationRevisionId: null,
      additionalInstructions: "",
      capabilityPolicy: {},
      modelOverride: null,
      digest: builtinLushRevisionDigest,
      createdAt: new Date()
    }).onConflict((oc) => oc.doNothing()).execute();
    revision = await trx.selectFrom("agentInstallationRevisions")
      .select("id")
      .where("installationId", "=", installation.id)
      .where("agentRevisionId", "=", builtinLushRevisionId)
      .executeTakeFirstOrThrow();
  }
  return { installationId: installation.id, revisionId: revision.id };
}

async function requireOwnedRun(
  db: Kysely<Database> | Transaction<Database>,
  principal: AgentRunPrincipal,
  runId: string,
  forUpdate = false
): Promise<AgentRunRow> {
  let query = db.selectFrom("agentRuns").innerJoin(
    "sessionThreads",
    "sessionThreads.id",
    "agentRuns.sessionId"
  ).selectAll("agentRuns")
    .where("agentRuns.id", "=", runId)
    .where("agentRuns.organizationId", "=", principal.organizationId)
    .where("sessionThreads.ownerUserId", "=", principal.userId);
  if (forUpdate) query = query.forUpdate();
  const run = await query.executeTakeFirst();
  if (!run) throw new AgentRunError("run_not_found", "Run was not found", 404);
  return run;
}

async function resolveModelSelection(organizationId: string, requested?: string) {
  if (requested?.trim()) return requested.trim();
  const config = await getInferenceConfig(organizationId);
  const selected = config.modelDefaults.chat;
  if (!selected) {
    throw new AgentRunError(
      "model_required",
      "No default chat model is configured",
      409
    );
  }
  return selected;
}

function normalizeCreateRunRequest(value: unknown) {
  if (!value || typeof value !== "object") {
    throw new AgentRunError("invalid_run", "Run request is required");
  }
  const candidate = value as Partial<CreateAgentRunRequest>;
  const idempotencyKey = candidate.idempotencyKey?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200) {
    throw new AgentRunError(
      "invalid_idempotency_key",
      "An idempotency key of at most 200 characters is required"
    );
  }
  const messages = normalizeAgentChatMessages([candidate.message]);
  const message = messages[0];
  if (!message || message.role !== "user") {
    throw new AgentRunError("invalid_message", "One user message is required");
  }
  return {
    idempotencyKey,
    originMessageId:
      typeof candidate.originMessageId === "string" && candidate.originMessageId.trim()
        ? candidate.originMessageId.trim()
        : undefined,
    modelSelection: candidate.modelSelection?.trim() || undefined,
    message,
    metadata: candidate.metadata ?? {}
  };
}

function hasUntrustedContent(message: AgentChatMessage, project?: ProjectAgentContext) {
  return Boolean(
    message.attachments?.length ||
    project?.memory.trim() ||
    project?.contextItems.length
  );
}

async function loadRunContext(
  trx: Transaction<Database>,
  principal: AgentRunPrincipal,
  thread: { id: string; projectId: string | null }
) {
  const rows = await trx.selectFrom("sessionMessages")
    .select(["role", "content", "metadata"])
    .where("threadId", "=", thread.id)
    .where("organizationId", "=", principal.organizationId)
    .where("supersededAt", "is", null)
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .execute();
  const messages: AgentChatMessage[] = rows.flatMap((row) =>
    row.role === "user" || row.role === "assistant"
      ? [{
          role: row.role,
          content: row.content,
          attachments: attachmentsFromMetadata(row.metadata)
        }]
      : []
  );
  if (!thread.projectId) return { messages };
  const project = await trx.selectFrom("projects").selectAll()
    .where("id", "=", thread.projectId)
    .where("organizationId", "=", principal.organizationId)
    .where("ownerUserId", "=", principal.userId)
    .executeTakeFirst();
  if (!project) return { messages };
  const items = await trx.selectFrom("projectContextItems")
    .select(["filename", "mediaType", "content"])
    .where("projectId", "=", project.id)
    .where("organizationId", "=", principal.organizationId)
    .orderBy("createdAt", "asc")
    .execute();
  return {
    messages,
    project: {
      id: project.id,
      name: project.name,
      instructions: project.instructions,
      memory: project.memory,
      contextItems: projectContextForPrompt(items)
    }
  };
}

function toRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    organizationId: row.organizationId,
    sessionId: row.sessionId,
    originMessageId: row.originMessageId,
    assistantMessageId: row.assistantMessageId,
    initiatedByUserId: row.initiatedByUserId,
    agentRevisionId: row.agentRevisionId,
    environmentId: row.environmentId,
    status: row.status,
    purpose: row.purpose,
    idempotencyKey: row.idempotencyKey,
    capabilityDigest: row.capabilityDigest,
    configurationDigest: row.configurationDigest,
    isolationProvider: row.isolationProvider,
    untrustedContentIngested: row.untrustedContentIngested,
    modelSelection: row.modelSelection,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
    startedAt: row.startedAt ? toIso(row.startedAt) : null,
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
    cancelledAt: row.cancelledAt ? toIso(row.cancelledAt) : null
  };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function recordRunAudit(
  trx: Transaction<Database>,
  principal: AgentRunPrincipal,
  runId: string,
  action: string,
  metadata: Record<string, unknown>
) {
  await trx.insertInto("auditEvents").values({
    organizationId: principal.organizationId,
    userId: principal.userId,
    sessionId: null,
    action,
    targetType: "agent_run",
    targetId: runId,
    metadata: {
      ...metadata,
      ...(principal.tokenId ? { apiTokenId: principal.tokenId } : {})
    },
    createdAt: new Date()
  }).execute();
}

export function isTerminalRunStatus(status: AgentRunStatus) {
  return terminalStatuses.has(status);
}

export function sessionMessageFromRow(row: SessionMessageRow) {
  return {
    id: row.id,
    sessionId: row.threadId,
    role: row.role,
    content: row.content,
    metadata: row.metadata,
    tokenCount: row.tokenCount,
    byteSize: row.byteSize,
    createdAt: toIso(row.createdAt)
  };
}
