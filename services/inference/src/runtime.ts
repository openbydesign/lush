import { requiredEnvValue } from "@lush/config/env";
import { getDb } from "@lush/db/client";
import type {
  InferenceModelCapabilities,
  InferenceProviderKind,
  InferenceProviderModelRow
} from "@lush/db/schema";
import { adapterForProvider } from "./providers";

export type InferenceChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type { InferenceProviderKind };

export type WorkspaceMode = "chat" | "code" | "work" | "agents";

export type ModelDefaults = Record<WorkspaceMode, string>;

export type InferenceProviderRequest = {
  kind: InferenceProviderKind;
  label: string;
  apiKey: string;
  baseUrl?: string;
};

export type ConnectedProvider = {
  id: string;
  kind: InferenceProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: Array<{
    id: string;
    label: string;
    capabilities: InferenceModelCapabilities;
    enabled: boolean;
  }>;
};

export type ConnectedModel = {
  provider: ConnectedProvider;
  modelId: string;
};

export type StreamInferenceChatOptions = {
  organizationId: string;
  modelSelection?: string;
  systemPrompt: string;
  messages: InferenceChatMessage[];
  signal: AbortSignal;
};

const workspaceModes: WorkspaceMode[] = ["chat", "code", "work", "agents"];
const emptyModelDefaults: ModelDefaults = {
  chat: "",
  code: "",
  work: "",
  agents: ""
};

const providerBaseUrls: Record<InferenceProviderKind, string> = {
  baseten: "https://inference.baseten.co/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  "openai-compatible": ""
};

export async function getInferenceConfig(organizationId: string) {
  const providers = await loadConnectedProviders(organizationId);
  const modelDefaults = await reconcileModelDefaults(
    organizationId,
    await getOrganizationModelDefaults(organizationId),
    providers
  );

  return {
    organizationId,
    modelDefaults,
    providers: providers.map(sanitizeProvider)
  };
}

export async function createInferenceProvider(
  organizationId: string,
  request: InferenceProviderRequest
) {
  const normalized = normalizeProviderRequest(request);
  if (!normalized) {
    throw new InferenceError("invalid_provider", "Invalid provider request");
  }

  const models = await discoverModels(normalized);
  const db = getDb();
  const now = new Date();

  const provider = await db.transaction().execute(async (trx) => {
    const providerRow = await trx
      .insertInto("inferenceProviders")
      .values({
        organizationId,
        kind: normalized.kind,
        label: normalized.label,
        baseUrl: normalized.baseUrl,
        encryptedApiKey: await encryptSecret(normalized.apiKey, {
          organizationId,
          kind: normalized.kind
        }),
        enabled: true,
        createdAt: now,
        updatedAt: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (models.length > 0) {
      await trx
        .insertInto("inferenceProviderModels")
        .values(
          models.map((model) => ({
            providerId: providerRow.id,
            modelId: model.id,
            label: model.label,
            capabilities: model.capabilities,
            enabled: model.enabled,
            createdAt: now,
            updatedAt: now
          }))
        )
        .execute();
    }

    return {
      id: providerRow.id,
      kind: providerRow.kind,
      label: providerRow.label,
      baseUrl: providerRow.baseUrl,
      apiKey: normalized.apiKey,
      enabled: providerRow.enabled,
      models
    };
  });

  await reconcileModelDefaults(
    organizationId,
    await getOrganizationModelDefaults(organizationId),
    await loadConnectedProviders(organizationId)
  );

  return sanitizeProvider(provider);
}

export async function updateInferenceProvider(
  organizationId: string,
  request: unknown
) {
  if (!isProviderUpdateRequest(request)) {
    throw new InferenceError("invalid_provider_update", "Invalid provider update");
  }

  const result = await getDb()
    .updateTable("inferenceProviders")
    .set({
      enabled: request.enabled,
      updatedAt: new Date()
    })
    .where("id", "=", request.providerId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new InferenceError("provider_not_found", "Provider was not found");
  }

  return getInferenceConfig(organizationId);
}

export async function refreshInferenceProviderModels(
  organizationId: string,
  request: unknown
) {
  if (!isProviderModelsRefreshRequest(request)) {
    throw new InferenceError(
      "invalid_provider_refresh",
      "Invalid provider refresh request"
    );
  }

  const provider = await findProvider(organizationId, request.providerId);
  const apiKey = await decryptSecret(provider.encryptedApiKey, {
    organizationId,
    kind: provider.kind
  });
  const models = await discoverModels({
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey
  });
  const now = new Date();

  await getDb().transaction().execute(async (trx) => {
    const staleModels = trx
      .deleteFrom("inferenceProviderModels")
      .where("providerId", "=", provider.id);

    if (models.length === 0) {
      await staleModels.execute();
    } else {
      await staleModels
        .where(
          "modelId",
          "not in",
          models.map((model) => model.id)
        )
        .execute();

      await trx
        .insertInto("inferenceProviderModels")
        .values(
          models.map((model) => ({
            providerId: provider.id,
            modelId: model.id,
            label: model.label,
            capabilities: model.capabilities,
            enabled: model.enabled,
            createdAt: now,
            updatedAt: now
          }))
        )
        .onConflict((oc) =>
          oc.columns(["providerId", "modelId"]).doUpdateSet((eb) => ({
            label: eb.ref("excluded.label"),
            capabilities: eb.ref("excluded.capabilities"),
            updatedAt: now
          }))
        )
        .execute();
    }
  });

  return getInferenceConfig(organizationId);
}

export async function updateInferenceModel(
  organizationId: string,
  request: unknown
) {
  if (!isModelUpdateRequest(request)) {
    throw new InferenceError("invalid_model_update", "Invalid model update");
  }

  await findProvider(organizationId, request.providerId);
  const result = await getDb()
    .updateTable("inferenceProviderModels")
    .set({
      enabled: request.enabled,
      updatedAt: new Date()
    })
    .where("providerId", "=", request.providerId)
    .where("modelId", "=", request.modelId)
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) === 0) {
    throw new InferenceError("model_not_found", "Model was not found");
  }

  return getInferenceConfig(organizationId);
}

