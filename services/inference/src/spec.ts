export const inferenceTypes = `
export type WorkspaceMode = "chat" | "code" | "work" | "agents";

export type ModelDefaults = Record<WorkspaceMode, string>;

export type InferenceProviderKind =
  | "baseten"
  | "fireworks"
  | "anthropic"
  | "openai"
  | "openai-compatible";

export type InferenceModelInterface =
  | "chat-completions"
  | "messages"
  | "responses"
  | "embeddings";

export type InferenceModelInputModality =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "pdf";

export type InferenceModelOutputModality =
  | "text"
  | "image"
  | "audio"
  | "embedding";

export type InferenceModelFeature =
  | "tools"
  | "structured-output"
  | "reasoning"
  | "citations"
  | "code-execution"
  | "batch";

export type InferenceModelCapabilities = {
  interfaces?: InferenceModelInterface[];
  inputModalities?: InferenceModelInputModality[];
  outputModalities?: InferenceModelOutputModality[];
  features?: InferenceModelFeature[];
};

export type InferenceModelStatus = {
  id: string;
  label: string;
  capabilities: InferenceModelCapabilities;
  enabled: boolean;
};

export type InferenceProviderStatus = {
  id: string;
  kind: InferenceProviderKind;
  label: string;
  configured: boolean;
  enabled: boolean;
  baseUrl: string;
  models: InferenceModelStatus[];
};

export type InferenceConfig = {
  organizationId: string;
  modelDefaults: ModelDefaults;
  providers: InferenceProviderStatus[];
};

export type AddInferenceProviderRequest = {
  kind: InferenceProviderKind;
  label: string;
  apiKey: string;
  baseUrl?: string;
};

export type UpdateInferenceProviderRequest = {
  providerId: string;
  enabled: boolean;
};

export type RefreshInferenceProviderModelsRequest = {
  providerId: string;
};

export type UpdateInferenceModelRequest = {
  providerId: string;
  modelId: string;
  enabled: boolean;
};

export type DeleteInferenceProviderRequest = {
  providerId: string;
};

export type UpdateInferenceModelDefaultRequest = {
  mode: WorkspaceMode;
  modelSelection: string;
};
`;

export const inferenceRoutes = [
  {
    id: "fetchInferenceConfig",
    method: "GET",
    path: "/inference/config",
    responseType: "InferenceConfig",
    auth: true,
    kind: "json"
  },
  {
    id: "createInferenceProvider",
    method: "POST",
    path: "/inference/providers",
    requestType: "AddInferenceProviderRequest",
    responseType: "InferenceProviderStatus",
    auth: true,
    kind: "json"
  },
  {
    id: "updateInferenceProvider",
    method: "POST",
    path: "/inference/providers/update",
    requestType: "UpdateInferenceProviderRequest",
    responseType: "InferenceConfig",
    auth: true,
    kind: "json"
  },
  {
    id: "refreshInferenceProviderModels",
    method: "POST",
    path: "/inference/providers/refresh-models",
    requestType: "RefreshInferenceProviderModelsRequest",
    responseType: "InferenceConfig",
    auth: true,
    kind: "json"
  },
  {
    id: "updateInferenceModel",
    method: "POST",
    path: "/inference/models/update",
    requestType: "UpdateInferenceModelRequest",
    responseType: "InferenceConfig",
    auth: true,
    kind: "json"
  },
  {
    id: "deleteInferenceProvider",
    method: "POST",
    path: "/inference/providers/delete",
    requestType: "DeleteInferenceProviderRequest",
    responseType: "InferenceConfig",
    auth: true,
    kind: "json"
  },
  {
    id: "updateInferenceModelDefault",
    method: "POST",
    path: "/inference/model-defaults/update",
    requestType: "UpdateInferenceModelDefaultRequest",
    responseType: "InferenceConfig",
    auth: true,
    kind: "json"
  }
] as const;

export type InferenceRoute = (typeof inferenceRoutes)[number];
