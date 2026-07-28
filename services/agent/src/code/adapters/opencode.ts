import type { AutonomyMode, HarnessCapabilities, HarnessEventInput } from "@lush/code";
import { number, parseJsonLine, probeHarness, record, resolveInstallation, runStructuredAdapter, text } from "./shared";
import type { AdapterRunOptions, CodingHarnessAdapter, HarnessLineParser } from "./types";

const capabilities: HarnessCapabilities = {
  approvals: "policy-only", steering: false, sessionFork: true, subagents: true,
  additionalWorkspaceRoots: false, autonomyModes: ["manual"], modelSelection: true,
  serviceTierSelection: false, reasoningStream: true, structuredDiffs: false,
  mcp: true, nativeSandbox: false
};

export class OpenCodeAdapter implements CodingHarnessAdapter {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  effectiveAutonomy(_requested: AutonomyMode): AutonomyMode { return "manual"; }
  probe() {
    return probeHarness({
      id: this.id,
      displayName: this.displayName,
      command: "opencode",
      capabilities,
      probeArguments: ["run", "--help"],
      requiredHelpTokens: ["--format", "--session", "--dir"]
    });
  }

  run(options: AdapterRunOptions) {
    let interrupt = () => {};
    const deferred = resolveInstallation(options, () => this.probe()).then((installation) => {
      if (installation.status !== "installed" || !installation.executable || !installation.version) {
        throw new Error(installation.detail ?? "OpenCode is unavailable");
      }
      const command = [installation.executable, "run", "--format", "json", "--dir", options.cwd,
        ...(options.binding ? ["--session", options.binding.externalSessionId] : []),
        ...(options.model ? ["--model", options.model] : []), options.prompt];
      const run = runStructuredAdapter({ adapterId: this.id, executable: installation.executable, version: installation.version, command, run: options, parser: new OpenCodeLineParser() });
      interrupt = run.interrupt;
      return run;
    });
    return { binding: deferred.then((run) => run.binding), completed: deferred.then((run) => run.completed), interrupt: () => interrupt() };
  }
}

export class OpenCodeLineParser implements HarnessLineParser {
  parse(line: string) {
    const payload = parseJsonLine(line);
    const part = record(payload.part);
    const state = record(part.state);
    const type = text(payload.type) ?? text(part.type);
    const externalSessionId = text(payload.sessionID) ?? text(payload.session_id);
    const events: HarnessEventInput[] = [];
    const id = text(part.id) ?? text(part.callID) ?? crypto.randomUUID();

    if ((type === "text" || text(part.type) === "text") && text(part.text)) {
      events.push({ kind: "message.delta", data: { messageId: id, role: "assistant", format: "markdown", delta: text(part.text)! } });
    } else if (type === "reasoning" || text(part.type) === "reasoning") {
      const value = text(part.text);
      if (value) events.push({ kind: "reasoning.delta", data: { blockId: id, visibility: "native", delta: value } });
    } else if (type === "tool_use" || text(part.type) === "tool") {
      const status = text(state.status) ?? "running";
      events.push({
        kind: status === "running" || status === "pending" ? "tool.started" : "tool.completed",
        data: {
          toolCallId: id,
          name: text(part.tool) ?? "Tool",
          status: status === "failed" || status === "error" ? "failed" : status === "running" || status === "pending" ? "running" : "completed",
          input: state.input,
          output: text(state.output),
          error: text(state.error)
        }
      });
    } else if (type === "step_finish") {
      const tokens = record(part.tokens);
      events.push({ kind: "usage.updated", data: { inputTokens: number(tokens.input), outputTokens: number(tokens.output), cachedInputTokens: number(record(tokens.cache).read), costUsd: number(part.cost) } });
    } else if (type === "error") {
      const error = record(payload.error);
      const errorData = record(error.data);
      const reference = text(errorData.ref);
      const message = text(payload.message) ?? text(error.message) ?? text(errorData.message) ?? "OpenCode failed";
      events.push({ kind: "diagnostic", data: { level: "error", message: reference ? `${message} (${reference})` : message } });
    }
    return { externalSessionId, events };
  }
}
