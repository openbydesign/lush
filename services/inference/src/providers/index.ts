import type { InferenceProviderKind } from "@lush/db/schema";
import { anthropicAdapter } from "./anthropic";
import { basetenAdapter } from "./baseten";
import { fireworksAdapter } from "./fireworks";
import { openAIAdapter } from "./openai";
import { openAICompatibleAdapter } from "./openai-compatible";
import type { InferenceProviderAdapter } from "./types";

const adapters: Record<InferenceProviderKind, InferenceProviderAdapter> = {
  anthropic: anthropicAdapter,
  baseten: basetenAdapter,
  fireworks: fireworksAdapter,
  openai: openAIAdapter,
  "openai-compatible": openAICompatibleAdapter
};

export function adapterForProvider(kind: InferenceProviderKind) {
  return adapters[kind];
}

export type {
  InferenceProviderAdapter,
  ProviderConnection,
  StreamProviderChatOptions
} from "./types";
