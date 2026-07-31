import type { InferenceProviderKind } from "@lush/db/schema";

export type InferenceTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type InferenceToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type InferenceTurnMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; toolCalls: InferenceToolCall[] }
  | {
      role: "tool";
      toolCallId: string;
      name: string;
      content: string;
      isError?: boolean;
    };

export type InferenceTurnEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; call: InferenceToolCall };

export type ProviderToolTurnOptions = {
  kind: InferenceProviderKind;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  messages: InferenceTurnMessage[];
  tools: InferenceTool[];
  signal: AbortSignal;
};

export async function* streamProviderToolTurn(
  options: ProviderToolTurnOptions
): AsyncGenerator<InferenceTurnEvent> {
  if (options.kind === "anthropic") {
    yield* streamAnthropicToolTurn(options);
    return;
  }
  if (options.kind === "openai") {
    yield* streamOpenAIResponsesToolTurn(options);
    return;
  }
  yield* streamChatCompletionsToolTurn(options);
}

async function* streamChatCompletionsToolTurn(
  options: ProviderToolTurnOptions
): AsyncGenerator<InferenceTurnEvent> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.modelId,
      messages: options.messages.map(chatCompletionsMessage),
      tools: options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      })),
      tool_choice: "auto",
      stream: true,
      temperature: 0.7
    }),
    signal: options.signal
  });
  assertStreamingResponse(response);

  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const event of readSseJson(response.body!)) {
    const delta = firstChoiceDelta(event);
    if (!delta) continue;
    if (typeof delta.content === "string" && delta.content) {
      yield { type: "text_delta", delta: delta.content };
    }
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const value of delta.tool_calls) {
      if (!isRecord(value) || typeof value.index !== "number") continue;
      const prior = calls.get(value.index) ?? { id: "", name: "", arguments: "" };
      const fn = isRecord(value.function) ? value.function : {};
      calls.set(value.index, {
        id: mergeStreamedIdentifier(prior.id, stringValue(value.id)),
        name: mergeStreamedIdentifier(prior.name, stringValue(fn.name)),
        arguments: prior.arguments + stringValue(fn.arguments)
      });
    }
  }
  for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
    yield { type: "tool_call", call: completedToolCall(call) };
  }
}

function chatCompletionsMessage(message: InferenceTurnMessage) {
  if ("toolCalls" in message) {
    return {
      role: "assistant",
      content: null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) }
      }))
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }
  return message;
}

