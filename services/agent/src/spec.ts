export const agentTypes = `
export type AgentChatAttachment = {
  filename: string;
  mediaType: string;
  content: string;
};

export type AgentChatMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: AgentChatAttachment[];
};

export type AgentStreamEvent =
  | { type: "response-start" }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | {
      type: "tool-input";
      toolCallId: string;
      toolName: string;
      toolTitle?: string;
      connectionLabel?: string;
      connectionSource?: "mcp" | "openapi" | "native";
      connectionIconUrl?: string;
      input: unknown;
    }
  | {
      type: "tool-output";
      toolCallId: string;
      toolName: string;
      toolTitle?: string;
      connectionLabel?: string;
      connectionSource?: "mcp" | "openapi" | "native";
      connectionIconUrl?: string;
      output?: unknown;
      errorText?: string;
    }
  | {
      type: "tool-approval-required";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      toolTitle?: string;
      connectionLabel?: string;
      connectionSource?: "mcp" | "openapi" | "native";
      connectionIconUrl?: string;
      expiresAt: string;
    }
  | {
      type: "tool-approval-resolved";
      approvalId: string;
      toolCallId: string;
      toolName: string;
      decision: "approved" | "denied" | "expired";
    }
  | { type: "source"; sourceId: string; url: string; title: string }
  | {
      type: "artifact";
      artifactId: string;
      title: string;
      description?: string;
      mediaType: string;
      content?: string;
      url?: string;
    }
  | { type: "response-complete" }
  | { type: "response-error"; message: string };

export type AgentChatRequest = {
  modelSelection: string;
  sessionId: string;
  messages: AgentChatMessage[];
};

export type AgentPromptRequest = {
  modelSelection: string;
  messages: AgentChatMessage[];
};

export type AgentRunStatus = "queued" | "running" | "waiting_for_approval" |
  "needs_acknowledgment" | "completed" | "failed" | "cancelled";

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
  purpose: "chat" | "title";
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

export type CreateAgentRunRequest = {
  idempotencyKey: string;
  originMessageId?: string;
  modelSelection?: string;
  message: AgentChatMessage;
  metadata?: unknown;
};

export type AgentRunEvent = {
  runId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
};
`;

export const agentRoutes = [
  {
    id: "createAgentRun",
    method: "POST",
    path: "/sessions/:sessionId/runs",
    requestType: "CreateAgentRunRequest",
    responseType: "Response",
    auth: true,
    kind: "stream"
  },
  {
    id: "fetchAgentRun",
    method: "GET",
    path: "/runs/:runId",
    responseType: "AgentRun",
    auth: true,
    kind: "json"
  },
  {
    id: "streamAgentRunEvents",
    method: "GET",
    path: "/runs/:runId/events",
    responseType: "Response",
    auth: true,
    kind: "stream"
  },
  {
    id: "cancelAgentRun",
    method: "POST",
    path: "/runs/:runId/cancel",
    requestType: "Record<string, never>",
    responseType: "AgentRun",
    auth: true,
    kind: "json"
  },
  {
    id: "streamAgentChat",
    method: "POST",
    path: "/agents/:agentSlug/chat",
    requestType: "AgentChatRequest",
    responseType: "Response",
    auth: true,
    kind: "stream"
  },
  {
    id: "streamAgentPrompt",
    method: "POST",
    path: "/agents/:agentSlug/prompt",
    requestType: "AgentPromptRequest",
    responseType: "Response",
    auth: true,
    kind: "stream"
  }
] as const;

export type AgentRoute = (typeof agentRoutes)[number];
