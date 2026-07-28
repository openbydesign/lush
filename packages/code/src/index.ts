export const builtInHarnessIds = {
  codex: "codex",
  claudeCode: "claude-code",
  opencode: "opencode"
} as const;

export type HarnessId = (typeof builtInHarnessIds)[keyof typeof builtInHarnessIds];
export type CodeSessionStatus = "idle" | "running" | "completed" | "failed" | "interrupted";
export type AutonomyMode = "plan" | "manual" | "accept-edits" | "auto";

export type HarnessCapabilities = {
  approvals: "interactive" | "policy-only" | "unsupported";
  steering: boolean;
  sessionFork: boolean;
  subagents: boolean;
  additionalWorkspaceRoots: boolean;
  autonomyModes: AutonomyMode[];
  modelSelection: boolean;
  serviceTierSelection: boolean;
  reasoningStream: boolean;
  structuredDiffs: boolean;
  mcp: boolean;
  nativeSandbox: boolean;
};

export type HarnessInstallation = {
  id: HarnessId;
  displayName: string;
  transport: "structured-cli";
  executable?: string;
  version?: string;
  status: "installed" | "missing" | "incompatible";
  detail?: string;
  capabilities: HarnessCapabilities;
};

export type RepositoryBranch = {
  name: string;
  commit: string;
  current: boolean;
};

export type RepositoryInspection = {
  root: string;
  commonDirectory: string;
  name: string;
  headCommit: string;
  currentBranch?: string;
  dirty: boolean;
  branches: RepositoryBranch[];
};

export type CodeSessionDraft = {
  repositoryPath: string;
  baseRef: string;
  harnessId: HarnessId;
  useWorktree: boolean;
  autonomy: AutonomyMode;
  model?: string;
};

export type CodeMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  turnId: string;
};

export type EventBase<Kind extends string, Data> = {
  id: string;
  sequence: number;
  occurredAt: string;
  harnessId: HarnessId;
  externalSessionId: string;
  turnId?: string;
  kind: Kind;
  data: Data;
};

export type SessionStartedData = { harnessVersion: string; transport: "structured-cli" };
export type TurnStartedData = { promptMessageId: string };
export type MessageDeltaData = { messageId: string; role: "assistant"; format: "markdown" | "text"; delta: string };
export type ReasoningDeltaData = { blockId: string; visibility: "summary" | "native"; delta: string };
export type ToolEventData = { toolCallId: string; name: string; status: "running" | "completed" | "failed"; input?: unknown; output?: string; error?: string };
export type CommandEventData = { commandId: string; command: string; status: "running" | "completed" | "failed"; exitCode?: number; output?: string };
export type FileChangedData = { path: string; change: "created" | "modified" | "deleted" | "renamed" | "unknown" };
export type DiffUpdatedData = { patch: string; stat: string; truncated: boolean };
export type ApprovalRequestedData = {
  approvalId: string;
  action: string;
  reason?: string;
  options: Array<
    | { decision: "allow" | "deny"; duration: "once"; boundary: "operation" }
    | { decision: "allow" | "deny"; duration: "session"; boundary: "session" }
    | { decision: "allow" | "deny"; duration: "persistent"; boundary: "workspace" | "repository" | "user" }
  >;
};
export type UsageUpdatedData = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number };
export type TurnCompletedData = { status: "completed" | "failed" | "interrupted"; error?: string };
export type DiagnosticData = { level: "info" | "warning" | "error"; message: string };

export type HarnessEvent =
  | EventBase<"session.started", SessionStartedData>
  | EventBase<"turn.started", TurnStartedData>
  | EventBase<"message.delta", MessageDeltaData>
  | EventBase<"reasoning.delta", ReasoningDeltaData>
  | EventBase<"tool.started" | "tool.completed", ToolEventData>
  | EventBase<"command.started" | "command.completed", CommandEventData>
  | EventBase<"file.changed", FileChangedData>
  | EventBase<"diff.updated", DiffUpdatedData>
  | EventBase<"approval.requested", ApprovalRequestedData>
  | EventBase<"usage.updated", UsageUpdatedData>
  | EventBase<"turn.completed" | "turn.failed", TurnCompletedData>
  | EventBase<"diagnostic", DiagnosticData>;

type StripEventEnvelope<Event> = Event extends HarnessEvent
  ? Omit<Event, "id" | "sequence" | "occurredAt" | "harnessId" | "externalSessionId" | "turnId">
  : never;

export type HarnessEventInput = StripEventEnvelope<HarnessEvent>;

export type HarnessSessionBinding = {
  harnessId: HarnessId;
  harnessVersion: string;
  adapterVersion: string;
  transport: "structured-cli";
  externalSessionId: string;
};

export type CodeWorkspace = {
  repositoryRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  managedWorktree: boolean;
};

export type CodeSessionSummary = {
  id: string;
  title: string;
  harnessId: HarnessId;
  status: CodeSessionStatus;
  branch: string;
  repositoryName: string;
  updatedAt: string;
  archived: boolean;
};

export type CodeSession = CodeSessionSummary & {
  createdAt: string;
  draft: CodeSessionDraft;
  effectiveAutonomy: AutonomyMode;
  workspace: CodeWorkspace;
  binding?: HarnessSessionBinding;
  messages: CodeMessage[];
  events: HarnessEvent[];
  error?: string;
};

export type StartCodeSessionRequest = { draft: CodeSessionDraft; input: string };
export type SendCodeInputRequest = { input: string };
export type EventPage = {
  events: HarnessEvent[];
  nextCursor: number;
  status: CodeSessionStatus;
  messages: CodeMessage[];
  error?: string;
};

export type CodeReviewCommit = {
  id: string;
  shortId: string;
  subject: string;
  authorName: string;
  authoredAt: string;
};

export type CodeReviewFile = {
  path: string;
  previousPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "unmerged";
  additions: number | null;
  deletions: number | null;
};

export type CodeReviewSnapshot = {
  revision: "net" | "unstaged" | "staged" | "worktree" | string;
  title: string;
  patch: string;
  files: CodeReviewFile[];
  additions: number;
  deletions: number;
  binaryFiles: number;
  truncated: boolean;
};

export type CodeReview = {
  baseCommit: string;
  headCommit: string;
  comparisonRef: string;
  comparisonRefs: string[];
  worktreeDirty: boolean;
  commits: CodeReviewCommit[];
  snapshot: CodeReviewSnapshot;
};

export type CodeSidecarConnection = { baseUrl: string; token: string };
