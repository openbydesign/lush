import { describe, expect, test } from "bun:test";
import {
  assertModelSupportsEndpoint,
  listOpenAICompatibleModels,
  OpenAICompatibleApiError,
  parseOpenAICompatibleRequest,
  proxyOpenAICompatibleRequest
} from "../services/inference/src/openai-api";
import type {
  ConnectedModel,
  ConnectedProvider
} from "../services/inference/src/runtime";

const provider: ConnectedProvider = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "openai-compatible",
  label: "Internal gateway",
  baseUrl: "https://models.example/v1",
  apiKey: "provider-secret",
  enabled: true,
  models: [
    {
      id: "vendor/chat-model",
      label: "Chat model",
      capabilities: { interfaces: ["chat-completions"] },
      enabled: true
    },
    {
      id: "vendor/disabled-model",
      label: "Disabled model",
      capabilities: {},
      enabled: false
    },
    {
      id: "vendor/messages-only-model",
      label: "Messages-only model",
      capabilities: { interfaces: ["messages"] },
      enabled: true
    }
  ]
};

const connectedModel: ConnectedModel = {
  provider,
  modelId: "vendor/chat-model"
};

describe("OpenAI-compatible inference API", () => {
  test("lists only enabled models behind enabled providers", () => {
    expect(
      listOpenAICompatibleModels([
        provider,
        { ...provider, id: "disabled-provider", enabled: false }
      ])
    ).toEqual({
      object: "list",
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111:vendor/chat-model",
          object: "model",
          created: 0,
          owned_by: "Internal gateway"
        }
      ]
    });
  });

  test("requires an OpenAI model field", () => {
    expect(() => parseOpenAICompatibleRequest({ input: "hello" })).toThrow(
      OpenAICompatibleApiError
    );
    expect(parseOpenAICompatibleRequest({ model: "provider:model", input: [] }))
      .toEqual({ model: "provider:model", input: [] });
  });

  test("rejects an explicitly unsupported endpoint", () => {
    expect(() => assertModelSupportsEndpoint(connectedModel, "embeddings"))
      .toThrow("does not support /v1/embeddings");
  });

  test("allows the provider to decide when capability metadata is unknown", () => {
    expect(() =>
      assertModelSupportsEndpoint(
        {
          provider: {
            ...provider,
            models: [{ ...provider.models[0]!, capabilities: {} }]
          },
          modelId: "vendor/chat-model"
        },
        "responses"
      )
    ).not.toThrow();
  });

  test("rewrites only the routed model and preserves the provider response", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const response = await proxyOpenAICompatibleRequest({
      endpoint: "chat/completions",
      request: {
        model: `${provider.id}:vendor/chat-model`,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
        stream: true
      },
      connectedModel,
      signal: new AbortController().signal,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "provider-request"
          }
        });
      }) as typeof fetch
    });

    expect(requestUrl).toBe("https://models.example/v1/chat/completions");
    expect(requestInit?.headers).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer provider-secret",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      model: "vendor/chat-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [{ type: "function", function: { name: "lookup" } }],
      stream: true
    });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("provider-request");
    expect(response.headers.get("x-lush-model")).toBe(
      `${provider.id}:vendor/chat-model`
    );
    expect(await response.text()).toContain("data: [DONE]");
  });

  test("strips provider-private response headers", async () => {
    const response = await proxyOpenAICompatibleRequest({
      endpoint: "chat/completions",
      request: {
        model: `${provider.id}:vendor/chat-model`,
        messages: []
      },
      connectedModel,
      signal: new AbortController().signal,
      fetch: (async () =>
        new Response(JSON.stringify({ id: "chatcmpl_1" }), {
          headers: {
            "content-type": "application/json",
            "set-cookie": "provider_session=secret",
            "x-provider-secret": "secret"
          }
        })) as typeof fetch
    });

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-provider-secret")).toBeNull();
  });
});