export async function updateInferenceModelDefault(
  organizationId: string,
  request: unknown
) {
  if (!isModelDefaultUpdateRequest(request)) {
    throw new InferenceError(
      "invalid_model_default_update",
      "Invalid model default update"
    );
  }

  const providers = await loadConnectedProviders(organizationId);
  if (
    request.modelSelection &&
    !getAvailableModelSelections(providers).includes(request.modelSelection)
  ) {
    throw new InferenceError("model_not_enabled", "Model is not enabled");
  }

  const now = new Date();
  await getDb()
    .insertInto("inferenceModelDefaults")
    .values({
      organizationId,
      mode: request.mode,
      modelSelection: request.modelSelection,
      createdAt: now,
      updatedAt: now
    })
    .onConflict((oc) =>
      oc.columns(["organizationId", "mode"]).doUpdateSet({
        modelSelection: request.modelSelection,
        updatedAt: now
      })
    )
    .execute();

  return getInferenceConfig(organizationId);
}

export async function deleteInferenceProvider(
  organizationId: string,
  request: unknown
) {
  if (!isProviderDeleteRequest(request)) {
    throw new InferenceError("invalid_provider_delete", "Invalid provider delete");
  }

  const result = await getDb()
    .deleteFrom("inferenceProviders")
    .where("id", "=", request.providerId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();

  if (Number(result.numDeletedRows) === 0) {
    throw new InferenceError("provider_not_found", "Provider was not found");
  }

  return getInferenceConfig(organizationId);
}

export async function resolveConnectedModel(
  organizationId: string,
  modelSelection?: string
): Promise<ConnectedModel | undefined> {
  if (!modelSelection) {
    return undefined;
  }

  const separatorIndex = modelSelection.indexOf(":");
  if (separatorIndex === -1) {
    return undefined;
  }

  const providerId = modelSelection.slice(0, separatorIndex);
  const modelId = modelSelection.slice(separatorIndex + 1);
  const provider = (await loadConnectedProviders(organizationId, true)).find(
    (candidate) => candidate.id === providerId
  );

  if (!provider?.enabled) {
    return undefined;
  }

  if (!provider.models.some((model) => model.id === modelId && model.enabled)) {
    return undefined;
  }

  return {
    provider,
    modelId
  };
}

export async function* streamInferenceChat({
  organizationId,
  modelSelection,
  systemPrompt,
  messages,
  signal
}: StreamInferenceChatOptions) {
  const connectedModel = await resolveConnectedModel(organizationId, modelSelection);
  const chatMessages = [
    {
      role: "system" as const,
      content: systemPrompt
    },
    ...messages
  ];

  if (!connectedModel) {
    throw new InferenceError(
      "model_not_configured",
      "No enabled inference model is configured for this organization"
    );
  }

  yield* adapterForProvider(connectedModel.provider.kind).streamChat({
    kind: connectedModel.provider.kind,
    baseUrl: connectedModel.provider.baseUrl,
    apiKey: connectedModel.provider.apiKey,
    modelId: connectedModel.modelId,
    messages: chatMessages,
    signal
  });
}

export class InferenceError extends Error {
  readonly cause?: unknown;

  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    cause?: unknown
  ) {
    super(message);
    this.cause = cause;
  }
}

