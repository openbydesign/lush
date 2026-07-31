/**
 * Tool gateway invocation plane.
 *
 * The single mediated path from a caller to an external tool. It verifies the
 * principal, connection, definition digest, and input schema; makes a policy and
 * approval decision; resolves credentials server-side; invokes the connector
 * under time and byte bounds; normalizes the result; and persists an attributable
 * `tool_call` before returning a bounded result. Tool output is treated as
 * untrusted and is never allowed to influence the capability decision.
 */

import { getDb } from "@lush/db/client";
import type {
  Database,
  ToolAnnotations,
  ToolCallStatus,
  ToolConnectionRow,
  ToolDefinitionRow
} from "@lush/db/schema";
import { createLogger } from "@lush/logging/logger";
import type { Kysely, Transaction } from "kysely";
import { buildConnector } from "./connector-factory";
import {
  ConnectorError,
  defaultConnectorLimits,
  type ConnectorLimits,
  type ToolResult,
  type ToolResultContent
} from "./connectors/types";
import { sha256Hex, canonicalJson } from "./digest";
import {
  ToolError,
  requireVisibleConnection,
  resolveCredential,
  type ToolsPrincipal
} from "./runtime";
import { validateInput } from "./validate";
import { decideApproval } from "./policy";

export { decideApproval } from "./policy";

const logger = createLogger("@lush/tools");

const MAX_PREVIEW_BYTES = 8_000;
const MAX_INPUT_BYTES = 256_000;
const MAX_IDEMPOTENCY_KEY_BYTES = 256;

export type InvokeToolRequest = {
  connectionId: string;
  /** External tool name or the stable qualified alias. */
  toolName: string;
  input: unknown;
  /** The exact definition digest resolved into the caller's capability. */
  expectedDefinitionDigest: string;
  idempotencyKey?: string;
  runId?: string;
};

export type ApprovalDescriptor = {
  approvalId: string;
  scope: string;
  definitionDigest: string;
  inputDigest: string;
  expiresAt: string;
};

export type GatewayOutcome =
  | { status: "succeeded" | "failed"; toolCallId: string; result: ToolResult }
  | { status: "denied"; toolCallId: string | null; reason: string }
  | {
      status: "approval_required";
      toolCallId: string;
      approval: ApprovalDescriptor;
    };

export type InvokeToolOptions = {
  signal?: AbortSignal;
  limits?: Partial<ConnectorLimits>;
  /** Test-only DNS resolver, forwarded to the connector transport. */
  resolver?: (host: string) => Promise<string[]>;
};

