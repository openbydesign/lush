import { describe, expect, test } from "bun:test";
import { parseModelDiscoveryResponse } from "../services/inference/src/openai-compatible";
import { anthropicCapabilitiesFromModel } from "../services/inference/src/providers/anthropic";
import { basetenModelApiCapabilities } from "../services/inference/src/providers/baseten";
import {
  fireworksAdapter,
  fireworksCapabilitiesFromModel
} from "../services/inference/src/providers/fireworks";

describe("inference model discovery", () => {
  test("preserves models regardless of naming convention", async () => {
    const models = await parseModelDiscoveryResponse(
      modelResponse([
        {
          id: "moonshotai/Kimi-K3",
          display_name: "Kimi K3"
        },
        {
          id: "zai-org/GLM-5.2",
          name: "GLM 5.2"
        },
        {
          id: "vendor/custom-model-v1"
        }
      ])
    );

    expect(models).toEqual([
      {
        id: "moonshotai/Kimi-K3",
        label: "Kimi K3",
        capabilities: {},
        enabled: false
      },
      {
        id: "zai-org/GLM-5.2",
        label: "GLM 5.2",
        capabilities: {},
        enabled: false
      },
      {
        id: "vendor/custom-model-v1",
        label: "vendor/custom-model-v1",
        capabilities: {},
        enabled: false
      }
    ]);
  });

  test("ignores malformed entries without suppressing valid models", async () => {
    const models = await parseModelDiscoveryResponse(
      modelResponse([
        null,
        {},
        { id: 123 },
        { id: "provider/model", display_name: 123 }
      ])
    );

    expect(models).toEqual([
      {
        id: "provider/model",
        label: "provider/model",
        capabilities: {},
        enabled: false
      }
    ]);
  });

  test("maps Anthropic's explicit capability flags without treating omissions as false", () => {
    expect(
      anthropicCapabilitiesFromModel({
        capabilities: {
          image_input: { supported: true },
          pdf_input: { supported: false },
          structured_outputs: { supported: true },
          thinking: { supported: true },
          citations: { supported: true },
          code_execution: { supported: false },
          batch: { supported: true }
        }
      })
    ).toEqual({
      interfaces: ["messages"],
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      features: ["structured-output", "reasoning", "citations", "batch"]
    });
  });

  test("records Baseten's platform-wide Model API contract", () => {
    expect(basetenModelApiCapabilities).toEqual({
      interfaces: ["chat-completions", "messages"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      features: ["tools", "structured-output"]
    });
  });

  test("maps Fireworks management metadata rather than model-name heuristics", () => {
    expect(
      fireworksCapabilitiesFromModel({
        kind: "EMBEDDING_MODEL",
        supportsImageInput: false,
        supportsTools: false
      })
    ).toEqual({
      interfaces: ["embeddings"],
      inputModalities: ["text"],
      outputModalities: ["embedding"]
    });

    expect(
      fireworksCapabilitiesFromModel({
        conversationConfig: {},
        supportsImageInput: true,
        supportsTools: true
      })
    ).toEqual({
      interfaces: ["chat-completions"],
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      features: ["tools"]
    });
  });

  test("opportunistically enriches Fireworks enumeration from its management API", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url === "https://api.fireworks.ai/inference/v1/models") {
        return modelResponse([
          { id: "accounts/fireworks/models/kimi-k3", name: "Kimi K3" }
        ]);
      }

      return new Response(
        JSON.stringify({
          models: [
            {
              name: "accounts/fireworks/models/kimi-k3",
              displayName: "Kimi K3",
              conversationConfig: {},
              supportsImageInput: true,
              supportsTools: true
            }
          ]
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const models = await fireworksAdapter.discoverModels({
        kind: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "test-key"
      });

      expect(requestedUrls).toEqual([
        "https://api.fireworks.ai/inference/v1/models",
        "https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200"
      ]);
      expect(models[0]?.capabilities).toEqual({
        interfaces: ["chat-completions"],
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        features: ["tools"]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function modelResponse(data: unknown[]) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
