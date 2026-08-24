import type { ActiveExecutionClock, AgentEnvironmentHandle, EnvironmentLimits, EnvironmentSpec, IsolationProvider } from "./isolation";
import { IsolationError, resolveLimits } from "./isolation";
import {
  parseHarnessResponse,
  type Harness,
  type HarnessResponse,
  type HarnessStart
} from "./protocol";

type Fetch = typeof fetch;

export type RemoteIsolationProviderOptions = {
  baseUrl: string;
  apiToken: string;
  fetch?: Fetch;
  activeExecutionClock?: ActiveExecutionClock;
};

export class RemoteIsolationTimeoutError extends Error {
  readonly code = "harness_timeout";
  constructor(readonly timeoutMs: number) {
    super(`Remote harness turn exceeded ${Math.ceil(timeoutMs / 1_000)} seconds`);
    this.name = "RemoteIsolationTimeoutError";
  }
}

export class RemoteIsolationOutputLimitError extends Error {
  readonly code = "harness_output_limit";
  constructor(readonly maxOutputBytes: number) {
    super(`Remote harness output exceeded ${maxOutputBytes} bytes`);
    this.name = "RemoteIsolationOutputLimitError";
  }
}

export class RemoteIsolationProvider implements IsolationProvider {
  readonly kind = "remote";
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  private readonly environments = new Map<string, AgentEnvironmentHandle>();

  constructor(private readonly options: RemoteIsolationProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    if (options.apiToken.length < 32) {
      throw new IsolationError(
        "invalid_remote_isolation_config",
        "Remote isolation API token must contain at least 32 characters"
      );
    }
    this.fetch = options.fetch ?? fetch;
  }

  async provision(spec: EnvironmentSpec): Promise<AgentEnvironmentHandle> {
    const limits = resolveLimits(spec);
    const response = await this.request(
      `/v1/environments/${encodeURIComponent(spec.environmentId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: spec.profile,
          organizationId: spec.organizationId,
          ownerUserId: spec.ownerUserId,
          sessionId: spec.sessionId,
          harnessId: spec.harnessId,
          limits
        })
      }
    );
    if (!response.ok) throw await remoteError("provision", response);
    const result = await response.json().catch(() => undefined) as
      | { id?: unknown }
      | undefined;
    if (typeof result?.id !== "string" || result.id !== spec.environmentId) {
      throw new IsolationError(
        "remote_isolation_protocol_error",
        "Remote isolation service returned an invalid environment identity"
      );
    }

    const environment = this.environment(spec, limits);
    this.environments.set(environment.id, environment);
    return environment;
  }

  async resume(environmentId: string): Promise<AgentEnvironmentHandle> {
    const environment = this.environments.get(environmentId);
    if (!environment) {
      throw new IsolationError(
        "environment_not_found",
        "Remote environment metadata is unavailable in this executor"
      );
    }
    const response = await this.request(
      `/v1/environments/${encodeURIComponent(environmentId)}`,
      { method: "POST" }
    );
    if (!response.ok) throw await remoteError("resume", response);
    return environment;
  }

  async hibernate(environmentId: string): Promise<void> {
    const response = await this.request(
      `/v1/environments/${encodeURIComponent(environmentId)}/hibernate`,
      { method: "POST" }
    );
    if (!response.ok) throw await remoteError("hibernate", response);
  }

  async destroy(environmentId: string): Promise<void> {
    const response = await this.request(
      `/v1/environments/${encodeURIComponent(environmentId)}`,
      { method: "DELETE" }
    );
    if (!response.ok && response.status !== 404) {
      throw await remoteError("destroy", response);
    }
    this.environments.delete(environmentId);
  }

  private environment(
    spec: EnvironmentSpec,
    limits: EnvironmentLimits
  ): AgentEnvironmentHandle {
    const provider = this;
    return {
      id: spec.environmentId,
      kind: this.kind,
      spec,
      limits,
      harness: () => new RemoteHarness({
        id: spec.harnessId,
        environmentId: spec.environmentId,
        limits,
        baseUrl: this.baseUrl,
        apiToken: this.options.apiToken,
        fetch: this.fetch,
        activeExecutionClock: this.options.activeExecutionClock
      }),
      hibernate: () => provider.hibernate(spec.environmentId),
      destroy: () => provider.destroy(spec.environmentId)
    };
  }

  private request(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.apiToken}`);
    return this.fetch(`${this.baseUrl}${path}`, { ...init, headers });
  }
}

