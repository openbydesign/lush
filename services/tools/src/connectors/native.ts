/**
 * Native connector: trusted, in-process Lush tools registered in code with
 * explicit schemas and policy annotations.
 *
 * Native tools are the safest source class — no external egress, no credentials
 * — and serve as the first normalized surface for the gateway. Each tool is a
 * pure(ish) async function whose input is validated against its own schema by
 * the gateway before it reaches the handler here.
 */

import {
  ConnectorError,
  type Connector,
  type ConnectorInvocation,
  type NormalizedToolDefinition,
  type ToolResult
} from "./types";

export type NativeTool = NormalizedToolDefinition & {
  handler: (input: unknown, signal: AbortSignal) => Promise<ToolResult>;
};

export function jsonResult(data: unknown): ToolResult {
  return {
    isError: false,
    content: [{ type: "json", data }],
    structured: data
  };
}

export function textResult(text: string): ToolResult {
  return { isError: false, content: [{ type: "text", text }] };
}

// The registry is intentionally empty until a built-in provides material value
// beyond context already present in the run (including session timestamps).
export const builtinNativeTools: NativeTool[] = [];

export class NativeConnector implements Connector {
  readonly source = "native" as const;

  private readonly tools: Map<string, NativeTool>;

  constructor(tools: NativeTool[] = builtinNativeTools) {
    this.tools = new Map(tools.map((tool) => [tool.externalName, tool]));
  }

  async discover(signal: AbortSignal): Promise<NormalizedToolDefinition[]> {
    signal.throwIfAborted();
    return [...this.tools.values()].map(({ handler: _handler, ...definition }) => definition);
  }

  async invoke(invocation: ConnectorInvocation): Promise<ToolResult> {
    const tool = this.tools.get(invocation.externalName);
    if (!tool) {
      throw new ConnectorError(
        "tool_not_found",
        `Unknown native tool: ${invocation.externalName}`,
        404
      );
    }
    return tool.handler(invocation.input, invocation.signal);
  }
}
