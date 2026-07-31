/**
 * AX-aligned orchestrator <-> runtime protocol contracts.
 *
 * Modeled on Google Agent Executor (https://github.com/google/ax):
 * - `Harness` mirrors `HarnessService.Connect` (the runtime seam a sandbox
 *   implements): one `HarnessStart` in, a stream of `HarnessResponse` out that
 *   is zero or more `outputs` frames terminated by exactly one `end` frame.
 * - `ExecRequest`/`ExecResponse` mirror `ExecutionService.Exec` (the client
 *   seam the orchestrator serves).
 * - `ConversationEvent`/`EventLog` mirror AX's append-only, per-conversation,
 *   monotonic-`step` durable log from which resumption state is derived.
 *
 * These TypeScript interfaces are the portable decision; a real AX deployment,
 * an in-process harness, or a gVisor/microVM harness are interchangeable
 * implementations.
 */

import type { Message } from "./content";

/** AX `State`. `pending` marks an in-flight/unfinished turn. */
export type State = "pending" | "completed" | "failed" | "canceled";

/** AX `CancelReason`. */
export type CancelReason = "user_requested" | "timeout" | "internal_error";

export type HarnessError = { code: number; description: string };

/** AX `HarnessStart`: opaque per-execution config plus the new turn inputs. */
export type HarnessStart = {
  harnessConfig?: unknown;
  messages: Message[];
};

/** AX `HarnessResponse`: `outputs` frames then exactly one `end` frame. */
export type HarnessResponse =
  | { type: "outputs"; messages: Message[] }
  | { type: "end"; state: State; error?: HarnessError };

/**
 * The runtime seam. Mirrors AX `rpc Connect(stream HarnessRequest) returns
 * (stream HarnessResponse)`. An implementation must terminate the stream with an
 * `end` frame; a stream that ends without one is a protocol error (enforced by
 * the orchestrator). Cancellation is delivered via the `AbortSignal`.
 */
export interface Harness {
  readonly id: string;
  connect(request: HarnessStart, signal: AbortSignal): AsyncIterable<HarnessResponse>;
}

// --- durable event log -----------------------------------------------------

/**
 * The role an event plays in a turn. AX derives this from content + state; Lush
 * records it explicitly so replay, referential integrity, and impact analysis
 * stay tractable (per the plan's preference for normalized over opaque JSON).
 */
export type ConversationEventKind = "input" | "output" | "completion";

/** AX `ConversationEvent`: one atomic, replayable step. */
export type ConversationEvent = {
  conversationId: string;
  step: number;
  execId: string;
  harnessId: string;
  kind: ConversationEventKind;
  harnessConfig?: unknown;
  messages: Message[];
  state: State;
  error?: HarnessError;
};

/** An event to append; `step` is assigned by the log. */
export type AppendConversationEvent = Omit<ConversationEvent, "step">;

/**
 * Append-only, per-conversation log. `append` assigns and returns a monotonic,
 * 1-based `step`. Replaying `events` in order reconstructs execution state.
 */
export interface EventLog {
  append(event: AppendConversationEvent): Promise<number>;
  events(conversationId: string): Promise<ConversationEvent[]>;
  deleteAll(conversationId: string): Promise<void>;
}

/** Derived resumption view of a conversation. */
export type ResumptionState = {
  /** Current state = the last event's state, or null when empty. */
  currentState: State | null;
  /** The harness this conversation is bound to (sticky), or null when empty. */
  boundHarnessId: string | null;
  /** Highest assigned step; 0 when empty. */
  lastStep: number;
  /** True when the last turn did not finish (`pending` tail) and must be re-run. */
  needsResume: boolean;
};

/**
 * Derive resumption state by scanning the log. Mirrors AX's controller: the last
 * non-empty state is current; the first bound harness id is sticky; a `pending`
 * tail means the previous turn was interrupted.
 */
export function resumptionState(events: ConversationEvent[]): ResumptionState {
  if (events.length === 0) {
    return { currentState: null, boundHarnessId: null, lastStep: 0, needsResume: false };
  }
  let boundHarnessId: string | null = null;
  let lastStep = 0;
  for (const event of events) {
    if (!boundHarnessId && event.harnessId) {
      boundHarnessId = event.harnessId;
    }
    if (event.step > lastStep) {
      lastStep = event.step;
    }
  }
  const currentState = events[events.length - 1]!.state;
  return {
    currentState,
    boundHarnessId,
    lastStep,
    needsResume: currentState === "pending"
  };
}

// --- client seam (ExecutionService.Exec) -----------------------------------

/** AX `ExecRequest`. An existing `conversationId` is resumed. */
export type ExecRequest = {
  conversationId: string;
  inputs: Message[];
  /** Replay events after this step to catch a reconnecting client up. */
  lastStep?: number;
  /** Empty selects the registry default; sticky once bound. */
  harnessId?: string;
  harnessConfig?: unknown;
};

/** AX `ExecResponse`: a frame of outputs and the step they were recorded at. */
export type ExecResponse = { outputs: Message[]; step: number };
