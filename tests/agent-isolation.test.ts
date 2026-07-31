import { describe, expect, test } from "bun:test";
import {
  InFlightRegistry,
  InMemoryEventLog,
  SubprocessIsolationProvider,
  runExec,
  textMessage,
  type EnvironmentSpec,
  type ExecResponse
} from "../services/agent/src/harness";

const signal = () => new AbortController().signal;

async function collect(gen: AsyncGenerator<ExecResponse>): Promise<ExecResponse[]> {
  const frames: ExecResponse[] = [];
  for await (const frame of gen) frames.push(frame);
  return frames;
}

const baseSpec = (overrides: Partial<EnvironmentSpec> = {}): EnvironmentSpec => ({
  profile: "chat",
  organizationId: "org",
  ownerUserId: "user",
  sessionId: "conv-1",
  harnessId: "echo",
  ...overrides
});

describe("SubprocessIsolationProvider", () => {
  // Real child processes crossing the boundary; give them room.
  const provider = new SubprocessIsolationProvider();

  test("runs a harness in a child process over NDJSON and streams frames back", async () => {
    const environment = await provider.provision(baseSpec({ harnessId: "echo" }));
    expect(environment.kind).toBe("subprocess");

    const log = new InMemoryEventLog();
    const frames = await collect(
      runExec({
        request: { conversationId: "conv-echo", inputs: [textMessage("user", "over ipc")] },
        log,
        harness: environment.harness(),
        inFlight: new InFlightRegistry(),
        signal: signal()
      })
    );
    expect(frames.at(-1)!.outputs).toEqual([textMessage("assistant", "echo: over ipc")]);
    expect((await log.events("conv-echo")).at(-1)!.state).toBe("completed");
    await environment.destroy();
  }, 20_000);

  test("does not leak host credentials into the sandbox", async () => {
    process.env.LUSH_SECRET_KEY = "leaked-secret-value";

    // Default allowlist scrubs the secret.
    const scrubbed = await provider.provision(baseSpec({ harnessId: "env-probe" }));
    const scrubbedFrames = await collect(
      runExec({
        request: { conversationId: "conv-scrub", inputs: [textMessage("user", "probe")] },
        log: new InMemoryEventLog(),
        harness: scrubbed.harness(),
        inFlight: new InFlightRegistry(),
        signal: signal()
      })
    );
    expect(textOf(scrubbedFrames)).toContain("secret:absent");

    // A provider that explicitly allowlists the var CAN see it — proving the
    // probe works and that scrubbing is what hides it by default.
    const permissive = new SubprocessIsolationProvider({
      envAllowlist: ["PATH", "HOME", "LUSH_SECRET_KEY"]
    });
    const exposed = await permissive.provision(baseSpec({ harnessId: "env-probe" }));
    const exposedFrames = await collect(
      runExec({
        request: { conversationId: "conv-exposed", inputs: [textMessage("user", "probe")] },
        log: new InMemoryEventLog(),
        harness: exposed.harness(),
        inFlight: new InFlightRegistry(),
        signal: signal()
      })
    );
    expect(textOf(exposedFrames)).toContain("secret:leaked-secret-value");
  }, 20_000);

  test("cancellation kills the child and records a canceled turn", async () => {
    const environment = await provider.provision(
      baseSpec({ harnessId: "block", sessionId: "conv-cancel", limits: { wallClockMs: 5_000 } })
    );
    const log = new InMemoryEventLog();
    const controller = new AbortController();
    const gen = runExec({
      request: { conversationId: "conv-cancel", inputs: [textMessage("user", "go")] },
      log,
      harness: environment.harness(),
      inFlight: new InFlightRegistry(),
      signal: controller.signal
    });

    const first = await gen.next();
    expect(first.value).toEqual({ outputs: [textMessage("assistant", "blocking")], step: 2 });
    controller.abort();
    const second = await gen.next();
    expect(second.done).toBe(true);
    expect((await log.events("conv-cancel")).at(-1)!.state).toBe("canceled");
  }, 20_000);

  test("enforces the wall-clock bound", async () => {
    const environment = await provider.provision(
      baseSpec({ harnessId: "block", sessionId: "conv-timeout", limits: { wallClockMs: 300 } })
    );
    const log = new InMemoryEventLog();
    await expect(
      collect(
        runExec({
          request: { conversationId: "conv-timeout", inputs: [textMessage("user", "go")] },
          log,
          harness: environment.harness(),
          inFlight: new InFlightRegistry(),
          signal: signal()
        })
      )
    ).rejects.toThrow();
    expect((await log.events("conv-timeout")).at(-1)!.state).toBe("failed");
  }, 20_000);
});

function textOf(frames: ExecResponse[]): string {
  return frames
    .flatMap((frame) => frame.outputs)
    .map((message) => (message.content.type === "text" ? message.content.text : ""))
    .join(" ");
}
