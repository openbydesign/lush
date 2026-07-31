/**
 * In-memory implementation of the AX-aligned durable event log, plus small
 * registry/lock helpers used by the orchestrator.
 *
 * The in-memory log is authoritative for tests and the in-process development
 * path. A Postgres-backed log implementing the same `EventLog` interface is the
 * durable production projection (plan table `agent_run_events`); nothing above
 * this interface depends on the storage backend.
 */

import type {
  AppendConversationEvent,
  ConversationEvent,
  EventLog
} from "./protocol";

/**
 * In-memory event log for tests and the reference orchestrator path.
 *
 * NOTE for the durable (Postgres) implementation: `append` here computes
 * `MAX(step)+1` and pushes as a read-modify-write, which is safe only because
 * the orchestrator serializes appends per conversation via `InFlightRegistry`.
 * That guard is in-process; a durable, multi-replica implementation MUST assign
 * `step` atomically (a per-conversation sequence, a `UNIQUE(conversation_id,
 * step)` with insert-retry, or `INSERT ... SELECT coalesce(max(step),0)+1` under
 * a suitable lock) and pair with a durable single-writer lock.
 */
export class InMemoryEventLog implements EventLog {
  private readonly byConversation = new Map<string, ConversationEvent[]>();

  async append(event: AppendConversationEvent): Promise<number> {
    const existing = this.byConversation.get(event.conversationId) ?? [];
    const step = existing.reduce((max, entry) => Math.max(max, entry.step), 0) + 1;
    existing.push({ ...event, step });
    this.byConversation.set(event.conversationId, existing);
    return step;
  }

  async events(conversationId: string): Promise<ConversationEvent[]> {
    // Return copies ordered by step so callers cannot mutate the log.
    return [...(this.byConversation.get(conversationId) ?? [])]
      .sort((a, b) => a.step - b.step)
      .map((event) => ({ ...event }));
  }

  async deleteAll(conversationId: string): Promise<void> {
    this.byConversation.delete(conversationId);
  }
}

/**
 * Enforces AX's single-writer invariant: at most one in-flight execution per
 * conversation id. `acquire` returns a release function or throws if busy.
 */
export class InFlightRegistry {
  private readonly active = new Set<string>();

  acquire(conversationId: string): () => void {
    if (this.active.has(conversationId)) {
      throw new ConversationBusyError(conversationId);
    }
    this.active.add(conversationId);
    return () => {
      this.active.delete(conversationId);
    };
  }

  isActive(conversationId: string): boolean {
    return this.active.has(conversationId);
  }
}

export class ConversationBusyError extends Error {
  readonly code = "conversation_in_flight";
  constructor(readonly conversationId: string) {
    super(`Conversation ${conversationId} already has an execution in flight`);
    this.name = "ConversationBusyError";
  }
}
