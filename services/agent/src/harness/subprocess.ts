/**
 * Subprocess isolation provider — the first boundary-crossing provider.
 *
 * A harness runs in a child process reached over NDJSON on stdio: the parent
 * writes one `HarnessStart` line then half-closes stdin (mirroring AX's
 * `CloseSend` after a single Start), and reads `HarnessResponse` frames from the
 * child's stdout until an `end` frame. This exercises the exact serialization
 * and streaming a remote sandbox needs, so Cloudflare/Vercel/Substrate/microVM
 * providers become a change of transport, not of contract.
 *
 * What this provider DOES give: crash isolation (separate address space),
 * killability (cancel/timeout => SIGKILL), output/time bounds, and credential
 * scrubbing (the child inherits only an explicit env allowlist — no host
 * secrets). What it does NOT give: kernel/filesystem/network isolation. It is
 * therefore valid for local development and as the integration substrate, but a
 * production capability-enabled run requires an isolating provider (a real
 * sandbox), never this one and never in-process execution.
 *
 * This provider is stateless per turn: `harness().connect()` spawns a fresh
 * child each turn and `hibernate` is a no-op — there is no persistent compute to
 * resume. Session-bound persistence (a warm actor across runs) is a property of
 * the container/microVM/Substrate providers, not this one. Cancellation is
 * hard-kill only; a harness cannot observe a cooperative cancel before SIGKILL.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { envValue } from "@lush/config/env";
import type { Harness, HarnessResponse, HarnessStart } from "./protocol";
import {
  IsolationError,
  resolveLimits,
  type AgentEnvironmentHandle,
  type EnvironmentLimits,
  type EnvironmentSpec,
  type IsolationProvider
} from "./isolation";

const DEFAULT_HOST_SCRIPT = fileURLToPath(
  new URL("./harness-host.ts", import.meta.url)
);

/** Minimal env the child inherits. Deliberately excludes all host secrets. */
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG"];

export type SubprocessProviderOptions = {
  /** Executable that runs the host script. Defaults to the current runtime. */
  command?: string;
  /** Path to the harness host entrypoint. Defaults to the bundled host. */
  hostScriptPath?: string;
  /** Env var names the child may inherit. Everything else is stripped. */
  envAllowlist?: string[];
  limits?: Partial<EnvironmentLimits>;
};

export class SubprocessIsolationProvider implements IsolationProvider {
  readonly kind = "subprocess";
  private readonly environments = new Map<string, AgentEnvironmentHandle>();

  constructor(private readonly options: SubprocessProviderOptions = {}) {}

  async provision(spec: EnvironmentSpec): Promise<AgentEnvironmentHandle> {
    const id = crypto.randomUUID();
    const limits = resolveLimits({ ...spec, limits: { ...this.options.limits, ...spec.limits } });
    const command = this.options.command ?? process.execPath;
    const hostScript = this.options.hostScriptPath ?? DEFAULT_HOST_SCRIPT;
    const childEnv = scrubbedEnv(this.options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);

    // Per-environment empty ephemeral workspace. Running the child here (rather
    // than the repo root) gives it a clean cwd and, critically, prevents the
    // runtime from auto-loading repo dotenv files into the sandbox.
    const workspace = await mkdtemp(join(tmpdir(), "lush-env-"));

    const environment: AgentEnvironmentHandle = {
      id,
      kind: this.kind,
      spec,
      limits,
      harness: () =>
        new SubprocessHarness({
          id: spec.harnessId,
          command,
          args: [hostScript, spec.harnessId],
          env: childEnv,
          cwd: workspace,
          limits
        }),
      hibernate: async () => {},
      destroy: async () => {
        this.environments.delete(id);
        await rm(workspace, { recursive: true, force: true }).catch(() => {});
      }
    };
    this.environments.set(id, environment);
    return environment;
  }

  async resume(environmentId: string): Promise<AgentEnvironmentHandle> {
    const environment = this.environments.get(environmentId);
    if (!environment) {
      throw new IsolationError("environment_not_found", "Environment was not found");
    }
    return environment;
  }

  async hibernate(): Promise<void> {}

  async destroy(environmentId: string): Promise<void> {
    this.environments.delete(environmentId);
  }
}

export class SubprocessTimeoutError extends Error {
  readonly code = "harness_timeout";
  constructor(ms: number) {
    super(`Harness turn exceeded ${ms}ms`);
    this.name = "SubprocessTimeoutError";
  }
}

export class SubprocessOutputLimitError extends Error {
  readonly code = "harness_output_limit";
  constructor(bytes: number) {
    super(`Harness output exceeded ${bytes} bytes`);
    this.name = "SubprocessOutputLimitError";
  }
}

type SubprocessHarnessOptions = {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  limits: EnvironmentLimits;
};

class SubprocessHarness implements Harness {
  readonly id: string;
  constructor(private readonly options: SubprocessHarnessOptions) {
    this.id = options.id;
  }

  async *connect(
    request: HarnessStart,
    signal: AbortSignal
  ): AsyncIterable<HarnessResponse> {
    const child = spawn(this.options.command, this.options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.options.env,
      cwd: this.options.cwd
    });

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, this.options.limits.wallClockMs);

    const onAbort = () => child.kill("SIGKILL");
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // Surface async spawn/stdin errors (e.g. ENOENT, EPIPE) instead of crashing.
    let ioError: Error | null = null;
    child.on("error", (error) => {
      ioError = error;
    });
    child.stdin.on("error", () => {});

    try {
      child.stdin.write(
        `${JSON.stringify({
          type: "start",
          harnessConfig: request.harnessConfig,
          messages: request.messages
        })}\n`
      );
      child.stdin.end();

      let buffer = "";
      let bytes = 0;
      for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > this.options.limits.maxOutputBytes) {
          child.kill("SIGKILL");
          throw new SubprocessOutputLimitError(this.options.limits.maxOutputBytes);
        }
        buffer += chunk.toString("utf8");

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const frame = parseFrame(line);
            yield frame;
            if (frame.type === "end") {
              return;
            }
          }
          newline = buffer.indexOf("\n");
        }
      }

      // Classify a known teardown cause BEFORE trying to parse any trailing
      // bytes: a SIGKILL from cancel/timeout can truncate the final line, and a
      // partial line must not be misreported as a protocol error.
      if (signal.aborted) {
        throw new Error("harness canceled");
      }
      if (timedOut) {
        throw new SubprocessTimeoutError(this.options.limits.wallClockMs);
      }
      if (ioError) {
        throw ioError;
      }

      const tail = buffer.trim();
      if (tail) {
        const frame = parseFrame(tail);
        yield frame;
        if (frame.type === "end") {
          return;
        }
      }
      // Fall through: no end frame and no known cause -> orchestrator raises a
      // protocol error.
    } finally {
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }
}

function parseFrame(line: string): HarnessResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new IsolationError(
      "harness_protocol_error",
      `Harness emitted a non-JSON frame: ${line.slice(0, 200)}`
    );
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    ((parsed as { type?: unknown }).type === "outputs" ||
      (parsed as { type?: unknown }).type === "end")
  ) {
    return parsed as HarnessResponse;
  }
  throw new IsolationError(
    "harness_protocol_error",
    "Harness emitted a frame with an unknown type"
  );
}

/** Build the child env from an allowlist, reading through the config boundary. */
function scrubbedEnv(allowlist: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of allowlist) {
    const value = envValue(key);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
