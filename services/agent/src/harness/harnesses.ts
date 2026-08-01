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
  confirmationMessage,
  lastUserText,
  textMessage,
  toolCallMessage,
  toolResultMessage,
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

const deltaFlushMs = 50;
const deltaFlushBytes = 1024;

/**
 * Phase 1's built-in Lush harness. The child owns the turn and receives an
 * immutable run bundle plus one short-lived, run-bound inference capability;
 * it never receives an upstream provider credential.
 *
 * TODO(Phase 3): replace this loopback-only endpoint and opaque token with the
 * isolation-provider-reachable broker and signed expiring audience-bound token
 * defined by the broker-token plan. This Phase 1 transport is not that contract.
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

      for await (const event of readBrokerEvents(response.body)) {
        const message = event.type === "text_delta"
          ? textMessage("assistant", event.delta)
          : event.type === "tool_call"
            ? toolCallMessage(event.call)
            : event.type === "tool_approval"
              ? confirmationMessage(event.approval)
              : toolResultMessage(event.result);
        yield { type: "outputs", messages: [message] };
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

type BrokerEvent =
  | { type: "text_delta"; delta: string }
  | {
      type: "tool_call";
      call: { id: string; name: string; arguments: Record<string, unknown> };
    }
  | {
      type: "tool_result";
      result: {
        callId: string;
        name: string;
        response: unknown;
        isError?: boolean;
      };
    }
  | {
      type: "tool_approval";
      approval: {
        id: string;
        toolCallId: string;
        toolName: string;
        expiresAt: string;
        question?: string;
      };
    };

async function* readBrokerEvents(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield parseBrokerEvent(line);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) yield parseBrokerEvent(tail);
}

export async function* coalesceBrokerDeltas(source: AsyncIterable<string>) {
  const iterator = source[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let next = iterator.next();
  let pending = "";
  let flushDeadline = 0;
  let emittedFirst = false;

  while (true) {
    const result = pending
      ? await nextWithTimeout(next, Math.max(0, flushDeadline - Date.now()))
      : { kind: "next" as const, value: await next };
    if (result.kind === "timeout") {
      yield pending;
      pending = "";
      flushDeadline = 0;
      continue;
    }
    if (result.value.done) {
      if (pending) yield pending;
      return;
    }

    next = iterator.next();
    if (!emittedFirst) {
      emittedFirst = true;
      yield result.value.value;
      continue;
    }
    if (!pending) flushDeadline = Date.now() + deltaFlushMs;
    pending += result.value.value;
    if (encoder.encode(pending).byteLength >= deltaFlushBytes) {
      yield pending;
      pending = "";
      flushDeadline = 0;
    }
  }
}

function nextWithTimeout<T>(next: Promise<IteratorResult<T>>, milliseconds: number) {
  return new Promise<
    | { kind: "next"; value: IteratorResult<T> }
    | { kind: "timeout" }
  >((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), milliseconds);
    next.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "next", value });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function parseBrokerEvent(line: string): BrokerEvent {
  const value = JSON.parse(line) as BrokerEvent;
  if (!value || typeof value !== "object") {
    throw new Error("Inference broker returned an invalid event");
  }
  if (value.type === "text_delta" && typeof value.delta === "string") return value;
  if (
    value.type === "tool_call" &&
    value.call &&
    typeof value.call.id === "string" &&
    typeof value.call.name === "string" &&
    value.call.arguments &&
    typeof value.call.arguments === "object"
  ) return value;
  if (
    value.type === "tool_approval" &&
    value.approval &&
    typeof value.approval.id === "string" &&
    typeof value.approval.toolCallId === "string" &&
    typeof value.approval.toolName === "string" &&
    typeof value.approval.expiresAt === "string"
  ) return value;
  if (
    value.type === "tool_result" &&
    value.result &&
    typeof value.result.callId === "string" &&
    typeof value.result.name === "string"
  ) return value;
  throw new Error("Inference broker returned an invalid event");
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