export async function invokeTool(
  principal: ToolsPrincipal,
  request: InvokeToolRequest,
  options: InvokeToolOptions = {}
): Promise<GatewayOutcome> {
  validateInvocationRequest(request);
  const connection = await requireVisibleConnection(principal, request.connectionId);
  if (!connection.enabled) {
    return { status: "denied", toolCallId: null, reason: "connection_disabled" };
  }

  const definition = await loadDefinition(connection.id, request.toolName);
  if (!definition.enabled) {
    return { status: "denied", toolCallId: null, reason: "tool_disabled" };
  }

  // A catalog change must never silently alter a tool under an existing caller.
  if (request.expectedDefinitionDigest !== definition.definitionDigest) {
    return { status: "denied", toolCallId: null, reason: "definition_changed" };
  }

  const input = request.input ?? {};
  const canonicalInput = canonicalJson(input);
  if (new TextEncoder().encode(canonicalInput).byteLength > MAX_INPUT_BYTES) {
    throw new ToolError("input_too_large", "Tool input exceeds 256000 bytes", 413);
  }
  const validation = validateInput(
    (definition.inputSchema as Record<string, unknown>) ?? {},
    input
  );
  if (!validation.ok) {
    throw new ToolError(
      "input_invalid",
      `Tool input failed validation: ${validation.errors.join("; ")}`,
      400
    );
  }

  const inputDigest = await sha256Hex(canonicalInput);
  const annotations = normalizeAnnotations(definition.annotations);
  const decision = decideApproval(annotations, connection.policy);

  if (decision === "deny") {
    // Do not consume the idempotency key on a policy denial: a later policy
    // change must not be permanently blocked for that key.
    const toolCallId = await persistCall({
      principal,
      connection,
      definition,
      input,
      inputDigest,
      runId: request.runId,
      status: "denied",
      policyDecision: { decision, annotations },
      isError: true
    });
    return { status: "denied", toolCallId, reason: "policy_denied" };
  }

  // Idempotency: a replay with the same key returns the prior call's outcome
  // rather than executing (or re-inserting, which the unique index forbids). An
  // in-flight prior is an explicit conflict — we never retry an ambiguous call.
  let toolCallId: string | undefined;
  if (request.idempotencyKey) {
    const prior = await findPriorCall(
      connection.id,
      principal.userId,
      request.idempotencyKey
    );
    if (prior) {
      assertIdempotencyBinding(prior, {
        definition,
        definitionDigest: request.expectedDefinitionDigest,
        inputDigest,
        runId: request.runId
      });
      if (prior.status === "waiting_for_approval") {
        const approval = await findApprovalForCall(
          prior.id,
          principal.organizationId,
          principal.userId
        );
        if (approval?.status === "pending") {
          return approvalRequiredOutcome(prior.id, approval);
        }
        if (approval?.status === "approved") {
          toolCallId = await consumeApprovalCall(approval.id, request.idempotencyKey);
        } else if (approval?.status === "denied") {
          return { status: "denied", toolCallId: prior.id, reason: "approval_denied" };
        } else {
          throw new ToolError(
            "idempotency_conflict",
            "The prior tool call has an unresolved or expired outcome",
            409
          );
        }
      } else {
        return outcomeFromPriorCall(prior);
      }
    }
  }

  // An approved, unexpired, single-use approval for this exact input lets the
  // call proceed by reusing its already-created call row.
  if (!toolCallId && decision === "approve") {
    const approved = await findApprovedApproval({
      organizationId: principal.organizationId,
      definitionId: definition.id,
      userId: principal.userId,
      runId: request.runId,
      definitionDigest: definition.definitionDigest,
      inputDigest
    });
    if (!approved) {
      try {
        return await requestApproval({
          principal,
          connection,
          definition,
          input,
          inputDigest,
          runId: request.runId,
          idempotencyKey: request.idempotencyKey,
          annotations
        });
      } catch (error) {
        throw idempotencyRace(error, request.idempotencyKey);
      }
    }
    // Consume the approval (single-use) and transition its call to running.
    toolCallId = await consumeApprovalCall(approved.id, request.idempotencyKey);
  } else if (!toolCallId) {
    // Authorized without approval: persist a running call, then invoke.
    try {
      toolCallId = await persistCall({
        principal,
        connection,
        definition,
        input,
        inputDigest,
        runId: request.runId,
        idempotencyKey: request.idempotencyKey,
        status: "running",
        policyDecision: { decision, annotations },
        isError: false
      });
    } catch (error) {
      throw idempotencyRace(error, request.idempotencyKey);
    }
  }

  const limits: ConnectorLimits = {
    timeoutMs:
      definition.timeoutMs ??
      options.limits?.timeoutMs ??
      defaultConnectorLimits.timeoutMs,
    maxResponseBytes:
      options.limits?.maxResponseBytes ?? defaultConnectorLimits.maxResponseBytes
  };

  try {
    const credential = await resolveCredential(connection, principal.userId);
    const connector = buildConnector({
      connection,
      credential,
      maxResponseBytes: limits.maxResponseBytes,
      resolver: options.resolver
    });

    // Always impose a wall-clock deadline, even when the caller passes no
    // signal, so a connector without its own timeout cannot hang the call.
    const deadline = AbortSignal.timeout(limits.timeoutMs);
    const invocationSignal = options.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline;

    let result: ToolResult;
    try {
      result = await connector.invoke({
        externalName: definition.externalName,
        input,
        sourceMetadata: definition.sourceMetadata,
        limits,
        signal: invocationSignal,
        idempotencyKey: request.idempotencyKey
      });
    } finally {
      await connector.close?.();
    }

    const bounded = boundResult(result, limits.maxResponseBytes);
    await completeCall(toolCallId, {
      status: bounded.isError ? "failed" : "succeeded",
      isError: bounded.isError,
      outputPreview: toPreview(bounded)
    });
    await audit(principal, connection, definition, toolCallId, bounded.isError ? "failed" : "succeeded");

    return {
      status: bounded.isError ? "failed" : "succeeded",
      toolCallId,
      result: bounded
    };
  } catch (error) {
    const { code, message } = toToolFailure(error);
    await completeCall(toolCallId, {
      status: "failed",
      isError: true,
      errorCode: code,
      errorMessage: message
    });
    await audit(principal, connection, definition, toolCallId, "failed", code);
    // Connector/transport failures are surfaced as a failed ToolResult rather
    // than thrown, so a model loop can observe and react to the error.
    if (error instanceof ToolError) {
      throw error;
    }
    return {
      status: "failed",
      toolCallId,
      result: {
        isError: true,
        content: [{ type: "text", text: `Tool call failed (${code}): ${message}` }]
      }
    };
  }
}

