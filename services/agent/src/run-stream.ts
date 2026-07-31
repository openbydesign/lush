import {
  fetchAgentRun,
  isTerminalRunStatus,
  listAgentRunEvents,
  type AgentRunPrincipal
} from "./runs";
import { agentStreamContentType } from "./stream-protocol";

const heartbeatIntervalMs = 15_000;
const pollIntervalMs = 100;
export const agentRunIdHeader = "x-lush-run";
export const exposedAgentRunHeaders = [agentRunIdHeader];

/** Stream one durable run without coupling subscriber lifetime to execution. */
export function streamDurableRun(
  principal: AgentRunPrincipal,
  runId: string,
  request: Request,
  after: number,
  additionalHeaders: HeadersInit = {}
) {
  const encoder = new TextEncoder();
  const detached = new AbortController();
  const signal = AbortSignal.any([request.signal, detached.signal]);
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let cursor = after;
      let lastHeartbeat = Date.now();
      try {
        while (!signal.aborted && !closed) {
          const events = await listAgentRunEvents(principal, runId, cursor);
          if (closed) break;
          for (const event of events) {
            cursor = event.sequence;
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          const run = await fetchAgentRun(principal, runId);
          if (closed) break;
          if (isTerminalRunStatus(run.status) && events.length === 0) break;
          if (Date.now() - lastHeartbeat >= heartbeatIntervalMs) {
            controller.enqueue(encoder.encode("\n"));
            lastHeartbeat = Date.now();
          }
          await waitForRunPoll(signal, pollIntervalMs);
        }
        if (!closed) {
          closed = true;
          controller.close();
        }
      } catch (error) {
        if (!closed) {
          closed = true;
          controller.error(error);
        }
      }
    },
    cancel() {
      // Disconnecting detaches only this subscriber. Execution remains durable.
      closed = true;
      detached.abort();
    }
  });
  return new Response(stream, {
    headers: {
      ...Object.fromEntries(new Headers(additionalHeaders)),
      "content-type": agentStreamContentType,
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      [agentRunIdHeader]: runId
    }
  });
}

export function waitForRunPoll(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}
