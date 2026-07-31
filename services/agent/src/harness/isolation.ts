/**
 * Isolation provider abstraction.
 *
 * The AX-aligned `Harness` contract says *what* a turn looks like; an
 * `IsolationProvider` decides *where and how* that harness runs and how the
 * orchestrator reaches it. Keeping these separate is what makes isolation
 * switchable: the orchestrator only ever holds a `Harness`, never a process, a
 * container, or a remote sandbox handle.
 *
 * A provider provisions an `AgentEnvironmentHandle` and hands back a `Harness` bound
 * to that environment's boundary/transport. In AX terms the provider is the
 * compute layer (Substrate actors): it creates/resumes/suspends the isolated
 * actor; the `Harness` it returns speaks `HarnessService.Connect` over whatever
 * transport the boundary uses (in-process call, subprocess stdio, remote gRPC).
 *
 * Concrete providers (subprocess today; Cloudflare/Vercel sandboxes, Substrate,
 * gVisor/microVM later) implement this one interface. The contract is the
 * durable decision; the vendor is not.
 */

import type { Harness } from "./protocol";

export type EnvironmentProfile = "chat" | "code" | "work";

export type EnvironmentLimits = {
  /** Hard wall-clock ceiling for a single harness turn. */
  wallClockMs: number;
  /** Maximum bytes a turn may stream back before the boundary is torn down. */
  maxOutputBytes: number;
};

export const defaultEnvironmentLimits: EnvironmentLimits = {
  wallClockMs: 120_000,
  maxOutputBytes: 8_000_000
};

export type EnvironmentSpec = {
  profile: EnvironmentProfile;
  organizationId: string;
  ownerUserId: string;
  /** Durable conversation identity; one environment per session for code/work. */
  sessionId: string;
  /** The harness to run inside the environment (selects image/entrypoint). */
  harnessId: string;
  /** Opaque per-environment config baked in at provision time. */
  harnessConfig?: unknown;
  limits?: Partial<EnvironmentLimits>;
};

/**
 * A provisioned isolation boundary. `harness()` returns a `Harness` that runs a
 * turn inside this boundary. For ephemeral chat the environment is torn down
 * after the run; for session-bound code/work a provider MAY persist compute
 * across runs and honor hibernate/resume. Whether persistence is real is a
 * per-provider property: the `subprocess` provider is stateless-per-turn (a
 * fresh child per `connect()`, no-op hibernate), whereas a container/microVM or
 * Substrate provider can keep a warm actor between runs.
 */
export interface AgentEnvironmentHandle {
  readonly id: string;
  readonly kind: string;
  readonly spec: EnvironmentSpec;
  readonly limits: EnvironmentLimits;
  harness(): Harness;
  hibernate(): Promise<void>;
  destroy(): Promise<void>;
}

export interface IsolationProvider {
  readonly kind: string;
  provision(spec: EnvironmentSpec): Promise<AgentEnvironmentHandle>;
  /** Resume a previously hibernated, session-bound environment. */
  resume(environmentId: string): Promise<AgentEnvironmentHandle>;
  hibernate(environmentId: string): Promise<void>;
  destroy(environmentId: string): Promise<void>;
}

export class IsolationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "IsolationError";
  }
}

export function resolveLimits(spec: EnvironmentSpec): EnvironmentLimits {
  return {
    wallClockMs: spec.limits?.wallClockMs ?? defaultEnvironmentLimits.wallClockMs,
    maxOutputBytes:
      spec.limits?.maxOutputBytes ?? defaultEnvironmentLimits.maxOutputBytes
  };
}
