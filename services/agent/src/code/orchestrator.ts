import path from "node:path";
import type {
  CodeSession,
  CodeSessionDraft,
  CodeSessionSummary,
  HarnessEvent,
  HarnessEventInput,
  HarnessId,
  HarnessInstallation,
  SendCodeInputRequest,
  StartCodeSessionRequest
} from "@lush/code";
import { listAdapters, requireAdapter } from "./adapters";
import { createWorkspace, inspectRepository, readCodeReview, readWorkspaceDiff } from "./git";
import { CodeSessionStore } from "./store";
import type { AdapterRun } from "./adapters/types";
import { runCommand } from "./process";

export class LocalCodeOrchestrator {
  private readonly activeRuns = new Map<string, AdapterRun>();
  private readonly interrupted = new Set<string>();
  private readonly persistence = new Map<string, Promise<void>>();

  constructor(private readonly store: CodeSessionStore) {}

  async listHarnesses() {
    return Promise.all(listAdapters().map((adapter) => adapter.probe()));
  }

  inspectRepository(repositoryPath: string) {
    return inspectRepository(repositoryPath);
  }

  async listSessions(): Promise<CodeSessionSummary[]> {
    const sessions = await this.store.list();
    await Promise.all(sessions.map((session) => this.reconcileSession(session)));
    return sessions
      .filter((session) => !session.archived)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toSummary);
  }

  async getSession(id: string) {
    const session = await this.store.get(id);
    if (!session) throw new CodeNotFoundError(`Code session ${id} was not found`);
    await this.reconcileSession(session);
    return session;
  }

  async startSession(request: StartCodeSessionRequest) {
    validateInput(request.input);
    await validateDraft(request.draft);
    const adapter = requireAdapter(request.draft.harnessId);
    const installation = await adapter.probe();
    if (installation.status !== "installed") {
      throw new Error(installation.detail ?? `${installation.displayName} is unavailable`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = titleFromPrompt(request.input);
    const workspace = await createWorkspace(id, title, request.draft);
    const turnId = crypto.randomUUID();
    const session: CodeSession = {
      id,
      title,
      harnessId: request.draft.harnessId,
      status: "running",
      branch: workspace.branch,
      repositoryName: path.basename(workspace.repositoryRoot),
      createdAt: now,
      updatedAt: now,
      archived: false,
      draft: request.draft,
      effectiveAutonomy: adapter.effectiveAutonomy(request.draft.autonomy),
      workspace,
      messages: [{ id: crypto.randomUUID(), role: "user", content: request.input.trim(), createdAt: now, turnId }],
      events: []
    };

    await this.store.put(session);
    this.runTurn(session, request.input.trim(), turnId, installation);
    return session;
  }

  async sendInput(id: string, request: SendCodeInputRequest) {
    validateInput(request.input);
    const session = await this.getSession(id);
    if (session.status === "running") throw new Error("The session already has an active turn");
    if (!session.binding) throw new Error("The native harness session is unavailable for resume");
    const turnId = crypto.randomUUID();
    session.messages.push({
      id: crypto.randomUUID(),
      role: "user",
      content: request.input.trim(),
      createdAt: new Date().toISOString(),
      turnId
    });
    session.status = "running";
    session.error = undefined;
    session.updatedAt = new Date().toISOString();
    await this.store.put(session);
    this.runTurn(session, request.input.trim(), turnId);
    return session;
  }

  async interrupt(id: string) {
    const session = await this.getSession(id);
    const run = this.activeRuns.get(id);
    if (!run) return session;
    this.interrupted.add(id);
    run.interrupt();
    return session;
  }

  async archive(id: string) {
    const session = await this.getSession(id);
    if (session.status === "running") throw new Error("Interrupt the active turn before archiving");
    session.archived = true;
    session.updatedAt = new Date().toISOString();
    await this.store.put(session);
    return session;
  }

  async openWorkspace(id: string, target: "finder" | "terminal" | "editor") {
    const session = await this.getSession(id);
    const argumentsByTarget = {
      finder: [session.workspace.path],
      terminal: ["-a", "Terminal", session.workspace.path],
      editor: ["-a", "Visual Studio Code", session.workspace.path]
    } as const;
    await runCommand(["/usr/bin/open", ...argumentsByTarget[target]], session.workspace.path);
  }

  async events(id: string, after: number) {
    const session = await this.getSession(id);
    // `after` reaches this through Number() on a query parameter, so it can be
    // NaN, negative, fractional, non-finite or ahead of this session. Every
    // comparison against NaN is false, and echoing a cursor beyond the current
    // tail would let it skip events that are appended later. Keep nextCursor
    // server-owned: unusable input resynchronises from the beginning, while a
    // valid cursor remains unchanged.
    const lastSequence = session.events.at(-1)?.sequence ?? 0;
    const candidate = Number.isFinite(after) ? Math.max(0, Math.floor(after)) : 0;
    const cursor = candidate <= lastSequence ? candidate : 0;
    const events = session.events.filter((event) => event.sequence > cursor);
    // Only the delta plus the fields a poller cannot derive from it: the
    // reconstructed messages and the session status. Returning the whole
    // session here made this endpoint as heavy as GET /v1/sessions/:id.
    return {
      events,
      nextCursor: lastSequence,
      status: session.status,
      messages: session.messages
    };
  }

  async review(id: string, revision: string, comparisonRef?: string) {
    const session = await this.getSession(id);
    return readCodeReview(session.workspace, revision, comparisonRef);
  }

  async shutdown() {
    const runs = [...this.activeRuns.values()];
    for (const run of runs) run.interrupt();
    await Promise.allSettled(runs.map((run) => run.completed));
  }

  private runTurn(session: CodeSession, prompt: string, turnId: string, installation?: HarnessInstallation) {
    const adapter = requireAdapter(session.harnessId);
    const promptMessage = session.messages.find((message) => message.turnId === turnId && message.role === "user");
    void this.appendEvent(session, turnId, {
      kind: "turn.started",
      data: { promptMessageId: promptMessage?.id ?? "unknown" }
    });

    const run = adapter.run({
      cwd: session.workspace.path,
      prompt,
      model: session.draft.model,
      autonomy: session.effectiveAutonomy,
      binding: session.binding,
      installation,
      emit: (event) => { void this.appendEvent(session, turnId, event); }
    });
    this.activeRuns.set(session.id, run);

    void run.binding.then(async (binding) => {
      const firstBinding = !session.binding;
      session.binding = binding;
      for (const event of session.events) {
        if (event.externalSessionId === "pending") event.externalSessionId = binding.externalSessionId;
      }
      if (firstBinding) {
        await this.appendEvent(session, turnId, {
          kind: "session.started",
          data: { harnessVersion: binding.harnessVersion, transport: binding.transport }
        });
      }
    }).catch(() => {});

    void run.completed
      .then(async () => this.completeTurn(session, turnId, "completed"))
      .catch(async (error) => {
        const interrupted = this.interrupted.delete(session.id);
        await this.completeTurn(
          session,
          turnId,
          interrupted ? "interrupted" : "failed",
          interrupted ? undefined : error instanceof Error ? error.message : "Harness turn failed"
        );
      })
      .finally(() => {
        this.activeRuns.delete(session.id);
      });
  }

  private async completeTurn(
    session: CodeSession,
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    error?: string
  ) {
    try {
      const diff = await readWorkspaceDiff(session.workspace);
      await this.appendEvent(session, turnId, { kind: "diff.updated", data: diff });
    } catch (diffError) {
      await this.appendEvent(session, turnId, {
        kind: "diagnostic",
        data: { level: "warning", message: diffError instanceof Error ? diffError.message : "Unable to read Git diff" }
      });
    }

    await this.appendEvent(session, turnId, {
      kind: status === "failed" ? "turn.failed" : "turn.completed",
      data: { status, error }
    });
    session.status = status;
    session.error = error;
    session.updatedAt = new Date().toISOString();
    await this.persist(session);
  }

  private appendEvent(session: CodeSession, turnId: string, input: HarnessEventInput) {
    const event = {
      ...input,
      id: crypto.randomUUID(),
      sequence: (session.events.at(-1)?.sequence ?? 0) + 1,
      occurredAt: new Date().toISOString(),
      harnessId: session.harnessId,
      externalSessionId: session.binding?.externalSessionId ?? "pending",
      turnId
    } as HarnessEvent;
    session.events.push(event);
    if (event.kind === "message.delta") {
      let message = session.messages.find((candidate) => candidate.turnId === turnId && candidate.role === "assistant");
      if (!message) {
        message = { id: event.data.messageId, role: "assistant", content: "", createdAt: event.occurredAt, turnId };
        session.messages.push(message);
      }
      message.content += event.data.delta;
    }
    session.updatedAt = event.occurredAt;
    if (
      (event.kind === "message.delta" || event.kind === "reasoning.delta") &&
      event.sequence % 20 !== 0
    ) {
      return Promise.resolve();
    }
    return this.persist(session);
  }

  private persist(session: CodeSession) {
    const previous = this.persistence.get(session.id) ?? Promise.resolve();
    const next = previous.then(() => this.store.put(session));
    this.persistence.set(session.id, next);
    return next.finally(() => {
      if (this.persistence.get(session.id) === next) this.persistence.delete(session.id);
    });
  }

  private async reconcileSession(session: CodeSession) {
    if (session.status !== "running" || this.activeRuns.has(session.id)) return;
    session.status = "interrupted";
    session.error = "The local executor stopped before this turn completed.";
    session.updatedAt = new Date().toISOString();
    await this.store.put(session);
  }
}

export class CodeNotFoundError extends Error {}

function validateInput(input: string) {
  if (!input.trim()) throw new Error("A prompt is required");
  if (Buffer.byteLength(input) > 256 * 1024) throw new Error("Prompt exceeds 256 KiB");
}

async function validateDraft(draft: CodeSessionDraft) {
  if (!draft.repositoryPath.trim()) throw new Error("A repository is required");
  if (!draft.baseRef.trim()) throw new Error("A base branch is required");
  await inspectRepository(draft.repositoryPath);
  requireAdapter(draft.harnessId);
}

function titleFromPrompt(prompt: string) {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function toSummary(session: CodeSession): CodeSessionSummary {
  return {
    id: session.id,
    title: session.title,
    harnessId: session.harnessId,
    status: session.status,
    branch: session.branch,
    repositoryName: session.repositoryName,
    updatedAt: session.updatedAt,
    archived: session.archived
  };
}
