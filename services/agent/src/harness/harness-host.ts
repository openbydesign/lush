/**
 * Harness host: the process entrypoint that runs inside an isolation boundary.
 *
 * The subprocess (and, later, container/microVM/remote-sandbox) providers boot
 * this script. It reads a single `HarnessStart` as one JSON payload on stdin,
 * runs the selected harness, and streams `HarnessResponse` frames as NDJSON on
 * stdout — the peer of `SubprocessHarness`. In a real sandbox image the harness
 * is baked in and selected by id; here we ship `echo` for the text path plus an
 * `env-probe` used to prove that host credentials are not visible inside the
 * boundary.
 */

import { envValue } from "@lush/config/env";
import { textMessage } from "./content";
import { brokeredLushHarness, echoHarness } from "./harnesses";
import type { Harness, HarnessResponse, HarnessStart } from "./protocol";

/**
 * Reports whether a sensitive host env var leaked into the sandbox. Reads go
 * through the config boundary; a scrubbed child sees `absent`.
 */
function envProbeHarness(): Harness {
  return {
    id: "env-probe",
    async *connect(): AsyncIterable<HarnessResponse> {
      const secret = envValue("LUSH_SECRET_KEY");
      yield {
        type: "outputs",
        messages: [textMessage("assistant", `secret:${secret ?? "absent"}`)]
      };
      yield { type: "end", state: "completed" };
    }
  };
}

/** Emits one output then blocks forever — used to test cancellation/timeout. */
function blockHarness(): Harness {
  return {
    id: "block",
    async *connect(): AsyncIterable<HarnessResponse> {
      yield {
        type: "outputs",
        messages: [textMessage("assistant", "blocking")]
      };
      // Keep an actual event-loop handle alive. A never-settling Promise alone
      // does not prevent Bun from exiting the subprocess.
      await new Promise<void>((resolve) => setTimeout(resolve, 86_400_000));
      yield { type: "end", state: "completed" };
    }
  };
}

function resolveHarness(id: string): Harness {
  switch (id) {
    case "env-probe":
      return envProbeHarness();
    case "block":
      return blockHarness();
    case "lush-brokered":
      return brokeredLushHarness();
    case "echo":
    default:
      return echoHarness(id || "echo");
  }
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    data += chunk.toString("utf8");
  }
  return data;
}

function write(frame: HarnessResponse): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function main(): Promise<void> {
  const harnessId = process.argv[2] ?? "echo";
  const raw = await readStdin();
  const start = JSON.parse(raw) as HarnessStart;
  const harness = resolveHarness(harnessId);
  const controller = new AbortController();

  for await (const frame of harness.connect(
    { harnessConfig: start.harnessConfig, messages: start.messages ?? [] },
    controller.signal
  )) {
    write(frame);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    // Always terminate the stream with an end frame so the parent can classify
    // the failure rather than seeing a truncated stream.
    write({
      type: "end",
      state: "failed",
      error: { code: 13, description: error instanceof Error ? error.message : String(error) }
    });
    process.exit(1);
  });