type RemoteHarnessOptions = {
  id: string;
  environmentId: string;
  limits: EnvironmentLimits;
  baseUrl: string;
  apiToken: string;
  fetch: Fetch;
  activeExecutionClock?: ActiveExecutionClock;
};

class RemoteHarness implements Harness {
  readonly id: string;

  constructor(private readonly options: RemoteHarnessOptions) {
    this.id = options.id;
  }

  async *connect(
    request: HarnessStart,
    signal: AbortSignal
  ): AsyncIterable<HarnessResponse> {
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    const stopClock = activeTimeout(
      this.options.limits.wallClockMs,
      timeout,
      this.options.activeExecutionClock
    );
    let bytes = 0;
    let buffer = "";
    const decoder = new TextDecoder();

    try {
      const response = await this.options.fetch(
        `${this.options.baseUrl}/v1/environments/${encodeURIComponent(
          this.options.environmentId
        )}/turns/${crypto.randomUUID()}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.apiToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            harnessId: this.id,
            start: {
              type: "start",
              harnessConfig: request.harnessConfig,
              messages: request.messages
            },
            maxOutputBytes: this.options.limits.maxOutputBytes
          }),
          signal: combined
        }
      );
      if (!response.ok || !response.body) {
        throw await remoteError("execute", response);
      }

      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > this.options.limits.maxOutputBytes) {
          timeout.abort(new RemoteIsolationOutputLimitError(
            this.options.limits.maxOutputBytes
          ));
          throw timeout.signal.reason;
        }
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const frame = parseRemoteFrame(line);
            yield frame;
            if (frame.type === "end") return;
          }
          newline = buffer.indexOf("\n");
        }
      }

      if (signal.aborted) throw abortReason(signal);
      if (timeout.signal.aborted) throw timeout.signal.reason;
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail) yield parseRemoteFrame(tail);
    } catch (error) {
      if (timeout.signal.aborted) throw timeout.signal.reason;
      if (signal.aborted) throw abortReason(signal);
      throw error;
    } finally {
      stopClock();
    }
  }
}

function activeTimeout(
  timeoutMs: number,
  controller: AbortController,
  clock: ActiveExecutionClock | undefined
) {
  let remaining = timeoutMs;
  let activeSince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pause = () => {
    if (activeSince !== undefined) {
      remaining = Math.max(0, remaining - (performance.now() - activeSince));
      activeSince = undefined;
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const resume = () => {
    if (timer || activeSince !== undefined || controller.signal.aborted) return;
    if (remaining <= 0) {
      controller.abort(new RemoteIsolationTimeoutError(timeoutMs));
      return;
    }
    activeSince = performance.now();
    timer = setTimeout(
      () => controller.abort(new RemoteIsolationTimeoutError(timeoutMs)),
      remaining
    );
  };
  const unsubscribe = clock?.subscribe((paused) => paused ? pause() : resume());
  if (!clock?.paused) resume();
  return () => {
    pause();
    unsubscribe?.();
  };
}

function parseRemoteFrame(line: string) {
  try {
    return parseHarnessResponse(line);
  } catch (error) {
    throw new IsolationError(
      "harness_protocol_error",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function normalizeBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IsolationError(
      "invalid_remote_isolation_config",
      "Remote isolation URL must be a valid URL"
    );
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new IsolationError(
      "invalid_remote_isolation_config",
      "Remote isolation URL must use HTTPS outside loopback development"
    );
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function remoteError(operation: string, response: Response) {
  const body = (await response.text().catch(() => "")).slice(0, 512);
  return new IsolationError(
    `remote_${operation}_failed`,
    `Remote isolation ${operation} failed (${response.status})${
      body ? `: ${body}` : ""
    }`
  );
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Remote harness was cancelled");
}
