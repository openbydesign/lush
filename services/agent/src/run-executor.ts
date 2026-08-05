import { timingSafeEqual } from "node:crypto";
import { getDb } from "@lush/db/client";
import type { AgentRunRow, Database } from "@lush/db/schema";
import { createLogger } from "@lush/logging/logger";
import { messageByteSize, titleFromContent } from "@lush/sessions/runtime";
import { canonicalJson, sha256Hex } from "@lush/tools/digest";
import { invokeTool } from "@lush/tools/gateway";
import { isToolGatewayEnabled } from "@lush/tools/runtime";
import type { Transaction } from "kysely";
import { textMessage, type Message } from "./harness/content";
import type { EventLog, ConversationEvent } from "./harness/protocol";
import { runExec } from "./harness/orchestrator";
import { InFlightRegistry } from "./harness/event-log";
import {
  ActiveExecutionClock,
  type AgentEnvironmentHandle,
  type IsolationProvider
} from "./harness/isolation";
import {
  configuredIsolationRuntime,
  createIsolationProvider,
  type IsolationProviderKind
} from "./harness/provider";
import {
  AgentRunError,
  appendRunEvent,
  isTerminalRunStatus,
  parseRunConfiguration,
  registerLocalRun,
  type AgentRunCapabilitiesV1,
  type AgentRunConfigurationV1
} from "./runs";
import { streamLushAgentChat, streamLushAgentTurn } from "./runtime";

const logger = createLogger("@lush/agent-runs");
const leaseMs = 150_000;
const leaseRenewMs = 30_000;
const authorizationPollMs = 250;
const brokerHeartbeatMs = 5_000;
export const agentToolExecutionTimeoutMs = 35_000;
const executions = new Map<string, Promise<void>>();
const inFlight = new InFlightRegistry();
type InferenceBroker = {
  url: string;
  stop(closeActiveConnections?: boolean): void;
};

type ClaimedRun = {
  run: AgentRunRow;
  leaseOwner: string;
  nextSequence: number;
  recovery: "new" | "resume" | "completed" | "failed" | "canceled";
};

export function scheduleAgentRunExecution(runId: string): Promise<void> {
  const existing = executions.get(runId);
  if (existing) return existing;
  const execution = executeAgentRun(runId)
    .catch((error) => {
      logger.error({ err: error, runId }, "durable agent run failed");
    })
    .finally(() => executions.delete(runId));
  executions.set(runId, execution);
  return execution;
}

export async function recoverAgentRuns(): Promise<number> {
  const isolation = configuredIsolationRuntime();
  const now = new Date();
  const rows = await getDb().selectFrom("agentRuns")
    .select("id")
    .where("isolationProvider", "=", isolation.kind)
    .where((eb) => eb.or([
      eb("status", "=", "queued"),
      eb.and([
        eb("status", "in", ["running", "waiting_for_approval"]),
        eb.or([
          eb("leaseExpiresAt", "is", null),
          eb("leaseExpiresAt", "<", now)
        ])
      ])
    ]))
    .execute();
  for (const row of rows) scheduleAgentRunExecution(row.id);
  return rows.length;
}

