import { describe, expect, test } from "bun:test";
import {
  inferenceProviderErrorMessage,
  modelDiscoveryErrorMessage
} from "../apps/lush/src/lib/inference-provider-error";

describe("inference provider errors", () => {
  test("replaces upstream model discovery details with an end-user message", () => {
    const error = {
      details: JSON.stringify({
        error: "model_discovery_failed",
        message: "Model discovery failed with 502: <html>Server Error</html>"
      })
    };

    expect(
      inferenceProviderErrorMessage(error, "Unable to add provider.")
    ).toBe(modelDiscoveryErrorMessage);
  });

  test("does not expose unexpected error details", () => {
    const error = new Error("database connection string");

    expect(
      inferenceProviderErrorMessage(error, "Unable to refresh provider models.")
    ).toBe("Unable to refresh provider models.");
  });
});
