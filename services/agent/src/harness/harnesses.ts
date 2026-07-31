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

type BrokeredLushConfig = {
  brokerUrl: string;
  capabilityToken: string;
  configurationDigest: string;
  configuration: unknown;
};

/**
 * Phase 1's built-in Lush harness. The child owns the turn and receives an
 * immutable run bundle plus one short-lived, run-bound inference capability;
 * it never receives an upstream provider credential.
 */
export function brokeredLushHarness(id = "lush-brokered"): Harness {
  return {
    id,
    async *connect(request, signal): AsyncIterable<HarnessResponse> {
      const config = normalizeBrokeredConfig(request.harnessConfig);
      const response = await fetch(config.brokerUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.capabilityToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          configurationDigest: config.configurationDigest,
          configuration: config.configuration
        }),
        signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`Inference broker rejected the run (${response.status})`);
      }

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const delta = parseBrokerDelta(line);
            if (delta) {
              yield {
                type: "outputs",
                messages: [textMessage("assistant", delta)]
              };
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) {
        const delta = parseBrokerDelta(tail);
        if (delta) {
          yield { type: "outputs", messages: [textMessage("assistant", delta)] };
        }
      }
      yield { type: "end", state: "completed" };
    }
  };
}

function normalizeBrokeredConfig(value: unknown): BrokeredLushConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Brokered Lush harness configuration is required");
  }
  const candidate = value as Partial<BrokeredLushConfig>;
  if (
    typeof candidate.brokerUrl !== "string" ||
    !candidate.brokerUrl.startsWith("http://127.0.0.1:") ||
    typeof candidate.capabilityToken !== "string" ||
    candidate.capabilityToken.length < 32 ||
    typeof candidate.configurationDigest !== "string" ||
    candidate.configuration === undefined
  ) {
    throw new Error("Brokered Lush harness configuration is invalid");
  }
  return candidate as BrokeredLushConfig;
}

function parseBrokerDelta(line: string): string {
  const value = JSON.parse(line) as { delta?: unknown };
  if (!value || typeof value.delta !== "string") {
    throw new Error("Inference broker returned an invalid event");
  }
  return value.delta;
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
