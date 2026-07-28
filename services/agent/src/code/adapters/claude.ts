import type { AutonomyMode, HarnessCapabilities, HarnessEventInput } from "@lush/code";
import { number, parseJsonLine, probeHarness, record, resolveInstallation, runStructuredAdapter, text } from "./shared";
import type { AdapterRunOptions, CodingHarnessAdapter, HarnessLineParser } from "./types";

const capabilities: HarnessCapabilities = {
  approvals: "policy-only", steering: false, sessionFork: true, subagents: true,
  additionalWorkspaceRoots: true, autonomyModes: ["plan", "manual", "accept-edits", "auto"],
  modelSelection: true, serviceTierSelection: false, reasoningStream: true,
  structuredDiffs: false, mcp: true, nativeSandbox: false
};

export class ClaudeAdapter implements CodingHarnessAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  effectiveAutonomy(requested: AutonomyMode) { return requested; }
  probe() {
    return probeHarness({
      id: this.id,
      displayName: this.displayName,
      command: "claude",
      capabilities,
      probeArguments: ["--help"],
      requiredHelpTokens: ["--output-format", "--resume", "--permission-mode"]
    });
  }

  run(options: AdapterRunOptions) {
    let interrupt = () => {};
    const deferred = resolveInstallation(options, () => this.probe()).then((installation) => {
      if (installation.status !== "installed" || !installation.executable || !installation.version) {
        throw new Error(installation.detail ?? "Claude Code is unavailable");
      }
      const permissionMode = { plan: "plan", manual: "default", "accept-edits": "acceptEdits", auto: "auto" }[options.autonomy];
      const command = [
        installation.executable, "--print", "--verbose", "--output-format", "stream-json",
        "--include-partial-messages", "--permission-mode", permissionMode,
        ...(options.binding ? ["--resume", options.binding.externalSessionId] : []),
        ...(options.model ? ["--model", options.model] : []), options.prompt
      ];
      const run = runStructuredAdapter({ adapterId: this.id, executable: installation.executable, version: installation.version, command, run: options, parser: new ClaudeLineParser() });
      interrupt = run.interrupt;
      return run;
    });
    return { binding: deferred.then((run) => run.binding), completed: deferred.then((run) => run.completed), interrupt: () => interrupt() };
  }
}

export class ClaudeLineParser implements HarnessLineParser {
  private streamedText = false;

  parse(line: string) {
    const payload = parseJsonLine(line);
    const type = text(payload.type);
    const events: HarnessEventInput[] = [];
    const externalSessionId = text(payload.session_id);

    if (type === "stream_event") {
      const streamEvent = record(payload.event);
      const delta = record(streamEvent.delta);
      const deltaType = text(delta.type);
      if (deltaType === "text_delta" && text(delta.text)) {
        this.streamedText = true;
        events.push({ kind: "message.delta", data: { messageId: "assistant", role: "assistant", format: "markdown", delta: text(delta.text)! } });
      } else if (deltaType === "thinking_delta" && text(delta.thinking)) {
        events.push({ kind: "reasoning.delta", data: { blockId: "thinking", visibility: "native", delta: text(delta.thinking)! } });
      }
    } else if (type === "assistant") {
      const message = record(payload.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockValue of content) {
        const block = record(blockValue);
        const blockType = text(block.type);
        if (blockType === "text" && !this.streamedText && text(block.text)) {
          events.push({ kind: "message.delta", data: { messageId: text(message.id) ?? "assistant", role: "assistant", format: "markdown", delta: text(block.text)! } });
        } else if (blockType === "tool_use") {
          events.push({ kind: "tool.started", data: { toolCallId: text(block.id) ?? crypto.randomUUID(), name: text(block.name) ?? "Tool", status: "running", input: block.input } });
        } else if (blockType === "thinking" && text(block.thinking)) {
          events.push({ kind: "reasoning.delta", data: { blockId: text(block.signature) ?? "thinking", visibility: "native", delta: text(block.thinking)! } });
        }
      }
    } else if (type === "user") {
      const content = record(payload.message).content;
      for (const blockValue of Array.isArray(content) ? content : []) {
        const block = record(blockValue);
        if (text(block.type) === "tool_result") {
          events.push({ kind: "tool.completed", data: { toolCallId: text(block.tool_use_id) ?? crypto.randomUUID(), name: "Tool", status: block.is_error ? "failed" : "completed", output: contentText(block.content) } });
        }
      }
    } else if (type === "result") {
      const usage = record(payload.usage);
      events.push({ kind: "usage.updated", data: { inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), cachedInputTokens: number(usage.cache_read_input_tokens), costUsd: number(payload.total_cost_usd) } });
      if (payload.is_error) events.push({ kind: "diagnostic", data: { level: "error", message: text(payload.result) ?? "Claude Code failed" } });
    }
    return { externalSessionId, events };
  }
}

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.map((part) => text(record(part).text)).filter(Boolean).join("\n");
}
