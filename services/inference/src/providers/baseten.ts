import type { InferenceModelCapabilities } from "@lush/db/schema";
import {
  discoverOpenAICompatibleModels,
  streamOpenAICompatibleChat
} from "../openai-compatible";
import type {
  InferenceProviderAdapter,
  ProviderConnection,
  StreamProviderChatOptions
} from "./types";

export const basetenModelApiCapabilities: InferenceModelCapabilities = {
  interfaces: ["chat-completions", "messages"],
  inputModalities: ["text"],
  outputModalities: ["text"],
  features: ["tools", "structured-output"]
};

export const basetenAdapter: InferenceProviderAdapter = {
  discoverModels(provider: ProviderConnection) {
    return discoverOpenAICompatibleModels(
      provider,
      () => basetenModelApiCapabilities
    );
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
