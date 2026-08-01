import {
  fetchProject,
  fetchSession,
  SessionStateError
} from "@lush/sessions/runtime";
import {
  getLushAgentMetadata,
  type AgentChatMessage
} from "./runtime";
export { mergeSessionMessages } from "./message-merge";

export type SessionPrincipal = {
  userId: string;
  organizationId: string;
  tokenId?: string;
};

const maxProjectPromptContextBytes = 48 * 1024;
const textEncoder = new TextEncoder();

export class SessionContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

export async function loadLushSessionMessages(
  principal: SessionPrincipal,
  sessionId: string
) {
  return (await loadLushSessionContext(principal, sessionId)).messages;
}

export async function loadLushSessionContext(
  principal: SessionPrincipal,
  sessionId: string
) {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new SessionContextError(
      "session_required",
      "A session id is required"
    );
  }

  let session: Awaited<ReturnType<typeof fetchSession>>;
  try {
    session = await fetchSession(principal, normalizedSessionId);
  } catch (error) {
    if (error instanceof SessionStateError) {
      throw new SessionContextError(error.code, error.message, error.status);
    }

    throw error;
  }

  const agent = getLushAgentMetadata();
  if (session.agentId !== agent.sessionAgentId) {
    throw new SessionContextError(
      "agent_session_mismatch",
      "Session is not owned by this agent",
      404
    );
  }

  const messages = session.messages
    .filter((message): message is typeof message & AgentChatMessage =>
      message.role === "user" || message.role === "assistant"
    )
    .map(({ role, content, metadata }) => ({
      role,
      content,
      attachments: attachmentsFromMetadata(metadata)
    }));

  const project = session.projectId
    ? await fetchProject(principal, session.projectId).catch((error) => {
        if (error instanceof SessionStateError && error.status === 404) {
          return undefined;
        }
        throw error;
      })
    : undefined;

  return {
    messages,
    project: project
      ? {
          id: project.id,
          name: project.name,
          instructions: project.instructions,
          memory: project.memory,
          contextItems: projectContextForPrompt(project.contextItems)
        }
      : undefined
  };
}

export function projectContextForPrompt(
  items: Array<{ filename: string; mediaType: string; content: string }>,
  maxBytes = maxProjectPromptContextBytes
) {
  const context: Array<{ filename: string; mediaType: string; content: string }> = [];
  let remaining = maxBytes;

  for (const item of items) {
    if (remaining <= 0) break;
    const content = truncateUtf8(item.content, remaining);
    if (!content) continue;
    context.push({ ...item, content });
    remaining -= textEncoder.encode(content).byteLength;
  }

  return context;
}

function truncateUtf8(value: string, maxBytes: number) {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function attachmentsFromMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return undefined;
  const parts = (metadata as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;

  const attachments = parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const candidate = part as Record<string, unknown>;
    return candidate.type === "attachment" &&
      typeof candidate.filename === "string" &&
      typeof candidate.mediaType === "string" &&
      typeof candidate.content === "string"
      ? [{
          filename: candidate.filename,
          mediaType: candidate.mediaType,
          content: candidate.content
        }]
      : [];
  });

  return attachments.length > 0 ? attachments : undefined;
}
