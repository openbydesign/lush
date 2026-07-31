/**
 * The AX controller, in TypeScript.
 *
 * `runExec` is the client-facing `ExecutionService.Exec` loop: it enforces the
 * single-writer invariant, resolves and pins the harness, appends the durable
 * `ConversationEvent` log, drives one harness turn, and streams
 * `ExecResponse{outputs, step}` frames. Resumption, `lastStep` catch-up, and
 * cancellation follow AX semantics.
 *
 * Authorization, capability resolution, and policy are deliberately NOT here —
 * the orchestrator runs a harness; the control plane decides what may run.
 */

import type { Message } from "./content";
import {
  type ConversationEvent,
  type EventLog,
  type ExecRequest,
  type ExecResponse,
  type Harness,
  type HarnessError,
  type ResumptionState,
  type State,
  resumptionState
} from "./protocol";
import { InFlightRegistry } from "./event-log";

export class HarnessResolutionError extends Error {
  readonly code = "harness_resolution_failed";
  constructor(message: string) {
    super(message);
    this.name = "HarnessResolutionError";
  }
}

export class HarnessProtocolError extends Error {
  readonly code = "harness_protocol_error";
  constructor(message: string) {
    super(message);
    this.name = "HarnessProtocolError";
  }
}

export class HarnessExecutionError extends Error {
  readonly code = "harness_execution_failed";
  constructor(
    message: string,
    readonly harnessError?: HarnessError
  ) {
    super(message);
    this.name = "HarnessExecutionError";
  }
}

export type RunExecOptions = {
  request: ExecRequest;
  log: EventLog;
  /**
   * The harness to drive, already resolved by the caller from the run's
   * environment (`provider.provision(spec).harness()`). The orchestrator does
   * not resolve providers; it only enforces sticky binding across a conversation.
   */
  harness: Harness;
  inFlight: InFlightRegistry;
  signal: AbortSignal;
  /** Execution id for this turn; generated when omitted. */
  execId?: string;
};

export async function* runExec(
  options: RunExecOptions
): AsyncGenerator<ExecResponse> {
  const { request, log, harness, inFlight, signal } = options;
  const conversationId = request.conversationId;
  if (!conversationId) {
    throw new HarnessResolutionError("conversationId is required");
  }

  // Single-writer per conversation (AX FailedPrecondition on a second Exec).
  const release = inFlight.acquire(conversationId);
  try {
    const prior = await log.events(conversationId);
    const resume = resumptionState(prior);

    assertHarnessBinding(harness, resume.boundHarnessId, request.harnessId);
    const execId = options.execId ?? crypto.randomUUID();

    // Catch a reconnecting client up on output frames it missed. Only replay
    // outputs from turns that completed: an interrupted turn's partial outputs
    // are re-run below, so replaying them too would double-emit.
    if (typeof request.lastStep === "number") {
      const completed = completedExecIds(prior);
      for (const event of prior) {
        if (
          event.step > request.lastStep &&
          event.kind === "output" &&
          completed.has(event.execId)
        ) {
          yield { outputs: event.messages, step: event.step };
        }
      }
    }

    const turnInputs = await resolveTurnInputs(request, prior, resume, {
      log,
      conversationId,
      execId,
      harnessId: harness.id
    });
    if (!turnInputs) {
      // Nothing to do: no new inputs and no interrupted turn to resume.
      return;
    }

    yield* drive({
      harness,
      log,
      conversationId,
      execId,
      signal,
      harnessConfig: request.harnessConfig,
      messages: turnInputs
    });
  } finally {
    release();
  }
}

/** Exec ids that reached a terminal completion event. */
function completedExecIds(events: ConversationEvent[]): Set<string> {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.kind === "completion") {
      completed.add(event.execId);
    }
  }
  return completed;
}

function assertHarnessBinding(
  harness: Harness,
  boundHarnessId: string | null,
  requestedHarnessId: string | undefined
): void {
  // Harness binding is sticky: resuming a conversation with a different harness
  // than the one it is bound to is rejected.
  if (boundHarnessId && boundHarnessId !== harness.id) {
    throw new HarnessResolutionError(
      `resumption not allowed: harness id changed from ${boundHarnessId} to ${harness.id}`
    );
  }
  // The provided harness must match the client-requested id when one is given.
  if (requestedHarnessId && requestedHarnessId !== harness.id) {
    throw new HarnessResolutionError(
      `requested harness ${requestedHarnessId} does not match provided harness ${harness.id}`
    );
  }
}