export function startAgentRunRecoveryLoop(intervalMs = 30_000): () => void {
  void recoverAgentRuns().catch((error) =>
    logger.error({ err: error }, "initial agent-run recovery scan failed")
  );
  const timer = setInterval(() => {
    void recoverAgentRuns().catch((error) =>
      logger.error({ err: error }, "agent-run recovery scan failed")
    );
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function executeAgentRun(runId: string): Promise<void> {
  const isolation = configuredIsolationRuntime();
  const claimed = await claimRun(runId, isolation.kind);
  if (!claimed) return;

  const configuration = parseRunConfiguration(claimed.run.configuration);
  const controller = new AbortController();
  const unregister = registerLocalRun(runId, controller);
  const stopLease = maintainLease(claimed, controller);
  let provider: IsolationProvider | undefined;
  let environment: AgentEnvironmentHandle | undefined;
  let broker: InferenceBroker | undefined;
  let assistantText = "";
  const activeExecutionClock = new ActiveExecutionClock();

  try {
    const capabilities = await loadRunCapabilities(claimed);
    if (claimed.recovery === "completed") {
      assistantText = await completedConversationText(claimed.run.id);
      await completeRun(claimed, assistantText);
      await generateInternalTitle(claimed.run, configuration, assistantText)
        .catch((error) => logger.warn({ err: error, runId }, "title task failed"));
      return;
    }
    if (claimed.recovery === "failed" || claimed.recovery === "canceled") {
      await failRun(
        claimed,
        new Error(`Recovered harness execution ended ${claimed.recovery}`),
        await completedConversationText(claimed.run.id)
      );
      return;
    }
    const capabilityToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    broker = startInferenceBroker(
      claimed,
      configuration,
      capabilities,
      capabilityToken,
      controller.signal,
      activeExecutionClock,
      isolation.kind === "remote" ? isolation.sandboxBrokerBaseUrl : undefined
    );
    provider = createIsolationProvider(isolation, { activeExecutionClock });
    environment = await provider.provision({
      environmentId: claimed.run.environmentId,
      profile: "chat",
      organizationId: claimed.run.organizationId,
      ownerUserId: claimed.run.initiatedByUserId,
      sessionId: claimed.run.sessionId,
      harnessId: "lush-brokered",
      limits: limitsFromRun(claimed.run)
    });
    await markEnvironmentRunning(claimed, environment.id);
    if (claimed.recovery === "resume") {
      await appendPublicEvent(claimed, "response-reset", {
        reason: "execution_recovered"
      });
    }
    await appendPublicEvent(claimed, "response-start", {});

    const log = new PostgresRunEventLog(claimed);
    const requestMessages: Message[] = claimed.recovery === "resume"
      ? []
      : [textMessage("user", originText(configuration))];
    for await (const frame of runExec({
      request: {
        conversationId: claimed.run.id,
        inputs: requestMessages,
        harnessId: "lush-brokered",
        harnessConfig: {
          brokerUrl: broker.url,
          capabilityToken,
          configurationDigest: claimed.run.configurationDigest,
          configuration
        }
      },
      log,
      harness: environment.harness(),
      inFlight,
      signal: controller.signal,
      execId: claimed.run.id
    })) {
      for (const message of frame.outputs) {
        if (message.role === "assistant" && message.content.type === "text") {
          const firstToken = assistantText.length === 0;
          await appendPublicEvent(claimed, "text-delta", {
            delta: message.content.text,
            ...(firstToken
              ? { firstTokenMs: Date.now() - new Date(claimed.run.createdAt).getTime() }
              : {})
          });
          assistantText += message.content.text;
          if (firstToken) {
            logger.info({
              runId,
              firstTokenMs: Date.now() - new Date(claimed.run.createdAt).getTime()
            }, "agent run first token");
          }
        } else if (message.content.type === "tool_call") {
          const presentation = toolPresentation(capabilities, message.content.name);
          await appendPublicEvent(claimed, "tool-input", {
            toolCallId: message.content.id,
            toolName: message.content.name,
            input: message.content.arguments,
            ...presentation
          });
        } else if (message.content.type === "confirmation") {
          const presentation = toolPresentation(capabilities, message.content.toolName);
          await appendPublicEvent(claimed, "tool-approval-required", {
            approvalId: message.content.id,
            toolCallId: message.content.toolCallId,
            toolName: message.content.toolName,
            expiresAt: message.content.expiresAt,
            ...presentation
          });
          await markRunWaitingForApproval(claimed, message.content.id);
        } else if (message.content.type === "tool_result") {
          const presentation = toolPresentation(capabilities, message.content.name);
          await appendPublicEvent(claimed, "tool-output", {
            toolCallId: message.content.callId,
            toolName: message.content.name,
            ...presentation,
            ...(message.content.isError
              ? { errorText: toolErrorText(message.content.response) }
              : { output: message.content.response })
          });
        }
      }
    }

    const latest = await getDb().selectFrom("agentRuns").select("status")
      .where("id", "=", runId).executeTakeFirst();
    if (latest?.status === "cancelled" || controller.signal.aborted) {
      await persistPartialAssistant(claimed.run, assistantText);
      return;
    }
    const assistantMessageId = await completeRun(claimed, assistantText);
    await generateInternalTitle(claimed.run, configuration, assistantText)
      .catch((error) => logger.warn({ err: error, runId }, "title task failed"));
    logger.info({ runId, assistantMessageId }, "durable agent run completed");
  } catch (error) {
    const latest = await getDb().selectFrom("agentRuns").select("status")
      .where("id", "=", runId).executeTakeFirst();
    if (latest?.status === "cancelled" || controller.signal.aborted) {
      await persistPartialAssistant(claimed.run, assistantText);
      return;
    }
    await failRun(claimed, error, assistantText);
    throw error;
  } finally {
    stopLease();
    unregister();
    broker?.stop(true);
    await environment?.destroy().catch(() => {});
  }
}

function toolPresentation(
  capabilities: AgentRunCapabilitiesV1,
  toolName: string
) {
  const tool = capabilities.tools.find((candidate) => candidate.name === toolName);
  return tool
    ? {
        toolTitle: tool.title,
        connectionLabel: tool.connectionLabel,
        connectionSource: tool.connectionSource,
        ...(tool.connectionIconUrl ? { connectionIconUrl: tool.connectionIconUrl } : {})
      }
    : {};
}

class PostgresRunEventLog implements EventLog {
  constructor(private readonly claimed: ClaimedRun) {}

  async append(event: Omit<ConversationEvent, "step">): Promise<number> {
    return appendClaimedEvent(this.claimed, "conversation", event);
  }

  async events(): Promise<ConversationEvent[]> {
    const rows = await getDb().selectFrom("agentRunEvents")
      .select(["sequence", "payload"])
      .where("runId", "=", this.claimed.run.id)
      .where("type", "=", "conversation")
      .orderBy("sequence", "asc")
      .execute();
    return rows.map((row) => ({
      ...(row.payload as Omit<ConversationEvent, "step">),
      step: row.sequence
    }));
  }

  async deleteAll(): Promise<void> {
    throw new Error("Durable run events are append-only");
  }
}

async function claimRun(
  runId: string,
  isolationProvider: IsolationProviderKind
): Promise<ClaimedRun | null> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("agentRuns").selectAll()
      .where("id", "=", runId)
      .where("isolationProvider", "=", isolationProvider)
      .forUpdate().executeTakeFirst();
    if (!run || isTerminalRunStatus(run.status)) return null;
    const now = new Date();
    const recovering = run.status === "running" || run.status === "waiting_for_approval";
    if (
      run.status !== "queued" &&
      !(
        (run.status === "running" || run.status === "waiting_for_approval") &&
        (!run.leaseExpiresAt || new Date(run.leaseExpiresAt) < now)
      )
    ) {
      return null;
    }

    const membership = await trx.selectFrom("organizationMemberships")
      .select("id")
      .where("organizationId", "=", run.organizationId)
      .where("userId", "=", run.initiatedByUserId)
      .executeTakeFirst();
    if (!membership) {
      await transitionRunFailed(trx, run, "principal_revoked", "Run principal is no longer active");
      return null;
    }
    const capability = await trx.selectFrom("agentRunCapabilities")
      .select(["digest", "revokedAt"])
      .where("runId", "=", run.id)
      .executeTakeFirst();
    if (!capability || capability.revokedAt || capability.digest !== run.capabilityDigest) {
      await transitionRunFailed(trx, run, "capability_revoked", "Run capability is unavailable");
      return null;
    }

    const leaseOwner = crypto.randomUUID();
    const lastConversation = recovering
      ? await trx.selectFrom("agentRunEvents")
        .select("payload")
        .where("runId", "=", run.id)
        .where("type", "=", "conversation")
        .orderBy("sequence", "desc")
        .executeTakeFirst()
      : undefined;
    const lastState = (lastConversation?.payload as { state?: unknown } | undefined)?.state;
    const recovery = !recovering || !lastConversation
      ? "new"
      : lastState === "completed"
        ? "completed"
        : lastState === "failed"
          ? "failed"
          : lastState === "canceled"
            ? "canceled"
            : "resume";
    const updated = await trx.updateTable("agentRuns").set({
      status: "running",
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      startedAt: run.startedAt ?? now,
      updatedAt: now
    }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
    const sequence = await appendRunEvent(trx, updated, "run-status", {
      status: "running",
      recovered: recovering
    }, now);
    return { run: updated, leaseOwner, recovery, nextSequence: sequence + 1 };
  });
}

async function completedConversationText(runId: string) {
  const rows = await getDb().selectFrom("agentRunEvents")
    .select("payload")
    .where("runId", "=", runId)
    .where("type", "=", "conversation")
    .orderBy("sequence", "asc")
    .execute();
  let text = "";
  for (const row of rows) {
    const event = row.payload as Partial<ConversationEvent>;
    if (event.kind !== "output" || !Array.isArray(event.messages)) continue;
    for (const message of event.messages) {
      if (message.role === "assistant" && message.content.type === "text") {
        text += message.content.text;
      }
    }
  }
  return text;
}

type InferenceBrokerContext = {
  claimed: ClaimedRun;
  expectedConfiguration: AgentRunConfigurationV1;
  capabilities: AgentRunCapabilitiesV1;
  capabilityToken: string;
  executionSignal: AbortSignal;
  activeExecutionClock: ActiveExecutionClock;
};

const inferenceBrokers = new Map<string, InferenceBrokerContext>();

function startInferenceBroker(
  claimed: ClaimedRun,
  expectedConfiguration: AgentRunConfigurationV1,
  capabilities: AgentRunCapabilitiesV1,
  capabilityToken: string,
  executionSignal: AbortSignal,
  activeExecutionClock: ActiveExecutionClock,
  remoteBaseUrl?: string
): InferenceBroker {
  const context: InferenceBrokerContext = {
    claimed,
    expectedConfiguration,
    capabilities,
    capabilityToken,
    executionSignal,
    activeExecutionClock
  };
  if (remoteBaseUrl) {
    inferenceBrokers.set(claimed.run.id, context);
    return {
      url: `${remoteBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(
        claimed.run.id
      )}/inference`,
      stop() {
        if (inferenceBrokers.get(claimed.run.id) === context) {
          inferenceBrokers.delete(claimed.run.id);
        }
      }
    };
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => inferenceBrokerResponse(context, request)
  });
  return {
    url: `http://127.0.0.1:${server.port}/inference`,
    stop: (closeActiveConnections) => server.stop(closeActiveConnections)
  };
}

