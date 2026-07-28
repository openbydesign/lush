export const modelDiscoveryErrorMessage =
  "Lush couldn't retrieve models from this provider. Check the API key and base URL, or try again shortly.";

const inferenceErrorMessages: Record<string, string> = {
  invalid_provider: "Enter a provider name, API key, and valid base URL.",
  model_discovery_failed: modelDiscoveryErrorMessage,
  provider_not_found: "This provider no longer exists. Reload and try again.",
  provider_credentials_unavailable:
    "Stored provider credentials are unavailable. Reconnect the provider and try again.",
  secret_key_missing:
    "Provider credentials are unavailable. Contact your Lush administrator.",
  model_not_found:
    "This model is no longer available. Refresh the provider models and try again.",
  model_not_enabled: "Enable this model before setting it as a default."
};

export function inferenceProviderErrorMessage(
  error: unknown,
  fallback: string
) {
  if (!isApiError(error)) {
    return fallback;
  }

  try {
    const body = JSON.parse(error.details) as { error?: unknown };
    return typeof body.error === "string"
      ? inferenceErrorMessages[body.error] ?? fallback
      : fallback;
  } catch {
    return fallback;
  }
}

function isApiError(error: unknown): error is { details: string } {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    typeof (error as { details?: unknown }).details === "string"
  );
}
