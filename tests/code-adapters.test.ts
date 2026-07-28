import { describe, expect, test } from "bun:test";
import type { HarnessCapabilities, HarnessId, HarnessInstallation } from "@lush/code";
import {
  ClaudeLineParser,
  CodexLineParser,
  OpenCodeLineParser
} from "../services/agent/src/code/adapters";
import { ClaudeAdapter } from "../services/agent/src/code/adapters/claude";
import { CodexAdapter } from "../services/agent/src/code/adapters/codex";
import { OpenCodeAdapter } from "../services/agent/src/code/adapters/opencode";
import { validateHelpSurface } from "../services/agent/src/code/adapters/shared";
import type { AdapterRunOptions, CodingHarnessAdapter } from "../services/agent/src/code/adapters/types";

async function parseFixture(
  fixture: string,
  parser: { parse(line: string): { externalSessionId?: string; events: Array<{ kind: string; data: unknown }> } }
) {
  const lines = (await Bun.file(`services/agent/fixtures/code/${fixture}`).text())
    .trim()
    .split("\n");
  const events: Array<{ kind: string; data: unknown }> = [];
  let sessionId: string | undefined;
  for (const line of lines) {
    const parsed = parser.parse(line);
    sessionId = parsed.externalSessionId ?? sessionId;
    events.push(...parsed.events);
  }
  return { events, sessionId };
}

const probeCapabilities: HarnessCapabilities = {
  approvals: "policy-only",
  steering: false,
  sessionFork: false,
  subagents: false,
  additionalWorkspaceRoots: false,
  autonomyModes: ["plan"],
  modelSelection: false,
  serviceTierSelection: false,
  reasoningStream: false,
  structuredDiffs: false,
  mcp: false,
  nativeSandbox: false
};

function installationFor(id: HarnessId, displayName: string): HarnessInstallation {
  return {
    id,
    displayName,
    transport: "structured-cli",
    // `true` exits 0 immediately, so the run settles without a real harness.
    executable: "/usr/bin/true",
    version: "1.2.3",
    status: "installed",
    capabilities: probeCapabilities
  };
}

/** Wraps an adapter so probe() is counted and never reaches a real CLI. */
function counting<T extends CodingHarnessAdapter>(adapter: T, installation: HarnessInstallation) {
  const counter = { probes: 0 };
  adapter.probe = () => {
    counter.probes += 1;
    return Promise.resolve(installation);
  };
  return counter;
}

async function settle(adapter: CodingHarnessAdapter, options: Partial<AdapterRunOptions> & { installation?: HarnessInstallation }) {
  const run = adapter.run({
    cwd: process.cwd(),
    prompt: "noop",
    autonomy: "plan",
    emit: () => {},
    ...options
  });
  // The binding never settles because `true` reports no session id; we only
  // care about how many times the adapter qualified the harness.
  await run.completed.catch(() => {});
  await run.binding.catch(() => {});
}

describe("Code adapter qualification reuse", () => {
  const adapters: Array<[string, () => CodingHarnessAdapter, HarnessId, string]> = [
    ["codex", () => new CodexAdapter(), "codex", "Codex"],
    ["claude-code", () => new ClaudeAdapter(), "claude-code", "Claude Code"],
    ["opencode", () => new OpenCodeAdapter(), "opencode", "OpenCode"]
  ];

  for (const [label, create, id, displayName] of adapters) {
    test(`${label} reuses the installation supplied by the caller instead of probing again`, async () => {
      const adapter = create();
      const installation = installationFor(id, displayName);
      const counter = counting(adapter, installation);

      await settle(adapter, { installation });

      // startSession already probed; run must not spend a second probe (two
      // more CLI invocations) re-establishing what it was handed.
      expect(counter.probes).toBe(0);
    });

    test(`${label} still probes when no installation is supplied`, async () => {
      const adapter = create();
      const counter = counting(adapter, installationFor(id, displayName));

      await settle(adapter, {});

      // Turns after the first have no fresh qualification to reuse, so the
      // adapter must still probe for itself.
      expect(counter.probes).toBe(1);
    });
  }
});

describe("Code adapter fixtures", () => {
  test("fails structural qualification when a required CLI surface disappears", () => {
    expect(validateHelpSurface("--json --sandbox", ["--json", "resume", "--sandbox"]))
      .toEqual(["resume"]);
    expect(validateHelpSurface("--json resume --sandbox", ["--json", "resume", "--sandbox"]))
      .toEqual([]);
  });
  test("normalizes Codex exec events", async () => {
    const result = await parseFixture("codex-exec.jsonl", new CodexLineParser());
    expect(result.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.events.map((event) => event.kind)).toEqual([
      "command.started",
      "command.completed",
      "message.delta",
      "usage.updated"
    ]);
    expect(result.events[2]?.data).toMatchObject({ delta: "Implemented the change." });
  });

  test("normalizes Claude deltas without duplicating the completed message", async () => {
    const result = await parseFixture("claude-stream.jsonl", new ClaudeLineParser());
    expect(result.sessionId).toBe("22222222-2222-4222-8222-222222222222");
    expect(result.events.filter((event) => event.kind === "message.delta")).toHaveLength(1);
    expect(result.events.map((event) => event.kind)).toContain("reasoning.delta");
    expect(result.events.map((event) => event.kind)).toContain("tool.started");
    expect(result.events.map((event) => event.kind)).toContain("tool.completed");
  });

  test("normalizes OpenCode tool, text, and usage parts", async () => {
    const result = await parseFixture("opencode-run.jsonl", new OpenCodeLineParser());
    expect(result.sessionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(result.events.map((event) => event.kind)).toEqual([
      "tool.started",
      "tool.completed",
      "message.delta",
      "usage.updated"
    ]);
  });
});