export async function handleAgentRunInferenceBroker(
  runId: string,
  request: Request
) {
  const context = inferenceBrokers.get(runId);
  if (!context) return new Response(null, { status: 404 });
  return inferenceBrokerResponse(context, request);
}

async function inferenceBrokerResponse(
  context: InferenceBrokerContext,
  request: Request
) {
  const {
    claimed,
    expectedConfiguration,
    capabilities,
    capabilityToken,
    executionSignal,
    activeExecutionClock
  } = context;
  if (
    request.method !== "POST" ||
    !constantTimeEqual(
      request.headers.get("authorization") ?? "",
      `Bearer ${capabilityToken}`
    )
  ) {
    return new Response(null, { status: 403 });
  }
  const authorized = await isInferenceAuthorized(claimed);
  if (!authorized) return new Response(null, { status: 403 });
  const body = await request.json().catch(() => undefined) as
    | { configurationDigest?: unknown; configuration?: unknown }
    | undefined;
  if (
    body?.configurationDigest !== claimed.run.configurationDigest ||
    await sha256Hex(canonicalJson(body.configuration)) !== claimed.run.configurationDigest ||
    canonicalJson(body.configuration) !== canonicalJson(expectedConfiguration)
  ) {
    return new Response(null, { status: 409 });
  }

  const configuration = parseRunConfiguration(body.configuration);
  const revoked = new AbortController();
  const signal = AbortSignal.any([request.signal, executionSignal, revoked.signal]);
  const stopAuthorizationMonitor = monitorInferenceAuthorization(
    claimed,
    revoked,
    signal
  );
  const generator = streamRunToolLoop(
    claimed,
    configuration,
    capabilities,
    signal,
    activeExecutionClock
  );
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        const iterator = generator[Symbol.asyncIterator]();
        let pending = iterator.next();
        while (true) {
          const next = await nextBrokerEventOrHeartbeat(pending, brokerHeartbeatMs);
          if (next.kind === "heartbeat") {
            controller.enqueue(encoder.encode("\n"));
            continue;
          }
          if (next.result.done) break;
          controller.enqueue(encoder.encode(`${JSON.stringify(next.result.value)}\n`));
          pending = iterator.next();
        }
        controller.close();
      } catch (error) {
        if (!signal.aborted) {
          controller.error(error);
        } else {
          try {
            controller.close();
          } catch {}
        }
      } finally {
        stopAuthorizationMonitor();
      }
    },
    cancel() {
      stopAuthorizationMonitor();
      revoked.abort();
    }
  }), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export function nextBrokerEventOrHeartbeat<T>(
  pending: Promise<IteratorResult<T>>,
  heartbeatMs: number
): Promise<
  | { kind: "event"; result: IteratorResult<T> }
  | { kind: "heartbeat" }
> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "heartbeat" }), heartbeatMs);
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve({ kind: "event", result });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function* streamRunToolLoop(
  claimed: ClaimedRun,
  configuration: AgentRunConfigurationV1,
  capabilities: AgentRunCapabilitiesV1,
  signal: AbortSignal,
  activeExecutionClock: ActiveExecutionClock
) {
  const messages: Parameters<typeof streamLushAgentTurn>[0]["messages"] = [
    ...configuration.messages
  ];
  const toolByName = new Map(capabilities.tools.map((tool) => [tool.name, tool]));
  const tools = capabilities.tools.map((tool) => ({
    name: tool.name,
    description: tool.description || tool.title,
    inputSchema: tool.inputSchema
  }));

  for (let turn = 0; turn < 8; turn += 1) {
    let text = "";
    const calls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }> = [];
    for await (const event of streamLushAgentTurn({
      organizationId: claimed.run.organizationId,
      instructions: configuration.agent.instructions,
      modelSelection: configuration.modelSelection,
      messages,
      tools,
      project: configuration.project,
      signal
    })) {
      if (event.type === "text_delta") text += event.delta;
      else {
        const call = {
          ...event.call,
          id: await scopedToolCallId(
            claimed.run.id,
            turn,
            calls.length,
            event.call.id
          )
        };
        calls.push(call);
        yield { type: "tool_call" as const, call };
        continue;
      }
      yield event;
    }
    if (text) messages.push({ role: "assistant", content: text });
    if (calls.length === 0) return;
    messages.push({ role: "assistant", toolCalls: calls });

    for (const call of calls) {
      const binding = toolByName.get(call.name);
      let attempt: RunToolAttempt = binding
        ? await executeRunTool(claimed, binding, call, signal)
        : { kind: "result", result: {
            callId: call.id,
            name: call.name,
            response: { error: "tool_not_authorized" },
            isError: true
          } };
      if (attempt.kind === "approval") {
        yield {
          type: "tool_approval" as const,
          approval: {
            id: attempt.approvalId,
            toolCallId: call.id,
            toolName: call.name,
            expiresAt: attempt.expiresAt,
            question: `Allow ${call.name} to run?`
          }
        };
        const resumeExecutionClock = activeExecutionClock.pause();
        let decision: "approved" | "denied" | "expired";
        try {
          decision = await waitForToolApproval(
            claimed,
            attempt.approvalId,
            attempt.expiresAt,
            signal
          );
        } finally {
          resumeExecutionClock();
        }
        await markRunApprovalResolved(claimed, call, attempt.approvalId, decision);
        attempt = decision === "approved"
          ? await executeRunTool(claimed, binding!, call, signal)
          : { kind: "result", result: {
              callId: call.id,
              name: call.name,
              response: { error: decision === "denied" ? "approval_denied" : "approval_expired" },
              isError: true
            } };
        if (attempt.kind === "approval") {
          throw new Error("Approved tool call unexpectedly requested approval again");
        }
      }
      const result = attempt.result;
      yield { type: "tool_result" as const, result };
      messages.push({
        role: "tool",
        toolCallId: result.callId,
        name: result.name,
        content: JSON.stringify(result.response),
        isError: result.isError
      });
    }
  }
  throw new Error("Agent exceeded the maximum of 8 model/tool turns");
}

export async function scopedToolCallId(
  runId: string,
  turn: number,
  ordinal: number,
  providerCallId: string
) {
  // Recovery cannot safely re-infer a parked tool turn: providers may return a
  // different id or call order, producing a different gateway idempotency key.
  // Durable parking must replay persisted calls from a checkpoint instead.
  const digest = await sha256Hex(canonicalJson({
    runId,
    turn,
    ordinal,
    providerCallId
  }));
  return `call_${digest.slice(0, 32)}`;
}

type RunToolResult = {
  callId: string;
  name: string;
  response: unknown;
  isError: boolean;
};

type RunToolAttempt =
  | { kind: "result"; result: RunToolResult }
  | { kind: "approval"; approvalId: string; expiresAt: string };

async function executeRunTool(
  claimed: ClaimedRun,
  binding: AgentRunCapabilitiesV1["tools"][number],
  call: { id: string; name: string; arguments: Record<string, unknown> },
  signal: AbortSignal
): Promise<RunToolAttempt> {
  try {
    return await withToolExecutionTimeout(
      (attemptSignal) => executeRunToolAttempt(
        claimed,
        binding,
        call,
        attemptSignal
      ),
      signal,
      binding.timeoutMs ?? agentToolExecutionTimeoutMs
    );
  } catch (error) {
    if (signal.aborted) {
      throw abortReason(signal, "Run was cancelled");
    }
    const timedOut = error instanceof AgentToolTimeoutError;
    logger.warn({
      err: error,
      runId: claimed.run.id,
      toolName: call.name
    }, timedOut ? "agent tool invocation timed out" : "agent tool invocation failed");
    return { kind: "result", result: {
      callId: call.id,
      name: call.name,
      response: timedOut
        ? {
            error: "tool_timeout",
            message: error.message
          }
        : {
            error: error instanceof Error ? error.message : "tool_invocation_failed"
          },
      isError: true
    } };
  }
}