/**
 * Record a human's decision on a pending approval. Approving does not execute
 * the call; the caller re-invokes with the same input, which then matches the
 * approved record. Editing arguments changes the input digest and invalidates
 * the approval.
 */
export async function decideToolApproval(
  principal: ToolsPrincipal,
  approvalId: string,
  approve: boolean
): Promise<{ approvalId: string; status: "approved" | "denied" }> {
  if (!isUuid(approvalId)) {
    throw new ToolError("invalid_approval", "Approval id must be a UUID", 400);
  }
  const db = getDb();
  const approval = await db
    .selectFrom("toolApprovals")
    .selectAll()
    .where("id", "=", approvalId)
    .where("organizationId", "=", principal.organizationId)
    .where("initiatedByUserId", "=", principal.userId)
    .executeTakeFirst();
  if (!approval) {
    throw new ToolError("approval_not_found", "Approval was not found", 404);
  }
  if (approval.status !== "pending") {
    throw new ToolError("approval_settled", "Approval was already decided", 409);
  }
  if (new Date(approval.expiresAt).getTime() < Date.now()) {
    const now = new Date();
    const expired = await db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("toolApprovals")
        .set({ status: "expired", decidedAt: now })
        .where("id", "=", approvalId)
        .where("status", "=", "pending")
        .returning("toolCallId")
        .executeTakeFirst();
      if (!claimed) return false;
      // Close the associated call so it is not left permanently in-flight.
      if (claimed.toolCallId) {
        await trx
          .updateTable("toolCalls")
          .set({ status: "cancelled", completedAt: now })
          .where("id", "=", claimed.toolCallId)
          .where("status", "=", "waiting_for_approval")
          .execute();
      }
      return true;
    });
    if (!expired) {
      throw new ToolError("approval_settled", "Approval was already decided", 409);
    }
    throw new ToolError("approval_expired", "Approval has expired", 409);
  }

  const status = approve ? "approved" : "denied";
  const now = new Date();
  const decided = await db.transaction().execute(async (trx) => {
    const claimed = await trx
      .updateTable("toolApprovals")
      .set({ status, decidedByUserId: principal.userId, decidedAt: now })
      .where("id", "=", approvalId)
      .where("status", "=", "pending")
      .where("expiresAt", ">", now)
      .returning("toolCallId")
      .executeTakeFirst();
    if (!claimed) return false;
    // On approval the call stays `waiting_for_approval` until the re-invocation
    // consumes the approval and transitions it to `running` (see
    // consumeApprovalCall). On denial the call is terminal.
    if (!approve && claimed.toolCallId) {
      await trx
        .updateTable("toolCalls")
        .set({ status: "denied", completedAt: now })
        .where("id", "=", claimed.toolCallId)
        .where("status", "=", "waiting_for_approval")
        .execute();
    }
    return true;
  });
  if (!decided) {
    throw new ToolError("approval_settled", "Approval was already decided", 409);
  }

  return { approvalId, status };
}

// ---------------------------------------------------------------------------