async function* streamOpenAIResponsesToolTurn(
  options: ProviderToolTurnOptions
): AsyncGenerator<InferenceTurnEvent> {
  const instructions = options.messages
    .filter((message) => message.role === "system" && "content" in message)
    .map((message) => "content" in message ? message.content : "")
    .join("\n\n");
  const input = options.messages
    .filter((message) => message.role !== "system")
    .flatMap(openAIResponseItems);
  const response = await fetch(`${options.baseUrl}/responses`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`
    },
    body: JSON.stringify({
      model: options.modelId,
      ...(instructions ? { instructions } : {}),
      input,
      tools: options.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false
      })),
      tool_choice: "auto",
      stream: true,
      store: false
    }),
    signal: options.signal
  });
  assertStreamingResponse(response);

  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  for await (const event of readSseJson(response.body!)) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      yield { type: "text_delta", delta: event.delta };
      continue;
    }
    const item = isRecord(event.item) ? event.item : undefined;
    if (event.type === "response.output_item.added" && item?.type === "function_call") {
      const itemId = stringValue(item.id) || stringValue(item.call_id);
      calls.set(itemId, {
        id: stringValue(item.call_id) || itemId,
        name: stringValue(item.name),
        arguments: stringValue(item.arguments)
      });
      continue;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const itemId = stringValue(event.item_id);
      const prior = calls.get(itemId);
      if (prior) prior.arguments += stringValue(event.delta);
      continue;
    }
    if (event.type === "response.output_item.done" && item?.type === "function_call") {
      const itemId = stringValue(item.id) || stringValue(item.call_id);
      calls.set(itemId, {
        id: stringValue(item.call_id) || itemId,
        name: stringValue(item.name),
        arguments: stringValue(item.arguments) || calls.get(itemId)?.arguments || ""
      });
      continue;
    }
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(providerStreamError(event, "OpenAI response failed"));
    }
  }
  for (const call of calls.values()) {
    yield { type: "tool_call", call: completedToolCall(call) };
  }
}

function openAIResponseItems(message: InferenceTurnMessage): unknown[] {
  if ("toolCalls" in message) {
    return message.toolCalls.map((call) => ({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    }));
  }
  if (message.role === "tool") {
    return [{
      type: "function_call_output",
      call_id: message.toolCallId,
      output: message.content
    }];
  }
  return [{ role: message.role, content: message.content }];
}

async function* streamAnthropicToolTurn(
  options: ProviderToolTurnOptions
): AsyncGenerator<InferenceTurnEvent> {
  const system = options.messages
    .filter((message) => message.role === "system" && "content" in message)
    .map((message) => "content" in message ? message.content : "")
    .join("\n\n");
  const response = await fetch(`${options.baseUrl}/messages`, {
    method: "POST",
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": options.apiKey
    },
    body: JSON.stringify({
      model: options.modelId,
      system,
      messages: anthropicMessages(options.messages),
      tools: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      })),
      tool_choice: { type: "auto" },
      max_tokens: 4096,
      stream: true
    }),
    signal: options.signal
  });
  assertStreamingResponse(response);

  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const event of readSseJson(response.body!)) {
    const index = typeof event.index === "number" ? event.index : -1;
    const block = isRecord(event.content_block) ? event.content_block : undefined;
    if (event.type === "content_block_start" && block?.type === "tool_use" && index >= 0) {
      calls.set(index, {
        id: stringValue(block.id),
        name: stringValue(block.name),
        arguments: isRecord(block.input) && Object.keys(block.input).length > 0
          ? JSON.stringify(block.input)
          : ""
      });
      continue;
    }
    const delta = isRecord(event.delta) ? event.delta : undefined;
    if (event.type === "content_block_delta" && delta?.type === "text_delta") {
      const text = stringValue(delta.text);
      if (text) yield { type: "text_delta", delta: text };
      continue;
    }
    if (
      event.type === "content_block_delta" &&
      delta?.type === "input_json_delta" &&
      index >= 0
    ) {
      const prior = calls.get(index);
      if (prior) prior.arguments += stringValue(delta.partial_json);
      continue;
    }
    if (event.type === "error") {
      throw new Error(providerStreamError(event, "Anthropic response failed"));
    }
  }
  for (const [, call] of [...calls].sort(([left], [right]) => left - right)) {
    yield { type: "tool_call", call: completedToolCall(call) };
  }
}

function anthropicMessages(messages: InferenceTurnMessage[]) {
  return messages.filter((message) => message.role !== "system").map((message) => {
    if ("toolCalls" in message) {
      return {
        role: "assistant",
        content: message.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments
        }))
      };
    }
    if (message.role === "tool") {
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError === true
        }]
      };
    }
    return { role: message.role, content: message.content };
  });
}

async function* readSseJson(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSseJson(line);
      if (event) yield event;
    }
    if (done) break;
  }
  const event = parseSseJson(buffer);
  if (event) yield event;
}

function parseSseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    const value = JSON.parse(data);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function firstChoiceDelta(event: Record<string, unknown>) {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : undefined;
  return choice && isRecord(choice.delta) ? choice.delta : undefined;
}

function completedToolCall(call: { id: string; name: string; arguments: string }) {
  if (!call.id || !call.name) throw new Error("Provider returned an incomplete tool call");
  let parsed: unknown = {};
  try {
    parsed = call.arguments ? JSON.parse(call.arguments) : {};
  } catch {
    throw new Error(`Provider returned invalid JSON arguments for tool '${call.name}'`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Provider returned non-object arguments for tool '${call.name}'`);
  }
  return { id: call.id, name: call.name, arguments: parsed };
}

function assertStreamingResponse(response: Response): asserts response is Response & {
  body: ReadableStream<Uint8Array>;
} {
  if (response.ok && response.body) return;
  throw new Error(`Provider request failed with ${response.status}: ${response.statusText}`);
}

function providerStreamError(event: Record<string, unknown>, fallback: string) {
  const error = isRecord(event.error)
    ? event.error
    : isRecord(event.response) && isRecord(event.response.error)
      ? event.response.error
      : undefined;
  return typeof error?.message === "string"
    ? error.message
    : typeof event.message === "string"
      ? event.message
      : fallback;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function mergeStreamedIdentifier(prior: string, next: string) {
  if (!next || next === prior || prior.startsWith(next)) return prior;
  if (!prior || next.startsWith(prior)) return next;
  return prior + next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
