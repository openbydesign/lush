import type { InferenceModelCapabilities } from "@lush/db/schema";
import { parseModelDiscoveryResponse } from "../openai-compatible";
import {
  compactCapabilities,
  mergeModelCapabilities
} from "../model-capabilities";
import type {
  InferenceProviderAdapter,
  ProviderConnection,
  StreamProviderChatOptions
} from "./types";

export const anthropicAdapter: InferenceProviderAdapter = {
  async discoverModels(provider: ProviderConnection) {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": provider.apiKey
      }
    });

    return parseModelDiscoveryResponse(
      response,
      anthropicCapabilitiesFromModel
    );
  },

  async *streamChat(options: StreamProviderChatOptions) {
    const response = await fetch(`${options.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": options.apiKey
      },
      body: JSON.stringify({
        model: options.modelId,
        system: systemPromptFromMessages(options.messages),
        messages: userMessages(options.messages),
        max_tokens: 4096,
        stream: true
      }),
      signal: options.signal
    });

    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Provider request failed with ${response.status}: ${body || response.statusText}`
      );
    }

    yield* streamAnthropicText(response.body);
  }
};

export function anthropicCapabilitiesFromModel(
  model: Record<string, unknown>
): InferenceModelCapabilities {
  const capabilities =
    model.capabilities && typeof model.capabilities === "object"
      ? (model.capabilities as Record<string, unknown>)
      : {};

  return mergeModelCapabilities(
    {
      interfaces: ["messages"],
      inputModalities: ["text"],
      outputModalities: ["text"]
    },
    compactCapabilities({
      inputModalities: [
        ...(isSupported(capabilities.image_input) ? (["image"] as const) : []),
        ...(isSupported(capabilities.pdf_input) ? (["pdf"] as const) : [])
      ],
      features: [
        ...(isSupported(capabilities.structured_outputs)
          ? (["structured-output"] as const)
          : []),
        ...(isSupported(capabilities.thinking) ? (["reasoning"] as const) : []),
        ...(isSupported(capabilities.citations) ? (["citations"] as const) : []),
        ...(isSupported(capabilities.code_execution)
          ? (["code-execution"] as const)
          : []),
        ...(isSupported(capabilities.batch) ? (["batch"] as const) : [])
      ]
    })
  );
}

function isSupported(value: unknown) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { supported?: unknown }).supported === true
  );
}

async function* streamAnthropicText(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const chunk = parseAnthropicStreamLine(line);
      if (chunk) {
        yield chunk;
      }
    }
  }
}

function parseAnthropicStreamLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return "";
  }

  try {
    const parsed = JSON.parse(trimmed.slice("data:".length).trim());
    return parsed.type === "content_block_delta" ? parsed.delta?.text ?? "" : "";
  } catch {
    return "";
  }
}

function systemPromptFromMessages(messages: StreamProviderChatOptions["messages"]) {
  return messages.find((message) => message.role === "system")?.content ?? "";
}

function userMessages(messages: StreamProviderChatOptions["messages"]) {
  return messages.filter(
    (message): message is { role: "user" | "assistant"; content: string } =>
      message.role === "user" || message.role === "assistant"
  );
}