async function executeRunToolAttempt(
  claimed: ClaimedRun,
  binding: AgentRunCapabilitiesV1["tools"][number],
  call: { id: string; name: string; arguments: Record<string, unknown> },
  signal: AbortSignal
): Promise<RunToolAttempt> {
  if (!(await isToolGatewayEnabled(claimed.run.organizationId))) {
    return { kind: "result", result: {
      callId: call.id,
      name: call.name,
      response: { error: "tool_gateway_disabled" },
      isError: true
    } };
  }
  const membership = await getDb().selectFrom("organizationMemberships")
    .select("role")
    .where("organizationId", "=", claimed.run.organizationId)
    .where("userId", "=", claimed.run.initiatedByUserId)
    .executeTakeFirst();
  if (!membership) {
    throw new Error("Run principal is no longer active");
  }
  const outcome = await invokeTool({
    organizationId: claimed.run.organizationId,
    userId: claimed.run.initiatedByUserId,
    role: membership.role
  }, {
    connectionId: binding.connectionId,
    toolName: binding.externalName,
    input: call.arguments,
    expectedDefinitionDigest: binding.definitionDigest,
    idempotencyKey: await sha256Hex(canonicalJson({
      runId: claimed.run.id,
      callId: call.id
    })),
    runId: claimed.run.id
  }, { signal });
  if ("result" in outcome) {
    if (outcome.status === "failed" || outcome.result.isError) {
      logger.warn({
        runId: claimed.run.id,
        toolName: call.name,
        status: outcome.status
      }, "agent tool invocation returned an error");
    }
    if (binding.annotations.openWorld) {
      await getDb().updateTable("agentRuns")
        .set({ untrustedContentIngested: true, updatedAt: new Date() })
        .where("id", "=", claimed.run.id)
        .execute();
    }
    return { kind: "result", result: {
      callId: call.id,
      name: call.name,
      response: outcome.result.structured ?? { content: outcome.result.content },
      isError: outcome.status === "failed" || outcome.result.isError
    } };
  }
  if (outcome.status === "approval_required") {
    logger.info({
      runId: claimed.run.id,
      toolName: call.name
    }, "agent tool invocation requires approval");
    return {
      kind: "approval",
      approvalId: outcome.approval.approvalId,
      expiresAt: outcome.approval.expiresAt
    };
  }
  logger.warn({
    runId: claimed.run.id,
    toolName: call.name,
    status: outcome.status,
    reason: outcome.reason
  }, "agent tool invocation was rejected");
  return { kind: "result", result: {
    callId: call.id,
    name: call.name,
    response: { error: outcome.reason },
    isError: true
  } };
}

export class AgentToolTimeoutError extends Error {
  readonly code = "tool_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Tool execution exceeded ${Math.ceil(timeoutMs / 1_000)} seconds`);
    this.name = "AgentToolTimeoutError";
  }
}

