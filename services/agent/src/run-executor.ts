import { timingSafeEqual } from "node:crypto";
import { getDb } from "@lush/db/client";
import type { AgentRunRow, Database } from "@lush/db/schema";
import { createLogger } from "@lush/logging/logger";
import { messageByteSize, titleFromContent } from "@lush/sessions/runtime";
import { canonicalJson, sha256Hex } from "@lush/tools/digest";
import type { Transaction } from "kysely";
import { textMessage, type Message } from "./harness/content";
import type { EventLog, ConversationEvent } from "./harness/protocol";
import { runExec } from "./harness/orchestrator";
import { InFlightRegistry } from "./harness/event-log";
import { SubprocessIsolationProvider } from "./harness/subprocess";
import {
  AgentRunError,
  appendRunEvent,
  isTerminalRunStatus,
  parseRunConfiguration,
  registerLocalRun,
  type AgentRunConfigurationV1
} from "./runs";
import { streamLushAgentChat } from "./runtime";

const logger = createLogger("@lush/agent-runs");
const leaseMs = 150_000;
const leaseRenewMs = 30_000;
const authorizationPollMs = 250;
const executions = new Map<string, Promise<void>>();
const inFlight = new InFlightRegistry();
type LocalBroker = { port: number; stop(closeActiveConnections?: boolean): void };

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
  const now = new Date();
  const rows = await getDb().selectFrom("agentRuns")
    .select("id")
    .where((eb) => eb.or([
      eb("status", "=", "queued"),
      eb.and([
        eb("status", "=", "running"),
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
  const claimed = await claimRun(runId);
  if (!claimed) return;

  const configuration = parseRunConfiguration(claimed.run.configuration);
  const controller = new AbortController();
  const unregister = registerLocalRun(runId, controller);
  const stopLease = maintainLease(claimed, controller);
  let provider: SubprocessIsolationProvider | undefined;
  let environment: Awaited<ReturnType<SubprocessIsolationProvider["provision"]>> | undefined;
  let broker: LocalBroker | undefined;
  let assistantText = "";

  try {
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
    broker = startInferenceBroker(claimed, configuration, capabilityToken, controller.signal);
    provider = new SubprocessIsolationProvider();
    environment = await provider.provision({
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
          brokerUrl: `http://127.0.0.1:${broker.port}/inference`,
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

async function claimRun(runId: string): Promise<ClaimedRun | null> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("agentRuns").selectAll()
      .where("id", "=", runId).forUpdate().executeTakeFirst();
    if (!run || isTerminalRunStatus(run.status)) return null;
    const now = new Date();
    const recovering = run.status === "running";
    if (
      run.status !== "queued" &&
      !(run.status === "running" && (!run.leaseExpiresAt || new Date(run.leaseExpiresAt) < now))
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

function startInferenceBroker(
  claimed: ClaimedRun,
  expectedConfiguration: AgentRunConfigurationV1,
  capabilityToken: string,
  executionSignal: AbortSignal
): LocalBroker {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/inference" ||
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
      const generator = streamLushAgentChat({
        organizationId: claimed.run.organizationId,
        instructions: configuration.agent.instructions,
        modelSelection: configuration.modelSelection,
        messages: configuration.messages,
        project: configuration.project,
        signal
      });
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          try {
            for await (const delta of generator) {
              controller.enqueue(encoder.encode(`${JSON.stringify({ delta })}\n`));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
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
  }) as unknown as LocalBroker;
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
    .where("agentRuns.status", "=", "running")
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
  const metadata = {
    schema: "lush.message.parts.v1",
    runId: run.id,
    parts: [{ type: "text", length: content.length }]
  };
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
    .where("status", "=", "running")
    .where("leaseOwner", "=", claimed.leaseOwner)
    .forUpdate().executeTakeFirst();
  if (!run) throw new AgentRunError("run_lease_lost", "Run execution lease was lost", 409);
  return run;
}

async function assertLease(claimed: ClaimedRun) {
  const run = await getDb().selectFrom("agentRuns").select("id")
    .where("id", "=", claimed.run.id)
    .where("status", "=", "running")
    .where("leaseOwner", "=", claimed.leaseOwner)
    .executeTakeFirst();
  if (!run) throw new AgentRunError("run_lease_lost", "Run execution lease was lost", 409);
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
      .where("status", "=", "running")
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
