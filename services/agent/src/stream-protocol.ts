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

export const agentStreamContentType = "application/x-ndjson; charset=utf-8";

export function encodeAgentStreamEvent(event: AgentStreamEvent) {
  return `${JSON.stringify(event)}\n`;
}

export async function* agentTextEventStream(
  chunks: AsyncGenerator<string>,
  firstChunk?: IteratorResult<string>
): AsyncGenerator<AgentStreamEvent> {
  yield { type: "response-start" };

  if (firstChunk && !firstChunk.done && firstChunk.value) {
    yield { type: "text-delta", delta: firstChunk.value };
  }

  for await (const chunk of chunks) {
    if (chunk) yield { type: "text-delta", delta: chunk };
  }

  yield { type: "response-complete" };
}