export async function withToolExecutionTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs = agentToolExecutionTimeoutMs
): Promise<T> {
  if (parentSignal.aborted) {
    throw abortReason(parentSignal, "Run was cancelled");
  }
  const timeoutController = new AbortController();
  const attemptSignal = AbortSignal.any([parentSignal, timeoutController.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onParentAbort = () => reject(abortReason(parentSignal, "Run was cancelled"));
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal.aborted) {
      onParentAbort();
      return;
    }
    timer = setTimeout(() => {
      const error = new AgentToolTimeoutError(timeoutMs);
      timeoutController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(attemptSignal), interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

function abortReason(signal: AbortSignal, fallback: string) {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

async function loadRunCapabilities(claimed: ClaimedRun): Promise<AgentRunCapabilitiesV1> {
  const row = await getDb().selectFrom("agentRunCapabilities")
    .select(["snapshot", "digest", "revokedAt"])
    .where("runId", "=", claimed.run.id)
    .executeTakeFirst();
  if (
    !row ||
    row.revokedAt ||
    row.digest !== claimed.run.capabilityDigest ||
    await sha256Hex(canonicalJson(row.snapshot)) !== claimed.run.capabilityDigest
  ) {
    throw new Error("Run capability is unavailable");
  }
  return row.snapshot as AgentRunCapabilitiesV1;
}

function toolErrorText(response: unknown) {
  if (
    response &&
    typeof response === "object" &&
    "message" in response &&
    typeof response.message === "string"
  ) return response.message;
  if (
    response &&
    typeof response === "object" &&
    "error" in response &&
    typeof response.error === "string"
  ) return response.error;
  return "Tool invocation failed";
}

function constantTimeEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes);
}

async function isInferenceAuthorized(claimed: ClaimedRun) {
  const row = await getDb().selectFrom("agentRuns")
    .innerJoin("agentRunCapabilities", "agentRunCapabilities.runId", "agentRuns.id")
    .innerJoin("organizationMemberships", (join) => join
      .onRef("organizationMemberships.organizationId", "=", "agentRuns.organizationId")
      .onRef("organizationMemberships.userId", "=", "agentRuns.initiatedByUserId"))
    .select("agentRuns.id")
    .where("agentRuns.id", "=", claimed.run.id)
    .where("agentRuns.status", "in", ["running", "waiting_for_approval"])
    .where("agentRuns.leaseOwner", "=", claimed.leaseOwner)
    .where("agentRunCapabilities.revokedAt", "is", null)
    .executeTakeFirst();
  return Boolean(row);
}

function monitorInferenceAuthorization(
  claimed: ClaimedRun,
  revoked: AbortController,
  executionSignal: AbortSignal
) {
  const stopped = new AbortController();
  const signal = AbortSignal.any([executionSignal, stopped.signal]);
  void (async () => {
    while (!signal.aborted) {
      await abortableDelay(signal, authorizationPollMs);
      if (signal.aborted) return;
      if (!(await isInferenceAuthorized(claimed)) && !signal.aborted) {
        revoked.abort(new Error("Run authorization was revoked"));
        return;
      }
    }
  })().catch((error) => {
    if (!signal.aborted) revoked.abort(error);
  });
  return () => stopped.abort();
}

function abortableDelay(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function markEnvironmentRunning(claimed: ClaimedRun, backendHandle: string) {
  await getDb().transaction().execute(async (trx) => {
    await requireLeaseForUpdate(trx, claimed);
    await trx.updateTable("agentEnvironments").set({
      status: "running",
      backendHandle,
      leaseExpiresAt: new Date(Date.now() + leaseMs),
      updatedAt: new Date()
    }).where("id", "=", claimed.run.environmentId).execute();
  });
}

async function appendPublicEvent(claimed: ClaimedRun, type: string, payload: unknown) {
  return appendClaimedEvent(claimed, type, payload);
}

async function markRunWaitingForApproval(claimed: ClaimedRun, approvalId: string) {
  const sequence = claimed.nextSequence;
  const appended = await getDb().transaction().execute(async (trx) => {
    const run = await requireLeaseForUpdate(trx, claimed);
    if (run.status === "waiting_for_approval") return sequence - 1;
    const now = new Date();
    const updated = await trx.updateTable("agentRuns").set({
      status: "waiting_for_approval",
      updatedAt: now
    }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
    return appendRunEvent(trx, updated, "run-status", {
      status: "waiting_for_approval",
      approvalId
    }, now, undefined, sequence);
  });
  claimed.nextSequence = appended + 1;
}

async function waitForToolApproval(
  claimed: ClaimedRun,
  approvalId: string,
  expiresAt: string,
  signal: AbortSignal
): Promise<"approved" | "denied" | "expired"> {
  const deadline = new Date(expiresAt).getTime();
  while (!signal.aborted) {
    const [run, approval] = await Promise.all([
      getDb().selectFrom("agentRuns").select("status")
        .where("id", "=", claimed.run.id).executeTakeFirst(),
      getDb().selectFrom("toolApprovals").select(["status", "toolCallId"])
        .where("id", "=", approvalId)
        .where("runId", "=", claimed.run.id)
        .where("initiatedByUserId", "=", claimed.run.initiatedByUserId)
        .executeTakeFirst()
    ]);
    if (!approval) throw new Error("Tool approval is unavailable");
    if (run?.status === "waiting_for_approval") {
      if (approval.status === "approved" || approval.status === "denied") {
        return approval.status;
      }
      if (approval.status === "expired") return "expired";
      if (Date.now() >= deadline) {
        const expired = await expirePendingToolApproval(approvalId, approval.toolCallId);
        if (expired) return "expired";
      }
    }
    await abortableDelay(signal, authorizationPollMs);
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("Run was cancelled");
}

async function expirePendingToolApproval(approvalId: string, toolCallId: string | null) {
  return getDb().transaction().execute(async (trx) => {
    const now = new Date();
    const approval = await trx.updateTable("toolApprovals").set({
      status: "expired",
      decidedAt: now
    }).where("id", "=", approvalId)
      .where("status", "=", "pending")
      .returning("id").executeTakeFirst();
    if (!approval) return false;
    if (toolCallId) {
      await trx.updateTable("toolCalls").set({
        status: "cancelled",
        completedAt: now
      }).where("id", "=", toolCallId)
        .where("status", "=", "waiting_for_approval").execute();
    }
    return true;
  });
}

async function markRunApprovalResolved(
  claimed: ClaimedRun,
  call: { id: string; name: string },
  approvalId: string,
  decision: "approved" | "denied" | "expired"
) {
  const sequence = claimed.nextSequence;
  const last = await getDb().transaction().execute(async (trx) => {
    const run = await requireLeaseForUpdate(trx, claimed);
    const now = new Date();
    const updated = await trx.updateTable("agentRuns").set({
      status: "running",
      updatedAt: now
    }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
    const resolved = await appendRunEvent(trx, updated, "tool-approval-resolved", {
      approvalId,
      toolCallId: call.id,
      toolName: call.name,
      decision
    }, now, undefined, sequence);
    return appendRunEvent(trx, updated, "run-status", {
      status: "running",
      approvalId
    }, now, claimed.leaseOwner, resolved + 1);
  });
  claimed.nextSequence = last + 1;
}

async function appendClaimedEvent(
  claimed: ClaimedRun,
  type: string,
  payload: unknown
) {
  const sequence = claimed.nextSequence;
  const appended = await getDb().transaction().execute((trx) =>
    appendRunEvent(
      trx,
      claimed.run,
      type,
      payload,
      new Date(),
      claimed.leaseOwner,
      sequence
    )
  );
  claimed.nextSequence = appended + 1;
  return appended;
}

async function completeRun(claimed: ClaimedRun, assistantText: string) {
  return getDb().transaction().execute(async (trx) => {
    const run = await requireLeaseForUpdate(trx, claimed);
    const now = new Date();
    const message = await insertAssistantMessage(trx, run, assistantText, now);
    const updated = await trx.updateTable("agentRuns").set({
      status: "completed",
      assistantMessageId: message.id,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: now
    }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
    await closeEnvironmentAndSession(trx, updated, now, "destroyed");
    await trx.updateTable("agentRunCapabilities").set({ revokedAt: now })
      .where("runId", "=", run.id).execute();
    await appendRunEvent(trx, updated, "run-status", { status: "completed" }, now);
    await appendRunEvent(trx, updated, "response-complete", {
      assistantMessageId: message.id
    }, now);
    await insertAudit(trx, updated, "agent.run_completed", {
      assistantMessageId: message.id
    });
    return message.id;
  });
}

async function failRun(claimed: ClaimedRun, error: unknown, assistantText: string) {
  await getDb().transaction().execute(async (trx) => {
    const run = await requireLeaseForUpdate(trx, claimed);
    const now = new Date();
    const message = assistantText
      ? await insertAssistantMessage(trx, run, assistantText, now)
      : undefined;
    const code = errorCode(error);
    const messageText = error instanceof Error ? error.message : "Agent run failed";
    const updated = await trx.updateTable("agentRuns").set({
      status: "failed",
      assistantMessageId: message?.id ?? null,
      errorCode: code,
      errorMessage: messageText,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
      completedAt: now
    }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
    await closeEnvironmentAndSession(trx, updated, now, "failed");
    await trx.updateTable("agentRunCapabilities").set({ revokedAt: now })
      .where("runId", "=", run.id).execute();
    await appendRunEvent(trx, updated, "response-error", {
      code,
      message: messageText
    }, now);
    await appendRunEvent(trx, updated, "run-status", { status: "failed" }, now);
    await insertAudit(trx, updated, "agent.run_failed", { code });
  });
}

async function persistPartialAssistant(run: AgentRunRow, assistantText: string) {
  if (!assistantText) return;
  await getDb().transaction().execute(async (trx) => {
    const current = await trx.selectFrom("agentRuns").selectAll()
      .where("id", "=", run.id).forUpdate().executeTakeFirst();
    if (!current || current.assistantMessageId || current.status !== "cancelled") return;
    const message = await insertAssistantMessage(trx, current, assistantText, new Date());
    await trx.updateTable("agentRuns").set({ assistantMessageId: message.id })
      .where("id", "=", current.id).execute();
    await appendRunEvent(trx, current, "response-complete", {
      assistantMessageId: message.id,
      partial: true
    });
  });
}

async function insertAssistantMessage(
  trx: Transaction<Database>,
  run: AgentRunRow,
  content: string,
  now: Date
) {
  const metadata = await runMessageMetadata(trx, run.id, content);
  const byteSize = messageByteSize(content, metadata);
  const thread = await trx.selectFrom("sessionThreads").selectAll()
    .where("id", "=", run.sessionId).forUpdate().executeTakeFirstOrThrow();
  const message = await trx.insertInto("sessionMessages").values({
    threadId: run.sessionId,
    organizationId: run.organizationId,
    authorUserId: null,
    role: "assistant",
    content,
    metadata,
    tokenCount: null,
    byteSize,
    createdAt: now
  }).returningAll().executeTakeFirstOrThrow();
  await trx.updateTable("sessionThreads").set({
    stateBytes: thread.stateBytes + byteSize,
    version: thread.version + 1,
    updatedAt: now
  }).where("id", "=", thread.id).execute();
  return message;
}

async function runMessageMetadata(
  trx: Transaction<Database>,
  runId: string,
  content: string
) {
  const rows = await trx.selectFrom("agentRunEvents")
    .select(["type", "payload"])
    .where("runId", "=", runId)
    .where("type", "in", [
      "response-reset",
      "text-delta",
      "tool-input",
      "tool-output",
      "tool-approval-required",
      "tool-approval-resolved"
    ])
    .orderBy("sequence", "asc")
    .execute();
  const parts: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const payload = recordValue(row.payload);
    if (row.type === "response-reset") {
      parts.length = 0;
      continue;
    }
    if (row.type === "text-delta" && typeof payload.delta === "string") {
      const prior = parts[parts.length - 1];
      if (prior?.type === "text" && typeof prior.length === "number") {
        prior.length += payload.delta.length;
      } else {
        parts.push({ type: "text", length: payload.delta.length });
      }
      continue;
    }
    if (
      row.type === "tool-input" &&
      typeof payload.toolCallId === "string" &&
      typeof payload.toolName === "string"
    ) {
      parts.push({
        type: "tool",
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        ...toolPresentationFromPayload(payload),
        state: "input-available",
        input: payload.input
      });
      continue;
    }
    const toolCallId = typeof payload.toolCallId === "string"
      ? payload.toolCallId
      : undefined;
    const index = toolCallId ? lastToolMetadataIndex(parts, toolCallId) : -1;
    if (index < 0) continue;
    const tool = parts[index]!;
    if (
      row.type === "tool-approval-required" &&
      typeof payload.approvalId === "string" &&
      typeof payload.expiresAt === "string"
    ) {
      Object.assign(tool, {
        state: "approval-requested",
        approvalId: payload.approvalId,
        approvalExpiresAt: payload.expiresAt
      });
    } else if (
      row.type === "tool-approval-resolved" &&
      (payload.decision === "approved" ||
        payload.decision === "denied" ||
        payload.decision === "expired")
    ) {
      Object.assign(tool, {
        state: payload.decision === "approved"
          ? "approval-responded"
          : payload.decision === "denied"
            ? "output-denied"
            : "output-error",
        approvalDecision: payload.decision
      });
    } else if (row.type === "tool-output") {
      const errorText = typeof payload.errorText === "string" ? payload.errorText : undefined;
      Object.assign(tool, {
        state: errorText === "approval_denied"
          ? "output-denied"
          : errorText
            ? "output-error"
            : "output-available",
        output: payload.output,
        errorText
      });
    }
  }
  const textLength = parts.reduce(
    (total, part) => total + (part.type === "text" && typeof part.length === "number"
      ? part.length
      : 0),
    0
  );
  if (textLength !== content.length) {
    return {
      schema: "lush.message.parts.v1",
      runId,
      parts: [{ type: "text", length: content.length }]
    };
  }
  return { schema: "lush.message.parts.v1", runId, parts };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function lastToolMetadataIndex(
  parts: Array<Record<string, unknown>>,
  toolCallId: string
) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part?.type === "tool" && part.toolCallId === toolCallId) return index;
  }
  return -1;
}

function toolPresentationFromPayload(payload: Record<string, unknown>) {
  return {
    ...(typeof payload.toolTitle === "string"
      ? { toolTitle: payload.toolTitle }
      : {}),
    ...(typeof payload.connectionLabel === "string"
      ? { connectionLabel: payload.connectionLabel }
      : {}),
    ...(payload.connectionSource === "mcp" ||
      payload.connectionSource === "openapi" ||
      payload.connectionSource === "native"
      ? { connectionSource: payload.connectionSource }
      : {}),
    ...(typeof payload.connectionIconUrl === "string"
      ? { connectionIconUrl: payload.connectionIconUrl }
      : {})
  };
}

async function closeEnvironmentAndSession(
  trx: Transaction<Database>,
  run: AgentRunRow,
  now: Date,
  environmentStatus: "destroyed" | "failed"
) {
  await trx.updateTable("agentEnvironments").set({
    status: environmentStatus,
    leaseExpiresAt: null,
    updatedAt: now,
    destroyedAt: environmentStatus === "destroyed" ? now : null
  }).where("id", "=", run.environmentId).execute();
  await trx.updateTable("sessionThreads").set({ currentRunId: null })
    .where("id", "=", run.sessionId)
    .where("currentRunId", "=", run.id).execute();
}

async function transitionRunFailed(
  trx: Transaction<Database>,
  run: AgentRunRow,
  code: string,
  message: string
) {
  const now = new Date();
  const updated = await trx.updateTable("agentRuns").set({
    status: "failed",
    errorCode: code,
    errorMessage: message,
    updatedAt: now,
    completedAt: now,
    leaseOwner: null,
    leaseExpiresAt: null
  }).where("id", "=", run.id).returningAll().executeTakeFirstOrThrow();
  await closeEnvironmentAndSession(trx, updated, now, "failed");
  await trx.updateTable("agentRunCapabilities").set({ revokedAt: now })
    .where("runId", "=", run.id).execute();
  await appendRunEvent(trx, updated, "response-error", { code, message }, now);
  await appendRunEvent(trx, updated, "run-status", { status: "failed" }, now);
}

async function requireLeaseForUpdate(trx: Transaction<Database>, claimed: ClaimedRun) {
  const run = await trx.selectFrom("agentRuns").selectAll()
    .where("id", "=", claimed.run.id)
    .where("status", "in", ["running", "waiting_for_approval"])
    .where("leaseOwner", "=", claimed.leaseOwner)
    .forUpdate().executeTakeFirst();
  if (!run) throw new AgentRunError("run_lease_lost", "Run execution lease was lost", 409);
  return run;
}

function maintainLease(claimed: ClaimedRun, controller: AbortController) {
  const timer = setInterval(() => {
    void renewLease(claimed).then((renewed) => {
      if (!renewed) controller.abort();
    }).catch(() => controller.abort());
  }, leaseRenewMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function renewLease(claimed: ClaimedRun) {
  const expiresAt = new Date(Date.now() + leaseMs);
  return getDb().transaction().execute(async (trx) => {
    const result = await trx.updateTable("agentRuns").set({
      leaseExpiresAt: expiresAt,
      updatedAt: new Date()
    }).where("id", "=", claimed.run.id)
      .where("status", "in", ["running", "waiting_for_approval"])
      .where("leaseOwner", "=", claimed.leaseOwner)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) return false;
    await trx.updateTable("agentEnvironments").set({
      leaseExpiresAt: expiresAt,
      updatedAt: new Date()
    }).where("id", "=", claimed.run.environmentId)
      .where("status", "=", "running")
      .execute();
    return true;
  });
}

async function generateInternalTitle(
  run: AgentRunRow,
  configuration: AgentRunConfigurationV1,
  assistantText: string
) {
  const existingCount = configuration.messages.length;
  if (existingCount !== 1 || !assistantText.trim()) return;
  await appendInternalTaskEvent(run, "running");
  try {
    const membership = await getDb().selectFrom("organizationMemberships")
      .select("id")
      .where("organizationId", "=", run.organizationId)
      .where("userId", "=", run.initiatedByUserId)
      .executeTakeFirst();
    if (!membership) throw new Error("Run principal is no longer active");
    const userText = configuration.messages[0]?.content ?? "";
    const prompt = [
      "Write a concise title for this chat session.",
      "Use 3 to 6 words.",
      "Return only the title. Do not wrap it in quotes.",
      "",
      `User: ${userText.slice(0, 2_000)}`,
      `Assistant: ${assistantText.slice(0, 4_000)}`
    ].join("\n");
    let generated = "";
    for await (const delta of streamLushAgentChat({
      organizationId: run.organizationId,
      modelSelection: run.modelSelection,
      messages: [{ role: "user", content: prompt }],
      signal: AbortSignal.timeout(30_000)
    })) {
      generated += delta;
      if (generated.length > 200) break;
    }
    const title = titleFromContent(
      generated.replace(/^title\s*:\s*/i, "").replace(/^["']|["']$/g, "")
    );
    if (title && title !== "Untitled session") {
      await getDb().updateTable("sessionThreads").set({
        title,
        updatedAt: new Date()
      }).where("id", "=", run.sessionId).execute();
    }
    await appendInternalTaskEvent(run, "completed", { title });
  } catch (error) {
    await appendInternalTaskEvent(run, "failed", {
      code: errorCode(error),
      message: error instanceof Error ? error.message : "Title task failed"
    });
    throw error;
  }
}

function appendInternalTaskEvent(
  run: AgentRunRow,
  status: "running" | "completed" | "failed",
  detail: Record<string, unknown> = {}
) {
  return getDb().transaction().execute((trx) => appendRunEvent(
    trx,
    run,
    "internal-task",
    { purpose: "title", status, ...detail }
  ));
}

function limitsFromRun(run: AgentRunRow) {
  const value = run.limits as { wallClockMs?: unknown; maxOutputBytes?: unknown };
  return {
    wallClockMs: typeof value?.wallClockMs === "number" ? value.wallClockMs : 120_000,
    maxOutputBytes:
      typeof value?.maxOutputBytes === "number" ? value.maxOutputBytes : 8_000_000
  };
}

function originText(configuration: AgentRunConfigurationV1) {
  return configuration.messages[configuration.messages.length - 1]?.content ?? "";
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "agent_run_failed";
}

async function insertAudit(
  trx: Transaction<Database>,
  run: AgentRunRow,
  action: string,
  metadata: unknown
) {
  await trx.insertInto("auditEvents").values({
    organizationId: run.organizationId,
    userId: run.initiatedByUserId,
    sessionId: null,
    action,
    targetType: "agent_run",
    targetId: run.id,
    metadata,
    createdAt: new Date()
  }).execute();
}