async function requestApproval(params: {
  principal: ToolsPrincipal;
  connection: ToolConnectionRow;
  definition: ToolDefinitionRow;
  input: unknown;
  inputDigest: string;
  runId?: string;
  idempotencyKey?: string;
  annotations: ToolAnnotations;
}): Promise<GatewayOutcome> {
  const db = getDb();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60_000);

  const { toolCallId, approvalId } = await db.transaction().execute(async (trx) => {
    const call = await insertCall(trx, {
      ...params,
      status: "waiting_for_approval",
      policyDecision: { decision: "approve", annotations: params.annotations },
      isError: false
    });
    const approval = await trx
      .insertInto("toolApprovals")
      .values({
        organizationId: params.principal.organizationId,
        toolCallId: call.id,
        connectionId: params.connection.id,
        toolDefinitionId: params.definition.id,
        runId: params.runId ?? null,
        initiatedByUserId: params.principal.userId,
        inputDigest: params.inputDigest,
        definitionDigest: params.definition.definitionDigest,
        scope: "once",
        status: "pending",
        expiresAt,
        createdAt: now
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { toolCallId: call.id, approvalId: approval.id };
  });

  return {
    status: "approval_required",
    toolCallId,
    approval: {
      approvalId,
      scope: "once",
      definitionDigest: params.definition.definitionDigest,
      inputDigest: params.inputDigest,
      expiresAt: expiresAt.toISOString()
    }
  };
}

async function findApprovalForCall(
  toolCallId: string,
  organizationId: string,
  userId: string
) {
  return getDb()
    .selectFrom("toolApprovals")
    .selectAll()
    .where("toolCallId", "=", toolCallId)
    .where("organizationId", "=", organizationId)
    .where("initiatedByUserId", "=", userId)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();
}

function approvalRequiredOutcome(
  toolCallId: string,
  approval: {
    id: string;
    scope: string;
    definitionDigest: string;
    inputDigest: string;
    expiresAt: Date | string;
  }
): GatewayOutcome {
  return {
    status: "approval_required",
    toolCallId,
    approval: {
      approvalId: approval.id,
      scope: approval.scope,
      definitionDigest: approval.definitionDigest,
      inputDigest: approval.inputDigest,
      expiresAt: new Date(approval.expiresAt).toISOString()
    }
  };
}

async function findApprovedApproval(params: {
  organizationId: string;
  definitionId: string;
  userId: string;
  runId?: string;
  definitionDigest: string;
  inputDigest: string;
}): Promise<{ id: string; toolCallId: string | null } | null> {
  // An approval is bound to the run: an approval granted for one run must never
  // authorize a call from a different run. A null run matches only a null run.
  const base = getDb()
    .selectFrom("toolApprovals")
    .select(["id", "toolCallId"])
    .where("organizationId", "=", params.organizationId)
    .where("toolDefinitionId", "=", params.definitionId)
    .where("initiatedByUserId", "=", params.userId)
    .where("definitionDigest", "=", params.definitionDigest)
    .where("inputDigest", "=", params.inputDigest)
    .where("status", "=", "approved")
    .where("expiresAt", ">", new Date());
  const row = await (params.runId
    ? base.where("runId", "=", params.runId)
    : base.where("runId", "is", null)
  ).executeTakeFirst();
  return row ?? null;
}

/**
 * Consume a single-use approval and move its already-created call to running.
 * Reusing the approval's call row avoids leaving an orphaned
 * `waiting_for_approval` record behind on re-invocation.
 */
async function consumeApprovalCall(
  approvalId: string,
  idempotencyKey: string | undefined
): Promise<string> {
  const now = new Date();
  return getDb().transaction().execute(async (trx) => {
    // Claim the approval exactly once. Concurrent re-invocations cannot both
    // transition the same approved row and execute the side effect.
    const approval = await trx
      .updateTable("toolApprovals")
      .set({ status: "expired", decidedAt: now })
      .where("id", "=", approvalId)
      .where("status", "=", "approved")
      .where("expiresAt", ">", now)
      .returning("toolCallId")
      .executeTakeFirst();
    if (!approval) {
      throw new ToolError(
        "approval_unavailable",
        "Approval was already consumed or has expired",
        409
      );
    }

    if (approval.toolCallId) {
      const call = await trx
        .updateTable("toolCalls")
        .set({ status: "running", idempotencyKey: idempotencyKey ?? null })
        .where("id", "=", approval.toolCallId)
        .where("status", "=", "waiting_for_approval")
        .returning("id")
        .executeTakeFirst();
      if (call) return call.id;
    }
    // Defensive: an approval with no linked call should not occur, but if it
    // does, surface it rather than silently proceeding without a record.
    throw new ToolError(
      "approval_call_missing",
      "Approval has no associated tool call",
      409
    );
  });
}

/** Map a prior idempotent call to the outcome it should replay. */
function outcomeFromPriorCall(prior: {
  id: string;
  status: ToolCallStatus;
  isError: boolean;
  outputPreview: unknown;
}): GatewayOutcome {
  switch (prior.status) {
    case "succeeded":
      return {
        status: "succeeded",
        toolCallId: prior.id,
        result: previewToResult(prior.outputPreview, prior.isError)
      };
    case "failed":
      return {
        status: "failed",
        toolCallId: prior.id,
        result: previewToResult(prior.outputPreview, true)
      };
    case "denied":
      return { status: "denied", toolCallId: prior.id, reason: "policy_denied" };
    default:
      // running / waiting_for_approval / proposed / cancelled: do not re-execute
      // an ambiguous or in-flight call under the same key.
      throw new ToolError(
        "idempotency_conflict",
        "A tool call with this idempotency key is already in progress",
        409
      );
  }
}

function validateInvocationRequest(request: InvokeToolRequest): void {
  if (!isUuid(request.connectionId)) {
    throw new ToolError("invalid_invocation", "Connection id must be a UUID", 400);
  }
  if (
    typeof request.toolName !== "string" ||
    request.toolName.length === 0 ||
    request.toolName.length > 256
  ) {
    throw new ToolError("invalid_invocation", "Tool name is invalid", 400);
  }
  if (
    typeof request.expectedDefinitionDigest !== "string" ||
    request.expectedDefinitionDigest.length === 0 ||
    request.expectedDefinitionDigest.length > 128
  ) {
    throw new ToolError(
      "definition_digest_required",
      "A resolved tool definition digest is required",
      400
    );
  }
  if (request.idempotencyKey !== undefined) {
    if (
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.length === 0 ||
      new TextEncoder().encode(request.idempotencyKey).byteLength >
        MAX_IDEMPOTENCY_KEY_BYTES
    ) {
      throw new ToolError("invalid_invocation", "Idempotency key is invalid", 400);
    }
  }
  if (request.runId !== undefined && !isUuid(request.runId)) {
    throw new ToolError("invalid_invocation", "Run id must be a UUID", 400);
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}

function idempotencyRace(error: unknown, idempotencyKey: string | undefined): unknown {
  if (
    idempotencyKey &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    return new ToolError(
      "idempotency_conflict",
      "A concurrent tool call already claimed this idempotency key",
      409
    );
  }
  return error;
}

async function loadDefinition(
  connectionId: string,
  toolName: string
): Promise<ToolDefinitionRow> {
  const row = await getDb()
    .selectFrom("toolDefinitions")
    .selectAll()
    .where("connectionId", "=", connectionId)
    .where((eb) =>
      eb.or([eb("externalName", "=", toolName), eb("qualifiedName", "=", toolName)])
    )
    .executeTakeFirst();
  if (!row) {
    throw new ToolError("tool_not_found", `Tool '${toolName}' was not found`, 404);
  }
  return row;
}

async function findPriorCall(
  connectionId: string,
  userId: string,
  idempotencyKey: string
) {
  return getDb()
    .selectFrom("toolCalls")
    .selectAll()
    .where("connectionId", "=", connectionId)
    .where("initiatedByUserId", "=", userId)
    .where("idempotencyKey", "=", idempotencyKey)
    .executeTakeFirst();
}

function assertIdempotencyBinding(
  prior: {
    toolDefinitionId: string | null;
    definitionDigest: string;
    inputDigest: string;
    runId: string | null;
  },
  current: {
    definition: ToolDefinitionRow;
    definitionDigest: string;
    inputDigest: string;
    runId?: string;
  }
): void {
  const sameOperation =
    prior.toolDefinitionId === current.definition.id &&
    prior.definitionDigest === current.definitionDigest &&
    prior.inputDigest === current.inputDigest &&
    prior.runId === (current.runId ?? null);
  if (!sameOperation) {
    throw new ToolError(
      "idempotency_mismatch",
      "Idempotency key was already used for a different tool operation",
      409
    );
  }
}

async function persistCall(params: PersistCallParams): Promise<string> {
  const call = await insertCall(getDb(), params);
  return call.id;
}

type PersistCallParams = {
  principal: ToolsPrincipal;
  connection: ToolConnectionRow;
  definition: ToolDefinitionRow;
  input: unknown;
  inputDigest: string;
  runId?: string;
  idempotencyKey?: string;
  status: ToolCallStatus;
  policyDecision: unknown;
  isError: boolean;
};

async function insertCall(
  db: Kysely<Database> | Transaction<Database>,
  params: PersistCallParams
) {
  return db
    .insertInto("toolCalls")
    .values({
      organizationId: params.principal.organizationId,
      connectionId: params.connection.id,
      toolDefinitionId: params.definition.id,
      runId: params.runId ?? null,
      initiatedByUserId: params.principal.userId,
      status: params.status,
      input: params.input,
      inputDigest: params.inputDigest,
      definitionDigest: params.definition.definitionDigest,
      isError: params.isError,
      policyDecision: params.policyDecision,
      idempotencyKey: params.idempotencyKey ?? null,
      createdAt: new Date()
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function completeCall(
  toolCallId: string,
  update: {
    status: ToolCallStatus;
    isError: boolean;
    outputPreview?: unknown;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<void> {
  await getDb()
    .updateTable("toolCalls")
    .set({
      status: update.status,
      isError: update.isError,
      outputPreview: update.outputPreview ?? null,
      errorCode: update.errorCode ?? null,
      errorMessage: update.errorMessage ?? null,
      completedAt: new Date()
    })
    .where("id", "=", toolCallId)
    .execute();
}

async function audit(
  principal: ToolsPrincipal,
  connection: ToolConnectionRow,
  definition: ToolDefinitionRow,
  toolCallId: string,
  outcome: string,
  errorCode?: string
): Promise<void> {
  try {
    await getDb()
      .insertInto("auditEvents")
      .values({
        organizationId: principal.organizationId,
        userId: principal.userId,
        sessionId: null,
        action: `tool.call.${outcome}`,
        targetType: "tool_call",
        targetId: toolCallId,
        metadata: {
          connectionId: connection.id,
          toolDefinitionId: definition.id,
          tool: definition.externalName,
          errorCode: errorCode ?? null
        },
        createdAt: new Date()
      })
      .execute();
  } catch (error) {
    logger.error({ err: error, toolCallId }, "failed to write tool call audit event");
  }
}

/**
 * Clamp total result content to a byte ceiling, marking truncation. A text block
 * that would overflow is truncated to the remaining budget (rather than dropping
 * it and everything after) so the caller still receives as much as fits.
 */
function boundResult(result: ToolResult, maxBytes: number): ToolResult {
  let total = 0;
  const content: ToolResultContent[] = [];
  let truncated = false;

  for (const block of result.content) {
    const size = blockSize(block);
    if (total + size <= maxBytes) {
      total += size;
      content.push(block);
      continue;
    }

    const remaining = maxBytes - total;
    if (block.type === "text" && remaining > 0) {
      content.push({ type: "text", text: truncateToBytes(block.text, remaining) });
    }
    truncated = true;
    break;
  }

  if (truncated) {
    content.push({
      type: "text",
      text: `[output truncated: exceeded ${maxBytes} bytes]`
    });
  }
  return { ...result, content };
}

function blockSize(block: ToolResultContent): number {
  switch (block.type) {
    case "text":
      return byteLength(block.text);
    case "json":
      return byteLength(JSON.stringify(block.data));
    case "resource":
      return byteLength(block.text ?? "") + byteLength(block.uri);
    case "binary":
      return byteLength(block.base64);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a char. */
function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }
  const buffer = Buffer.from(value, "utf8").subarray(0, maxBytes);
  // Decoding with a stream decoder drops a trailing partial multi-byte sequence.
  return new TextDecoder("utf-8").decode(buffer);
}

function toPreview(result: ToolResult): unknown {
  const serialized = JSON.stringify(result);
  if (byteLength(serialized) <= MAX_PREVIEW_BYTES) {
    return result;
  }
  return {
    isError: result.isError,
    truncated: true,
    content: [{ type: "text", text: truncateToBytes(serialized, MAX_PREVIEW_BYTES) }]
  };
}

function previewToResult(preview: unknown, isError: boolean): ToolResult {
  if (isObject(preview) && Array.isArray(preview.content)) {
    return {
      isError: preview.isError === true,
      content: preview.content as ToolResultContent[],
      structured: preview.structured
    };
  }
  return { isError, content: [] };
}

function normalizeAnnotations(value: unknown): ToolAnnotations {
  if (!isObject(value)) {
    return { readOnly: false, destructive: true, idempotent: false, openWorld: true };
  }
  return {
    readOnly: value.readOnly === true,
    destructive: value.destructive !== false,
    idempotent: value.idempotent === true,
    openWorld: value.openWorld !== false
  };
}

function toToolFailure(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof ToolError || error instanceof ConnectorError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof Error) {
    return { code: "tool_call_failed", message: error.message, status: 502 };
  }
  return { code: "tool_call_failed", message: "Tool call failed", status: 502 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
