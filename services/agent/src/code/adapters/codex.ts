import type { AutonomyMode, HarnessCapabilities, HarnessEventInput } from "@lush/code";
import { number, parseJsonLine, probeHarness, record, resolveInstallation, runStructuredAdapter, text } from "./shared";
import type { AdapterRunOptions, CodingHarnessAdapter, HarnessLineParser } from "./types";

const capabilities: HarnessCapabilities = {
  approvals: "policy-only",
  steering: false,
  sessionFork: false,
  subagents: true,
  additionalWorkspaceRoots: true,
  autonomyModes: ["plan", "accept-edits", "auto"],
  modelSelection: true,
  serviceTierSelection: false,
  reasoningStream: false,
  structuredDiffs: false,
  mcp: true,
  nativeSandbox: true
};

export class CodexAdapter implements CodingHarnessAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  effectiveAutonomy(requested: AutonomyMode) {
    return requested === "manual" ? "plan" : requested;
  }

  probe() {
    return probeHarness({
      id: this.id,
      displayName: this.displayName,
      command: "codex",
      capabilities,
      probeArguments: ["exec", "--help"],
      requiredHelpTokens: ["--json", "resume", "--sandbox"]
    });
  }

  run(options: AdapterRunOptions) {
    const installationPromise = resolveInstallation(options, () => this.probe());
    let interrupt = () => {};
    const deferred = installationPromise.then((installation) => {
      if (installation.status !== "installed" || !installation.executable || !installation.version) {
        throw new Error(installation.detail ?? "Codex is unavailable");
      }
      const command = options.binding
        ? [installation.executable, "exec", "resume", "--json", options.binding.externalSessionId, options.prompt]
        : [
            installation.executable,
            "exec",
            "--json",
            "--color",
            "never",
            "--sandbox",
            this.effectiveAutonomy(options.autonomy) === "plan" ? "read-only" : "workspace-write",
            ...(options.model ? ["--model", options.model] : []),
            options.prompt
          ];
      const run = runStructuredAdapter({
        adapterId: this.id,
        executable: installation.executable,
        version: installation.version,
        command,
        run: options,
        parser: new CodexLineParser()
      });
      interrupt = run.interrupt;
      return run;
    });

    return {
      binding: deferred.then((run) => run.binding),
      completed: deferred.then((run) => run.completed),
      interrupt: () => interrupt()
    };
  }
}

export class CodexLineParser implements HarnessLineParser {
  parse(line: string) {
    const payload = parseJsonLine(line);
    const type = text(payload.type);
    const item = record(payload.item);
    const events: HarnessEventInput[] = [];
    const externalSessionId = type === "thread.started" ? text(payload.thread_id) : undefined;

    if (type === "item.started") {
      const event = itemStarted(item);
      if (event) events.push(event);
    } else if (type === "item.completed") {
      events.push(...itemCompleted(item));
    } else if (type === "turn.completed") {
      const usage = record(payload.usage);
      events.push({
        kind: "usage.updated",
        data: {
          inputTokens: number(usage.input_tokens),
          outputTokens: number(usage.output_tokens),
          cachedInputTokens: number(usage.cached_input_tokens)
        }
      });
    } else if (type === "error") {
      events.push({ kind: "diagnostic", data: { level: "error", message: text(payload.message) ?? "Codex error" } });
    }

    return { externalSessionId, events };
  }
}

function itemStarted(item: Record<string, unknown>): HarnessEventInput | undefined {
  const type = text(item.type);
  const id = text(item.id) ?? crypto.randomUUID();
  if (type === "command_execution") {
    return { kind: "command.started", data: { commandId: id, command: text(item.command) ?? "Command", status: "running" } };
  }
  if (type && type !== "agent_message" && type !== "reasoning") {
    return { kind: "tool.started", data: { toolCallId: id, name: type, status: "running", input: item.input ?? item.arguments } };
  }
  return undefined;
}

function itemCompleted(item: Record<string, unknown>): HarnessEventInput[] {
  const type = text(item.type);
  const id = text(item.id) ?? crypto.randomUUID();
  if (type === "agent_message") {
    const value = text(item.text);
    return value ? [{ kind: "message.delta", data: { messageId: id, role: "assistant", format: "markdown", delta: value } }] : [];
  }
  if (type === "reasoning") {
    const value = text(item.text);
    return value ? [{ kind: "reasoning.delta", data: { blockId: id, visibility: "summary", delta: value } }] : [];
  }
  if (type === "command_execution") {
    const exitCode = number(item.exit_code);
    return [{
      kind: "command.completed",
      data: {
        commandId: id,
        command: text(item.command) ?? "Command",
        status: exitCode === undefined || exitCode === 0 ? "completed" : "failed",
        exitCode,
        output: text(item.aggregated_output)
      }
    }];
  }
  if (type) {
    return [{ kind: "tool.completed", data: { toolCallId: id, name: type, status: text(item.status) === "failed" ? "failed" : "completed", output: text(item.output) } }];
  }
  return [];
}
