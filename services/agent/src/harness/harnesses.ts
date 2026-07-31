/**
 * In-process harness implementations of the AX `Harness` contract.
 *
 * `echoHarness` is the minimal in-process runtime used for development and the
 * text-only compatibility path. `toolCallingHarness` demonstrates the AX
 * `ThirdPartyExecutor` seam: the harness owns tool execution internally, which
 * Lush routes through the tool gateway (see `./tools`). Both are interchangeable
 * with a remote AX harness behind the same contract.
 */

import {
  lastUserText,
  textMessage,
  type Message,
  type ToolCallContent
} from "./content";
import type { Harness, HarnessResponse, HarnessStart } from "./protocol";
import type { ThirdPartyExecutor } from "./tools";

export function echoHarness(id = "echo"): Harness {
  return {
    id,
    async *connect(request: HarnessStart): AsyncIterable<HarnessResponse> {
      const text = lastUserText(request.messages) ?? "";
      yield {
        type: "outputs",
        messages: [textMessage("assistant", `echo: ${text}`)]
      };
      yield { type: "end", state: "completed" };
    }
  };
}

export type ToolCallingHarnessOptions = {
  id?: string;
  executor: ThirdPartyExecutor;
  toolName: string;
  /** Derive the tool arguments from the turn inputs. Defaults to `{}`. */
  buildArguments?: (messages: Message[]) => Record<string, unknown>;
};

/**
 * A harness that emits reasoning, calls one tool through the injected executor,
 * surfaces the result, and completes. Used to exercise the gateway bridge; a
 * real harness would run a full model/tool loop.
 */
export function toolCallingHarness(options: ToolCallingHarnessOptions): Harness {
  const id = options.id ?? "tools";
  return {
    id,
    async *connect(request, signal): AsyncIterable<HarnessResponse> {
      const call: ToolCallContent = {
        type: "tool_call",
        id: crypto.randomUUID(),
        name: options.toolName,
        arguments: options.buildArguments?.(request.messages) ?? {}
      };
      yield {
        type: "outputs",
        messages: [{ role: "assistant", content: call }]
      };

      const result = await options.executor.execute(call, signal);
      yield {
        type: "outputs",
        messages: [{ role: "tool", content: result }]
      };

      const summary = result.isError
        ? `The ${call.name} tool failed.`
        : `The ${call.name} tool succeeded.`;
      yield { type: "outputs", messages: [textMessage("assistant", summary)] };
      yield { type: "end", state: "completed" };
    }
  };
}
