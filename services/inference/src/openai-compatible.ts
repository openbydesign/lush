import type { InferenceModelCapabilities } from "@lush/db/schema";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ProviderConfig = {
  endpoint: string;
  apiKey?: string;
  model: string;
};

export type DiscoveredModel = {
  id: string;
  label: string;
  capabilities: InferenceModelCapabilities;
  enabled: boolean;
};

export type ModelCapabilityResolver = (
  model: Record<string, unknown>
) => InferenceModelCapabilities;

export async function* streamOpenAICompatibleChat(
  config: ProviderConfig,
  messages: ChatMessage[],
  signal: AbortSignal
): AsyncGenerator<string> {
  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      temperature: 0.7
    }),
    signal
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Provider request failed with ${response.status}: ${body || response.statusText}`
    );
  }

  const reader = response.body.getReader();
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
      const chunk = parseStreamLine(line);
      if (chunk) {
        yield chunk;
      }
    }
  }
}

function parseStreamLine(line: string) {
  const trimmed = line.trim();

  if (!trimmed || !trimmed.startsWith("data:")) {
    return "";
  }

  const data = trimmed.slice("data:".length).trim();

  if (data === "[DONE]") {
    return "";
  }

  try {
    const parsed = JSON.parse(data);
    return parsed.choices?.[0]?.delta?.content ?? "";
  } catch {
    return "";
  }
}

export async function discoverOpenAICompatibleModels(
  provider: {
    baseUrl: string;
    apiKey: string;
  },
  capabilitiesForModel?: ModelCapabilityResolver
) {
  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: {
      authorization: `Bearer ${provider.apiKey}`
    }
  });

  return parseModelDiscoveryResponse(response, capabilitiesForModel);
}

export async function parseModelDiscoveryResponse(
  response: Response,
  capabilitiesForModel: ModelCapabilityResolver = () => ({})
) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Model discovery failed with ${response.status}: ${text || response.statusText}`
    );
  }

  const body = await response.json().catch(() => undefined);
  const data =
    body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  const models = data
    .map((model) => normalizeDiscoveredModel(model, capabilitiesForModel))
    .filter((model): model is DiscoveredModel => Boolean(model));

  if (models.length === 0) {
    throw new Error("No models were returned by the provider.");
  }

  return models;
}

function normalizeDiscoveredModel(
  model: unknown,
  capabilitiesForModel: ModelCapabilityResolver
) {
  if (!model || typeof model !== "object") {
    return undefined;
  }

  const candidate = model as Record<string, unknown>;
  const id = candidate.id;
  if (typeof id !== "string" || !id) {
    return undefined;
  }

  const label =
    typeof candidate.display_name === "string"
      ? candidate.display_name
      : typeof candidate.displayName === "string"
        ? candidate.displayName
        : typeof candidate.name === "string"
          ? candidate.name
          : id;

  return {
    id,
    label,
    capabilities: capabilitiesForModel(candidate),
    enabled: false
  };
}