async function loadConnectedProviders(
  organizationId: string,
  includeApiKeys = false
): Promise<ConnectedProvider[]> {
  const db = getDb();
  const providerRows = await db
    .selectFrom("inferenceProviders")
    .selectAll()
    .where("organizationId", "=", organizationId)
    .orderBy("createdAt", "asc")
    .execute();

  if (providerRows.length === 0) {
    return [];
  }

  const providerIds = providerRows.map((provider) => provider.id);
  const modelRows = await db
    .selectFrom("inferenceProviderModels")
    .selectAll()
    .where("providerId", "in", providerIds)
    .orderBy("createdAt", "asc")
    .execute();
  const modelsByProvider = groupModelsByProvider(modelRows);

  return Promise.all(
    providerRows.map(async (provider) => ({
      id: provider.id,
      kind: provider.kind,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: includeApiKeys
        ? await decryptSecret(provider.encryptedApiKey, {
            organizationId,
            kind: provider.kind
          })
        : "",
      enabled: provider.enabled,
      models: modelsByProvider.get(provider.id) ?? []
    }))
  );
}

function groupModelsByProvider(modelRows: InferenceProviderModelRow[]) {
  const grouped = new Map<
    string,
    Array<{
      id: string;
      label: string;
      capabilities: InferenceModelCapabilities;
      enabled: boolean;
    }>
  >();

  for (const model of modelRows) {
    grouped.set(model.providerId, [
      ...(grouped.get(model.providerId) ?? []),
      {
        id: model.modelId,
        label: model.label,
        capabilities: model.capabilities,
        enabled: model.enabled
      }
    ]);
  }

  return grouped;
}

async function getOrganizationModelDefaults(
  organizationId: string
): Promise<ModelDefaults> {
  const rows = await getDb()
    .selectFrom("inferenceModelDefaults")
    .select(["mode", "modelSelection"])
    .where("organizationId", "=", organizationId)
    .execute();
  const defaults = { ...emptyModelDefaults };

  for (const row of rows) {
    defaults[row.mode] = row.modelSelection;
  }

  return defaults;
}

async function reconcileModelDefaults(
  organizationId: string,
  defaults: ModelDefaults,
  providers: ConnectedProvider[]
) {
  const availableSelections = getAvailableModelSelections(providers);
  const availableSelectionSet = new Set(availableSelections);
  const fallbackSelection = availableSelections[0] ?? "";
  const next = { ...defaults };
  let changed = false;

  for (const mode of workspaceModes) {
    const selection = next[mode];
    if (
      (selection && !availableSelectionSet.has(selection)) ||
      (!selection && fallbackSelection)
    ) {
      next[mode] = fallbackSelection;
      changed = true;
    }
  }

  if (changed) {
    const now = new Date();
    await getDb()
      .insertInto("inferenceModelDefaults")
      .values(
        workspaceModes.map((mode) => ({
          organizationId,
          mode,
          modelSelection: next[mode],
          createdAt: now,
          updatedAt: now
        }))
      )
      .onConflict((oc) =>
        oc.columns(["organizationId", "mode"]).doUpdateSet((eb) => ({
          modelSelection: eb.ref("excluded.modelSelection"),
          updatedAt: now
        }))
      )
      .execute();
  }

  return next;
}

async function findProvider(organizationId: string, providerId: string) {
  const provider = await getDb()
    .selectFrom("inferenceProviders")
    .selectAll()
    .where("id", "=", providerId)
    .where("organizationId", "=", organizationId)
    .executeTakeFirst();

  if (!provider) {
    throw new InferenceError("provider_not_found", "Provider was not found");
  }

  return provider;
}

