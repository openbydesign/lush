import type { InferenceModelCapabilities } from "@lush/db/schema";
import {
  discoverOpenAICompatibleModels,
  streamOpenAICompatibleChat,
  type DiscoveredModel
} from "../openai-compatible";
import {
  compactCapabilities,
  mergeModelCapabilities
} from "../model-capabilities";
import type {
  InferenceProviderAdapter,
  ProviderConnection,
  StreamProviderChatOptions
} from "./types";

export const fireworksAdapter: InferenceProviderAdapter = {
  async discoverModels(provider: ProviderConnection) {
    const models = await discoverOpenAICompatibleModels(
      provider,
      fireworksCapabilitiesFromModel
    );
    const metadata = await discoverFireworksModelMetadata(provider, models);
    return enrichFireworksModels(models, metadata);
  },

  streamChat(options: StreamProviderChatOptions) {
    return streamOpenAICompatibleChat(
      {
        endpoint: `${options.baseUrl}/chat/completions`,
        apiKey: options.apiKey,
        model: options.modelId
      },
      options.messages,
      options.signal
    );
  }
};

export function fireworksCapabilitiesFromModel(
  model: Record<string, unknown>
): InferenceModelCapabilities {
  const conversational =
    model.conversationConfig !== undefined && model.conversationConfig !== null;
  const embedding =
    typeof model.kind === "string" &&
    model.kind.toUpperCase().includes("EMBEDDING");

  return compactCapabilities({
    interfaces: [
      ...(conversational ? (["chat-completions"] as const) : []),
      ...(embedding ? (["embeddings"] as const) : [])
    ],
    inputModalities: [
      ...(conversational || embedding ? (["text"] as const) : []),
      ...(model.supportsImageInput === true ? (["image"] as const) : [])
    ],
    outputModalities: [
      ...(conversational ? (["text"] as const) : []),
      ...(embedding ? (["embedding"] as const) : [])
    ],
    features: model.supportsTools === true ? ["tools"] : []
  });
}

function enrichFireworksModels(
  models: DiscoveredModel[],
  metadata: Record<string, unknown>[]
) {
  const metadataById = new Map(
    metadata.flatMap((model) =>
      typeof model.name === "string" ? [[model.name, model] as const] : []
    )
  );

  return models.map((model) => {
    const providerModel = metadataById.get(model.id);
    if (!providerModel) return model;

    return {
      ...model,
      label:
        typeof providerModel.displayName === "string"
          ? providerModel.displayName
          : model.label,
      capabilities: mergeModelCapabilities(
        model.capabilities,
        fireworksCapabilitiesFromModel(providerModel)
      )
    };
  });
}

async function discoverFireworksModelMetadata(
  provider: ProviderConnection,
  models: DiscoveredModel[]
) {
  let providerUrl: URL;
  try {
    providerUrl = new URL(provider.baseUrl);
  } catch {
    return [];
  }

  // Never send a Fireworks credential to a management host inferred from a
  // custom OpenAI-compatible endpoint.
  if (providerUrl.hostname !== "api.fireworks.ai") return [];

  const accountIds = new Set(
    models.flatMap((model) => {
      const match = /^accounts\/([^/]+)\/models\//.exec(model.id);
      return match?.[1] ? [match[1]] : [];
    })
  );

  const pages = await Promise.all(
    [...accountIds].map((accountId) =>
      listFireworksAccountModels(provider, accountId).catch(() => [])
    )
  );
  return pages.flat();
}

async function listFireworksAccountModels(
  provider: ProviderConnection,
  accountId: string
) {
  const models: Record<string, unknown>[] = [];
  let pageToken = "";

  for (let page = 0; page < 20; page += 1) {
    const url = new URL(
      `/v1/accounts/${encodeURIComponent(accountId)}/models`,
      provider.baseUrl
    );
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) return models;

    const body = await response.json().catch(() => undefined);
    if (!body || typeof body !== "object") return models;
    const candidate = body as { models?: unknown; nextPageToken?: unknown };
    if (Array.isArray(candidate.models)) {
      models.push(
        ...candidate.models.filter(
          (model): model is Record<string, unknown> =>
            Boolean(model) && typeof model === "object"
        )
      );
    }

    pageToken =
      typeof candidate.nextPageToken === "string"
        ? candidate.nextPageToken
        : "";
    if (!pageToken) break;
  }

  return models;
}
