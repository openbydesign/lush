import type { InferenceModelInterface } from "@lush/db/schema";
import type { ConnectedModel, ConnectedProvider } from "./runtime";

export type OpenAICompatibleEndpoint =
  | "chat/completions"
  | "responses"
  | "embeddings";

export type OpenAICompatibleModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

export type OpenAICompatibleModelList = {
  object: "list";
  data: OpenAICompatibleModel[];
};

type Fetch = typeof fetch;

const endpointInterfaces: Record<
  OpenAICompatibleEndpoint,
  InferenceModelInterface
> = {
  "chat/completions": "chat-completions",
  responses: "responses",
  embeddings: "embeddings"
};
const openAICompatibleInterfaces = new Set<InferenceModelInterface>(
  Object.values(endpointInterfaces)
);

const forwardedResponseHeaders = [
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-request-id",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens"
] as const;

export function openAICompatibleModelId(
  providerId: string,
  modelId: string
) {
  return `${providerId}:${modelId}`;
}

export function listOpenAICompatibleModels(
  providers: ConnectedProvider[]
): OpenAICompatibleModelList {
  return {
    object: "list",
    data: providers.flatMap((provider) =>
      provider.enabled
        ? provider.models
            .filter(
              (model) => model.enabled && modelHasOpenAICompatibleInterface(model)
            )
            .map((model) => ({
              id: openAICompatibleModelId(provider.id, model.id),
              object: "model" as const,
              created: 0,
              owned_by: provider.label
            }))
        : []
    )
  };
}

function modelHasOpenAICompatibleInterface(
  model: ConnectedProvider["models"][number]
) {
  const interfaces = model.capabilities.interfaces;
  return (
    !interfaces?.length ||
    interfaces.some((modelInterface) =>
      openAICompatibleInterfaces.has(modelInterface)
    )
  );
}

export function findOpenAICompatibleModel(
  providers: ConnectedProvider[],
  modelId: string
) {
  return listOpenAICompatibleModels(providers).data.find(
    (model) => model.id === modelId
  );
}

export function parseOpenAICompatibleRequest(request: unknown) {
  if (!isRecord(request) || typeof request.model !== "string" || !request.model) {
    throw new OpenAICompatibleApiError(
      "model is required",
      "invalid_request_error",
      "model",
      "invalid_model"
    );
  }

  return request as Record<string, unknown> & { model: string };
}

export function assertModelSupportsEndpoint(
  connectedModel: ConnectedModel,
  endpoint: OpenAICompatibleEndpoint
) {
  const model = connectedModel.provider.models.find(
    (candidate) => candidate.id === connectedModel.modelId
  );
  const interfaces = model?.capabilities.interfaces;

  // An omitted interface list means the provider did not supply capability
  // metadata. Let the provider make the authoritative compatibility decision.
  if (!interfaces?.length || interfaces.includes(endpointInterfaces[endpoint])) {
    return;
  }

  throw new OpenAICompatibleApiError(
    `Model '${openAICompatibleModelId(
      connectedModel.provider.id,
      connectedModel.modelId
    )}' does not support /v1/${endpoint}`,
    "invalid_request_error",
    "model",
    "model_not_supported"
  );
}

export async function proxyOpenAICompatibleRequest(options: {
  endpoint: OpenAICompatibleEndpoint;
  request: Record<string, unknown> & { model: string };
  connectedModel: ConnectedModel;
  signal: AbortSignal;
  fetch?: Fetch;
}) {
  assertModelSupportsEndpoint(options.connectedModel, options.endpoint);
  const provider = options.connectedModel.provider;
  const fetchProvider = options.fetch ?? fetch;
  let response: Response;

  try {
    response = await fetchProvider(`${provider.baseUrl}/${options.endpoint}`, {
      method: "POST",
      headers: {
        accept: options.request.stream
          ? "text/event-stream"
          : "application/json",
        authorization: `Bearer ${provider.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        ...options.request,
        model: options.connectedModel.modelId
      }),
      signal: options.signal
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw new OpenAICompatibleApiError(
      "The selected inference provider could not be reached",
      "api_error",
      null,
      "provider_unavailable",
      502,
      error
    );
  }

  const headers = new Headers();
  for (const name of forwardedResponseHeaders) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-lush-model", options.request.model);
  headers.set("x-lush-provider", provider.id);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export class OpenAICompatibleApiError extends Error {
  constructor(
    message: string,
    readonly type: "invalid_request_error" | "api_error",
    readonly param: string | null,
    readonly code: string,
    readonly status = 400,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