async function resolveTurnInputs(
  request: ExecRequest,
  prior: ConversationEvent[],
  resume: ResumptionState,
  ctx: { log: EventLog; conversationId: string; execId: string; harnessId: string }
): Promise<Message[] | null> {
  if (request.inputs.length > 0) {
    // New turn: record the inputs as a pending input event before running.
    await ctx.log.append({
      conversationId: ctx.conversationId,
      execId: ctx.execId,
      harnessId: ctx.harnessId,
      kind: "input",
      harnessConfig: request.harnessConfig,
      messages: request.inputs,
      state: "pending"
    });
    return request.inputs;
  }

  if (resume.needsResume) {
    // Close the interrupted turn as canceled before re-running, so its partial
    // outputs are superseded in the log rather than duplicated by the re-run.
    const reversed = [...prior].reverse();
    const interruptedExecId = reversed.find((event) => event.state === "pending")?.execId;
    if (interruptedExecId && interruptedExecId !== ctx.execId) {
      await ctx.log.append({
        conversationId: ctx.conversationId,
        execId: interruptedExecId,
        harnessId: ctx.harnessId,
        kind: "completion",
        messages: [],
        state: "canceled"
      });
    }

    // Re-run the interrupted turn's inputs under the new exec id.
    const lastInput = reversed.find((event) => event.kind === "input");
    const messages = lastInput?.messages ?? [];
    await ctx.log.append({
      conversationId: ctx.conversationId,
      execId: ctx.execId,
      harnessId: ctx.harnessId,
      kind: "input",
      messages,
      state: "pending"
    });
    return messages;
  }

  return null;
}

type DriveOptions = {
  harness: Harness;
  log: EventLog;
  conversationId: string;
  execId: string;
  signal: AbortSignal;
  harnessConfig: unknown;
  messages: Message[];
};

/** gRPC INTERNAL — used for harness-side failures without a specific code. */
const INTERNAL_CODE = 13;

async function* drive(options: DriveOptions): AsyncGenerator<ExecResponse> {
  const { harness, log, conversationId, execId, signal } = options;
  let completionWritten = false;

  const writeCompletion = async (state: State, error?: HarnessError) => {
    if (completionWritten) {
      return;
    }
    completionWritten = true;
    await log.append({
      conversationId,
      execId,
      harnessId: harness.id,
      kind: "completion",
      messages: [],
      state,
      error
    });
  };

  try {
    for await (const response of harness.connect(
      { harnessConfig: options.harnessConfig, messages: options.messages },
      signal
    )) {
      if (response.type === "outputs") {
        const step = await log.append({
          conversationId,
          execId,
          harnessId: harness.id,
          kind: "output",
          messages: response.messages,
          state: "pending"
        });
        yield { outputs: response.messages, step };
        continue;
      }

      // Terminal end frame.
      await writeCompletion(response.state, response.error);
      if (response.state === "failed") {
        throw new HarnessExecutionError(
          response.error?.description ?? "harness execution failed",
          response.error
        );
      }
      return;
    }

    // Stream closed without an End frame (AX: this is a protocol error).
    await writeCompletion("failed", {
      code: INTERNAL_CODE,
      description: "harness stream ended without end frame"
    });
    throw new HarnessProtocolError("harness stream ended without end frame");
  } catch (error) {
    if (!completionWritten) {
      // The stream threw before completing. Classify by cause: an aborted signal
      // is a cancellation; anything else is a failure. The typed error's code is
      // preserved so timeout/output-limit reasons survive in the log.
      const state: State = signal.aborted ? "canceled" : "failed";
      await writeCompletion(state, harnessErrorFrom(error));
      if (state === "canceled") {
        return;
      }
    }
    throw error;
  } finally {
    // The consumer abandoned iteration (e.g. `break` in a `for await`, which
    // calls .return()) without an abort or a thrown error. Close the turn so it
    // is never left dangling as a resumable `pending`.
    if (!completionWritten) {
      await writeCompletion("canceled");
    }
  }
}

function harnessErrorFrom(error: unknown): HarnessError {
  if (error instanceof HarnessExecutionError && error.harnessError) {
    return error.harnessError;
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: INTERNAL_CODE,
      description: typeof code === "string" ? `${code}: ${message}` : message
    };
  }
  return {
    code: INTERNAL_CODE,
    description: error instanceof Error ? error.message : "harness execution failed"
  };
}
