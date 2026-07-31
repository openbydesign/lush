/**
 * Normalized conversation message model, modeled on Google Agent Executor's
 * `content.proto` (https://github.com/google/ax).
 *
 * A `Message` is a role plus exactly one `Content` value — a single-arm oneof,
 * not an array of parts. A conversational turn is therefore many messages. This
 * is the protocol-neutral shape that crosses the orchestrator <-> runtime
 * boundary and is what the durable event log records; provider adapters and the
 * Lush stream protocol project to and from it.
 *
 * We mirror AX's *contract*, not its wire format: fields are idiomatic
 * TypeScript rather than protobuf, and AX is never a runtime dependency.
 */

export type Role = "user" | "assistant" | "model" | "tool" | "system";

export type TextContent = { type: "text"; text: string };

/** Model reasoning. AX `ThoughtContent`; summary text is what is safe to show. */
export type ThoughtContent = {
  type: "thought";
  summary: string;
  signature?: string;
};

/** AX `ToolCallContent` + `FunctionCallContent`. Correlated to a result by id. */
export type ToolCallContent = {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Opaque backend validation hash (AX `signature`), passed through verbatim. */
  signature?: string;
};

/** AX `ToolResultContent` + `FunctionResultContent`. `callId` matches the call. */
export type ToolResultContent = {
  type: "tool_result";
  callId: string;
  name: string;
  response: unknown;
  isError?: boolean;
  signature?: string;
};

/**
 * Human-in-the-loop approval request. The harness may emit the question, but the
 * decision is accepted only by the authenticated control plane and never enters
 * model- or harness-authored content.
 */
export type ConfirmationContent = {
  type: "confirmation";
  id: string;
  question?: string;
};

export type MediaKind = "image" | "audio" | "document" | "video";

export type MediaContent = {
  type: MediaKind;
  mimeType: string;
  /** base64 inline data or a URI reference; exactly one is expected. */
  data?: string;
  uri?: string;
};

export type Content =
  | TextContent
  | ThoughtContent
  | ToolCallContent
  | ToolResultContent
  | ConfirmationContent
  | MediaContent;

export type Message = { role: Role; content: Content };

// --- constructors ----------------------------------------------------------

export function textMessage(role: Role, text: string): Message {
  return { role, content: { type: "text", text } };
}

export function toolCallMessage(
  call: Omit<ToolCallContent, "type">,
  role: Role = "assistant"
): Message {
  return { role, content: { type: "tool_call", ...call } };
}

export function toolResultMessage(
  result: Omit<ToolResultContent, "type">,
  role: Role = "tool"
): Message {
  return { role, content: { type: "tool_result", ...result } };
}

export function confirmationMessage(
  confirmation: Omit<ConfirmationContent, "type">,
  role: Role = "assistant"
): Message {
  return { role, content: { type: "confirmation", ...confirmation } };
}

// --- guards / selectors ----------------------------------------------------

export function isTextContent(content: Content): content is TextContent {
  return content.type === "text";
}

export function isToolCall(content: Content): content is ToolCallContent {
  return content.type === "tool_call";
}

export function isToolResult(content: Content): content is ToolResultContent {
  return content.type === "tool_result";
}

/** Concatenate the text of every text message, ignoring non-text content. */
export function collectText(messages: Message[]): string {
  return messages
    .filter((message) => isTextContent(message.content))
    .map((message) => (message.content as TextContent).text)
    .join("");
}

/** The most recent user text in a message list, if any. */
export function lastUserText(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && isTextContent(message.content)) {
      return message.content.text;
    }
  }
  return undefined;
}
