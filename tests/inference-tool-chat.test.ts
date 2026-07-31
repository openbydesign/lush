import { describe, expect, test } from "bun:test";
import {
  streamProviderToolTurn,
  type InferenceTurnEvent
} from "../services/inference/src/tool-chat";

const tool = {
  name: "web__search",
  description: "Search the web",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  }
};

describe("provider tool turns", () => {
  test("OpenAI-compatible chat completions streams text and assembles tool calls", async () => {
    const { events, request } = await withProviderResponse("openai-compatible", [
      { choices: [{ delta: { content: "Checking. " } }] },
      { choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call-1",
        function: { name: "web__search", arguments: "{\"query\":" }
      }] } }] },
      { choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call-1",
        function: { arguments: "\"Sonoma air\"}" }
      }] } }] }
    ]);

    expect(events).toEqual([
      { type: "text_delta", delta: "Checking. " },
      {
        type: "tool_call",
        call: { id: "call-1", name: "web__search", arguments: { query: "Sonoma air" } }
      }
    ]);
    expect(request.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({ name: "web__search" })
    })]);
  });

  test("OpenAI Responses assembles function-call argument deltas", async () => {
    const { events, request } = await withProviderResponse("openai", [
      { type: "response.output_text.delta", delta: "Checking. " },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "item-1", call_id: "call-1", name: "web__search" }
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "item-1",
        delta: "{\"query\":\"Sonoma air\"}"
      }
    ]);

    expect(events.at(-1)).toEqual({
      type: "tool_call",
      call: { id: "call-1", name: "web__search", arguments: { query: "Sonoma air" } }
    });
    expect(request.store).toBe(false);
    expect(request.tools).toEqual([expect.objectContaining({ name: "web__search" })]);
  });

  test("Anthropic assembles tool_use input JSON", async () => {
    const { events, request } = await withProviderResponse("anthropic", [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call-1", name: "web__search", input: {} }
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{\"query\":\"Sonoma air\"}" }
      }
    ]);

    expect(events).toEqual([{
      type: "tool_call",
      call: { id: "call-1", name: "web__search", arguments: { query: "Sonoma air" } }
    }]);
    expect(request.tools).toEqual([expect.objectContaining({ name: "web__search" })]);
  });
});

async function withProviderResponse(
  kind: "openai-compatible" | "openai" | "anthropic",
  chunks: unknown[]
) {
  const originalFetch = globalThis.fetch;
  let request: Record<string, unknown> = {};
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([
      ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`),
      "data: [DONE]",
      ""
    ].join("\n"), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    const events: InferenceTurnEvent[] = [];
    for await (const event of streamProviderToolTurn({
      kind,
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      modelId: "model",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Why is the air bad?" }
      ],
      tools: [tool],
      signal: new AbortController().signal
    })) events.push(event);
    return { events, request };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
