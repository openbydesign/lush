/**
 * Bridge between the AX message model and the Lush tool gateway.
 *
 * Inside a harness, tools are an AX `ThirdPartyExecutor` seam. Lush routes that
 * seam through `services/tools` so every call is authorized, bounded, and
 * audited — the harness never talks to a connector or credential directly. From
 * the orchestrator's view, tool activity is just `ToolCallContent` and
 * `ToolResultContent` flowing through the durable event log.
 *
 * This module maps in both directions and stays decoupled from principal and
 * connection resolution: the caller supplies an `invoke` function that closes
 * over the authorization context (principal, connection selection) and calls the
 * gateway. Only the gateway's normalized `ToolResult` type is imported.
 */

import type { ToolResult } from "@lush/tools/connectors";
import type { ToolCallContent, ToolResultContent } from "./content";

/** AX `ThirdPartyExecutor`: run one tool call, return a normalized result. */
export interface ThirdPartyExecutor {
  execute(call: ToolCallContent, signal: AbortSignal): Promise<ToolResultContent>;
}

/**
 * How a model-facing function name and arguments reach the gateway. The
 * implementation resolves the name to a (connection, tool) under the calling
 * principal and calls `invokeTool`; that resolution is intentionally outside
 * this module.
 */
export type GatewayToolBinding = {
  connectionId: string;
  definitionDigest: string;
};

export type GatewayInvoke = (params: {
  connectionId: string;
  expectedDefinitionDigest: string;
  runId: string;
  callId: string;
  idempotencyKey: string;
  name: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<ToolResult>;

export type GatewayExecutorOptions = {
  runId: string;
  resolveBinding(name: string): Promise<GatewayToolBinding>;
  invoke: GatewayInvoke;
};

/** Map a gateway `ToolResult` into an AX `ToolResultContent`, correlating ids. */
export function toolResultContentFromResult(
  call: ToolCallContent,
  result: ToolResult
): ToolResultContent {
  return {
    type: "tool_result",
    callId: call.id,
    name: call.name,
    isError: result.isError,
    // Prefer structured output; otherwise pass the normalized content blocks.
    response: result.structured ?? { content: result.content },
    signature: call.signature
  };
}

/** Build a `ThirdPartyExecutor` that routes tool calls through the gateway. */
export function createGatewayExecutor(options: GatewayExecutorOptions): ThirdPartyExecutor {
  return {
    async execute(call, signal) {
      try {
        const binding = await options.resolveBinding(call.name);
        const result = await options.invoke({
          connectionId: binding.connectionId,
          expectedDefinitionDigest: binding.definitionDigest,
          runId: options.runId,
          callId: call.id,
          idempotencyKey: `${options.runId}:${call.id}`,
          name: call.name,
          arguments: call.arguments,
          signal
        });
        return toolResultContentFromResult(call, result);
      } catch (error) {
        // A gateway/authorization failure becomes an error tool result so the
        // model loop can observe and react rather than crashing the turn.
        return {
          type: "tool_result",
          callId: call.id,
          name: call.name,
          isError: true,
          response: {
            error: error instanceof Error ? error.message : "tool invocation failed"
          },
          signature: call.signature
        };
      }
    }
  };
}
