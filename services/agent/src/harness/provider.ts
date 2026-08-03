import { ConfigError, envValue } from "@lush/config/env";
import type { ActiveExecutionClock, IsolationProvider } from "./isolation";
import { RemoteIsolationProvider } from "./remote";
import { SubprocessIsolationProvider } from "./subprocess";

export type IsolationProviderKind = "subprocess" | "remote";

export type IsolationRuntimeConfig = {
  kind: IsolationProviderKind;
  imageDigest: string;
  sandboxBrokerBaseUrl?: string;
};

export function configuredIsolationRuntime(): IsolationRuntimeConfig {
  const kind = envValue("LUSH_ISOLATION_PROVIDER") ?? "subprocess";
  if (kind === "subprocess") {
    return { kind, imageDigest: "builtin:lush" };
  }
  if (kind !== "remote") {
    throw new ConfigError(
      "LUSH_ISOLATION_PROVIDER must be one of: subprocess, remote",
      { invalid: ["LUSH_ISOLATION_PROVIDER"] }
    );
  }

  const imageDigest = envValue("LUSH_SANDBOX_IMAGE_DIGEST");
  const sandboxBrokerBaseUrl = envValue("LUSH_SANDBOX_BROKER_BASE_URL");
  const required: Array<[string, string | undefined]> = [
    ["LUSH_SANDBOX_CONTROL_URL", envValue("LUSH_SANDBOX_CONTROL_URL")],
    ["LUSH_SANDBOX_CONTROL_TOKEN", envValue("LUSH_SANDBOX_CONTROL_TOKEN")],
    ["LUSH_SANDBOX_IMAGE_DIGEST", imageDigest],
    ["LUSH_SANDBOX_BROKER_BASE_URL", sandboxBrokerBaseUrl]
  ];
  const missing = required
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(", ")}`,
      { missing }
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest!)) {
    throw new ConfigError("LUSH_SANDBOX_IMAGE_DIGEST must be an immutable SHA-256 digest", {
      invalid: ["LUSH_SANDBOX_IMAGE_DIGEST"]
    });
  }
  assertHttpsUrl("LUSH_SANDBOX_BROKER_BASE_URL", sandboxBrokerBaseUrl!);
  return { kind, imageDigest: imageDigest!, sandboxBrokerBaseUrl };
}

export function createIsolationProvider(
  kind: IsolationProviderKind,
  options: { activeExecutionClock?: ActiveExecutionClock } = {}
): IsolationProvider {
  if (kind === "subprocess") {
    return new SubprocessIsolationProvider(options);
  }
  const baseUrl = envValue("LUSH_SANDBOX_CONTROL_URL");
  const apiToken = envValue("LUSH_SANDBOX_CONTROL_TOKEN");
  if (!baseUrl || !apiToken) {
    throw new ConfigError(
      "Remote isolation requires LUSH_SANDBOX_CONTROL_URL and LUSH_SANDBOX_CONTROL_TOKEN",
      { missing: [
        ...(!baseUrl ? ["LUSH_SANDBOX_CONTROL_URL"] : []),
        ...(!apiToken ? ["LUSH_SANDBOX_CONTROL_TOKEN"] : [])
      ] }
    );
  }
  return new RemoteIsolationProvider({
    baseUrl,
    apiToken,
    activeExecutionClock: options.activeExecutionClock
  });
}

function assertHttpsUrl(name: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid URL`, { invalid: [name] });
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new ConfigError(`${name} must use HTTPS outside loopback development`, {
      invalid: [name]
    });
  }
}
