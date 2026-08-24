import {
  ConfigError,
  currentEnv,
  envValue,
  type EnvSource
} from "@lush/config/env";
import type { ActiveExecutionClock, IsolationProvider } from "./isolation";
import { RemoteIsolationProvider } from "./remote";
import { SubprocessIsolationProvider } from "./subprocess";

export type IsolationProviderKind = "subprocess" | "remote";

export type IsolationRuntimeConfig =
  | { kind: "subprocess"; imageDigest: string }
  | {
      kind: "remote";
      imageDigest: string;
      sandboxBrokerBaseUrl: string;
      sandboxControlUrl: string;
      sandboxControlToken: string;
    };

export function configuredIsolationRuntime(
  env: EnvSource = currentEnv()
): IsolationRuntimeConfig {
  const kind = envValue("LUSH_ISOLATION_PROVIDER", env) ?? "subprocess";
  if (kind === "subprocess") {
    return { kind, imageDigest: "builtin:lush" };
  }
  if (kind !== "remote") {
    throw new ConfigError(
      "LUSH_ISOLATION_PROVIDER must be one of: subprocess, remote",
      { invalid: ["LUSH_ISOLATION_PROVIDER"] }
    );
  }

  const imageDigest = envValue("LUSH_SANDBOX_IMAGE_DIGEST", env);
  const sandboxBrokerBaseUrl = envValue("LUSH_SANDBOX_BROKER_BASE_URL", env);
  const sandboxControlUrl = envValue("LUSH_SANDBOX_CONTROL_URL", env);
  const sandboxControlToken = envValue("LUSH_SANDBOX_CONTROL_TOKEN", env);
  const required: Array<[string, string | undefined]> = [
    ["LUSH_SANDBOX_CONTROL_URL", sandboxControlUrl],
    ["LUSH_SANDBOX_CONTROL_TOKEN", sandboxControlToken],
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
  assertHttpsUrl("LUSH_SANDBOX_CONTROL_URL", sandboxControlUrl!);
  if (sandboxControlToken!.length < 32) {
    throw new ConfigError(
      "LUSH_SANDBOX_CONTROL_TOKEN must contain at least 32 characters",
      { invalid: ["LUSH_SANDBOX_CONTROL_TOKEN"] }
    );
  }
  assertHttpsUrl("LUSH_SANDBOX_BROKER_BASE_URL", sandboxBrokerBaseUrl!);
  return {
    kind,
    imageDigest: imageDigest!,
    sandboxBrokerBaseUrl: sandboxBrokerBaseUrl!,
    sandboxControlUrl: sandboxControlUrl!,
    sandboxControlToken: sandboxControlToken!
  };
}

export function createIsolationProvider(
  runtime: IsolationRuntimeConfig,
  options: { activeExecutionClock?: ActiveExecutionClock } = {}
): IsolationProvider {
  if (runtime.kind === "subprocess") {
    return new SubprocessIsolationProvider(options);
  }
  return new RemoteIsolationProvider({
    baseUrl: runtime.sandboxControlUrl,
    apiToken: runtime.sandboxControlToken,
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