function normalizeProviderRequest(request: InferenceProviderRequest) {
  const resolvedBaseUrl =
    request.baseUrl && request.baseUrl.trim()
      ? request.baseUrl.trim()
      : providerBaseUrls[request.kind];

  if (!request.label.trim() || !request.apiKey.trim() || !resolvedBaseUrl) {
    return undefined;
  }

  return {
    kind: request.kind,
    label: request.label.trim(),
    apiKey: request.apiKey.trim(),
    baseUrl: trimTrailingSlash(resolvedBaseUrl)
  };
}

async function discoverModels(provider: {
  kind: InferenceProviderKind;
  baseUrl: string;
  apiKey: string;
}) {
  try {
    return await adapterForProvider(provider.kind).discoverModels(provider);
  } catch (error) {
    throw new InferenceError(
      "model_discovery_failed",
      "Lush couldn't retrieve models from this provider. Check the API key and base URL, or try again shortly.",
      400,
      error
    );
  }
}

function sanitizeProvider(provider: ConnectedProvider) {
  return {
    id: provider.id,
    kind: provider.kind,
    label: provider.label,
    configured: true,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    models: provider.models
  };
}

function getAvailableModelSelections(providers: ConnectedProvider[]) {
  return providers.flatMap((provider) =>
    provider.enabled
      ? provider.models
          .filter((model) => model.enabled)
          .map((model) => `${provider.id}:${model.id}`)
      : []
  );
}

function isProviderUpdateRequest(
  request: unknown
): request is { providerId: string; enabled: boolean } {
  return (
    Boolean(request) &&
    typeof request === "object" &&
    typeof (request as { providerId?: unknown }).providerId === "string" &&
    typeof (request as { enabled?: unknown }).enabled === "boolean"
  );
}

function isProviderModelsRefreshRequest(
  request: unknown
): request is { providerId: string } {
  return (
    Boolean(request) &&
    typeof request === "object" &&
    typeof (request as { providerId?: unknown }).providerId === "string"
  );
}

function isModelUpdateRequest(
  request: unknown
): request is { providerId: string; modelId: string; enabled: boolean } {
  return (
    Boolean(request) &&
    typeof request === "object" &&
    typeof (request as { providerId?: unknown }).providerId === "string" &&
    typeof (request as { modelId?: unknown }).modelId === "string" &&
    typeof (request as { enabled?: unknown }).enabled === "boolean"
  );
}

function isProviderDeleteRequest(
  request: unknown
): request is { providerId: string } {
  return (
    Boolean(request) &&
    typeof request === "object" &&
    typeof (request as { providerId?: unknown }).providerId === "string"
  );
}

function isModelDefaultUpdateRequest(
  request: unknown
): request is { mode: WorkspaceMode; modelSelection: string } {
  return (
    Boolean(request) &&
    typeof request === "object" &&
    workspaceModes.includes((request as { mode?: WorkspaceMode }).mode as WorkspaceMode) &&
    typeof (request as { modelSelection?: unknown }).modelSelection === "string"
  );
}

async function encryptSecret(
  plaintext: string,
  context: Record<string, string>
) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  const key = await secretKey();
  const aad = new TextEncoder().encode(JSON.stringify(context));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    encoded
  );

  return JSON.stringify({
    v: 1,
    alg: "AES-GCM",
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertext))
  });
}

async function decryptSecret(
  encrypted: string,
  context: Record<string, string>
) {
  try {
    const payload = JSON.parse(encrypted) as {
      iv: string;
      ciphertext: string;
    };
    const key = await secretKey();
    const aad = new TextEncoder().encode(JSON.stringify(context));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: hexToBytes(payload.iv),
        additionalData: aad
      },
      key,
      hexToBytes(payload.ciphertext)
    );

    return new TextDecoder().decode(plaintext);
  } catch (error) {
    const provider = context.kind ? `${titleCase(context.kind)} ` : "";
    throw new InferenceError(
      "provider_credentials_unavailable",
      `Stored ${provider}provider credentials could not be decrypted. Remove and reconnect the provider in Inference settings.`,
      409
    );
  }
}

async function secretKey() {
  let configured: string;
  try {
    configured = requiredEnvValue("LUSH_SECRET_KEY");
  } catch {
    throw new InferenceError(
      "secret_key_missing",
      "LUSH_SECRET_KEY is required to encrypt inference provider credentials",
      500
    );
  }

  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(configured)
  );

  return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt"
  ]);
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
