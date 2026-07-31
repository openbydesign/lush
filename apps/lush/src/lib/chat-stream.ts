import {
  createAgentRun,
  streamAgentRunEvents,
  type AgentChatMessage,
  type InferenceProviderStatus,
  type SessionMessage
} from "@lush/api-client";

export function titleFromContent(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "Untitled session";
  return normalized.length > 80
    ? `${normalized.slice(0, 77).trimEnd()}...`
    : normalized;
}

export function isRenderableChatMessage(
  message: SessionMessage
): message is SessionMessage & { role: "user" | "assistant" } {
  return message.role === "user" || message.role === "assistant";
}

export async function agentResponseErrorMessage(response: Response) {
  const fallback = `Inference request failed with ${response.status}`;
  const details = await response.text().catch(() => "");
  if (!details) return fallback;

  try {
    const body = JSON.parse(details) as { message?: unknown; error?: unknown };
    if (typeof body.message === "string" && body.message.trim()) {
      return body.message.trim();
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error.trim();
    }
  } catch {
    return details;
  }

  return fallback;
}

export function getModelLabel(
  providers: InferenceProviderStatus[],
  modelSelection: string
) {
  const separatorIndex = modelSelection.indexOf(":");
  if (separatorIndex === -1) return "";

  const providerId = modelSelection.slice(0, separatorIndex);
  const modelId = modelSelection.slice(separatorIndex + 1);
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider?.models.find((candidate) => candidate.id === modelId)?.label ?? "";
}

export function postAgentRun(
  apiBaseUrl: string,
  sessionToken: string | undefined,
  modelSelection: string,
  sessionId: string,
  request: {
    idempotencyKey: string;
    originMessageId?: string;
    message: AgentChatMessage;
    metadata: unknown;
  },
  signal: AbortSignal
) {
  return createAgentRun(
    apiBaseUrl,
    sessionId,
    sessionToken,
    { ...request, modelSelection },
    signal
  );
}

export function reconnectAgentRun(
  apiBaseUrl: string,
  sessionToken: string | undefined,
  runId: string,
  signal: AbortSignal
) {
  return streamAgentRunEvents(
    apiBaseUrl,
    runId,
    sessionToken,
    undefined,
    signal
  );
}
