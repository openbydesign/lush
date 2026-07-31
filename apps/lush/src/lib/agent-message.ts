import type {
  AgentChatAttachment,
  AgentChatMessage,
  AgentRunEvent,
  AgentStreamEvent,
  SessionMessage
} from "@lush/api-client";
import type {
  ChatAttachmentPart,
  ChatMessage,
  ChatMessagePart
} from "./types";

const metadataSchema = "lush.message.parts.v1";

export function chatMessageFromSession(message: SessionMessage): ChatMessage | undefined {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  return {
    id: message.id,
    serverId: message.id,
    createdAt: message.createdAt,
    role: message.role,
    parts: partsFromMetadata(message.metadata, message.content) ?? [{ type: "text", text: message.content }],
    status: "complete"
  };
}

export function chatMessageText(message: Pick<ChatMessage, "parts">) {
  return message.parts
    .filter((part): part is Extract<ChatMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function chatMessageRequestText(message: Pick<ChatMessage, "parts">) {
  const text = chatMessageText(message);
  if (text.trim()) return text;
  const filenames = attachmentParts(message.parts).map((part) => part.filename);
  return filenames.length > 0 ? `Attached: ${filenames.join(", ")}` : "";
}

export function chatMessageMetadata(parts: ChatMessagePart[]) {
  return {
    schema: metadataSchema,
    parts: parts.map((part) =>
      part.type === "text"
        ? { type: "text" as const, length: part.text.length }
        : part
    )
  };
}

export function agentChatMessage(message: ChatMessage): AgentChatMessage {
  return {
    role: message.role,
    content: chatMessageRequestText(message),
    attachments: attachmentParts(message.parts).map(toAgentAttachment)
  };
}

export function appendAgentStreamEvent(
  parts: ChatMessagePart[],
  event: AgentStreamEvent
): ChatMessagePart[] {
  switch (event.type) {
    case "text-delta":
      return appendDelta(parts, "text", event.delta);
    case "reasoning-delta":
      return appendDelta(parts, "reasoning", event.delta);
    case "tool-input":
      return [
        ...parts,
        {
          type: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          state: "input-available",
          input: event.input
        }
      ];
    case "tool-output":
      return upsertToolOutput(parts, event);
    case "source":
      return parts.some(
        (part) => part.type === "source" && part.sourceId === event.sourceId
      )
        ? parts
        : [...parts, event];
    case "artifact":
      return [
        ...parts.filter(
          (part) =>
            part.type !== "artifact" || part.artifactId !== event.artifactId
        ),
        event
      ];
    default:
      return parts;
  }
}

export async function readAgentEventStream(
  response: Response,
  onEvent: (event: AgentStreamEvent) => void
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The agent returned an empty response.");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(parseAgentStreamEvent(line));
      newline = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail) onEvent(parseAgentStreamEvent(tail));
}

export async function readAgentRunEventStream(
  response: Response,
  onEvent: (event: AgentRunEvent) => void
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The agent run returned an empty response.");

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onEvent(parseAgentRunEvent(line));
      newline = buffer.indexOf("\n");
    }
  }
  const tail = buffer.trim();
  if (tail) onEvent(parseAgentRunEvent(tail));
}

export async function promptAttachments(
  files: Array<{ filename?: string; mediaType?: string; url: string }>
): Promise<ChatAttachmentPart[]> {
  const resolved = await Promise.all(
    files.map(async (file, index) => {
      const response = await fetch(file.url);
      const content = await response.text();
      return {
        type: "attachment" as const,
        id: `attachment-${Date.now()}-${index}`,
        filename: file.filename?.trim() || `attachment-${index + 1}.txt`,
        mediaType: file.mediaType || "text/plain",
        size: new TextEncoder().encode(content).byteLength,
        content
      };
    })
  );

  const totalBytes = resolved.reduce((total, part) => total + (part.size ?? 0), 0);
  if (totalBytes > 48 * 1024) {
    throw new Error("Attachments must contain no more than 48 KB of text in total.");
  }
  return resolved;
}

function parseAgentStreamEvent(line: string): AgentStreamEvent {
  try {
    const event = JSON.parse(line) as AgentStreamEvent;
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new Error("Invalid agent stream event");
    }
    return event;
  } catch {
    throw new Error("The agent returned an invalid event stream.");
  }
}

function parseAgentRunEvent(line: string): AgentRunEvent {
  try {
    const event = JSON.parse(line) as AgentRunEvent;
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.runId !== "string" ||
      typeof event.sequence !== "number" ||
      typeof event.type !== "string"
    ) {
      throw new Error("Invalid agent run event");
    }
    return event;
  } catch {
    throw new Error("The agent returned an invalid run event stream.");
  }
}

function partsFromMetadata(
  metadata: unknown,
  content: string
): ChatMessagePart[] | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const candidate = metadata as { schema?: unknown; parts?: unknown };
  if (candidate.schema !== metadataSchema || !Array.isArray(candidate.parts)) {
    return undefined;
  }
  let textOffset = 0;
  return candidate.parts.flatMap((part) => {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { length?: unknown }).length === "number"
    ) {
      const length = Math.max(0, (part as { length: number }).length);
      const text = content.slice(textOffset, textOffset + length);
      textOffset += length;
      return [{ type: "text" as const, text }];
    }
    return isChatMessagePart(part) ? [part] : [];
  });
}

function isChatMessagePart(part: unknown): part is ChatMessagePart {
  if (!part || typeof part !== "object") return false;
  const candidate = part as Record<string, unknown>;
  switch (candidate.type) {
    case "text":
    case "reasoning":
      return typeof candidate.text === "string";
    case "attachment":
      return typeof candidate.id === "string" &&
        typeof candidate.filename === "string" &&
        typeof candidate.mediaType === "string" &&
        typeof candidate.content === "string";
    case "tool":
      return typeof candidate.toolCallId === "string" &&
        typeof candidate.toolName === "string" &&
        typeof candidate.state === "string";
    case "source":
      return typeof candidate.sourceId === "string" &&
        typeof candidate.url === "string" &&
        typeof candidate.title === "string";
    case "artifact":
      return typeof candidate.artifactId === "string" &&
        typeof candidate.title === "string" &&
        typeof candidate.mediaType === "string";
    default:
      return false;
  }
}

function attachmentParts(parts: ChatMessagePart[]) {
  return parts.filter(
    (part): part is ChatAttachmentPart => part.type === "attachment"
  );
}

function toAgentAttachment(part: ChatAttachmentPart): AgentChatAttachment {
  return {
    filename: part.filename,
    mediaType: part.mediaType,
    content: part.content
  };
}

function appendDelta(
  parts: ChatMessagePart[],
  type: "text" | "reasoning",
  delta: string
) {
  const last = parts.at(-1);
  if (last?.type === type) {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta }];
  }
  return [...parts, { type, text: delta }];
}

function upsertToolOutput(
  parts: ChatMessagePart[],
  event: Extract<AgentStreamEvent, { type: "tool-output" }>
) {
  const existing = parts.findIndex(
    (part) => part.type === "tool" && part.toolCallId === event.toolCallId
  );
  const output = {
    type: "tool" as const,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    state: event.errorText ? "output-error" as const : "output-available" as const,
    output: event.output,
    errorText: event.errorText
  };
  if (existing < 0) return [...parts, output];
  return parts.map((part, index) =>
    index === existing && part.type === "tool"
      ? { ...part, ...output, input: part.input }
      : part
  );
}
