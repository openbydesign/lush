import { describe, expect, test } from "bun:test";
import {
  appendAgentStreamEvent,
  agentStreamEventFromRunEvent,
  chatMessageFromSession,
  chatMessageMetadata,
  finalizePendingToolParts,
  readAgentEventStream,
  readAgentRunEventStream
} from "../apps/lush/src/lib/agent-message";
import type { ChatMessagePart } from "../apps/lush/src/lib/types";

describe("app agent message parts", () => {
  test("reduces structured stream events into renderable parts", () => {
    let parts: ChatMessagePart[] = [];
    parts = appendAgentStreamEvent(parts, { type: "reasoning-delta", delta: "Checking" });
    parts = appendAgentStreamEvent(parts, { type: "reasoning-delta", delta: " sources" });
    parts = appendAgentStreamEvent(parts, { type: "text-delta", delta: "Answer" });
    parts = appendAgentStreamEvent(parts, {
      type: "source",
      sourceId: "source-1",
      url: "https://example.com",
      title: "Example"
    });

    expect(parts).toEqual([
      { type: "reasoning", text: "Checking sources" },
      { type: "text", text: "Answer" },
      {
        type: "source",
        sourceId: "source-1",
        url: "https://example.com",
        title: "Example"
      }
    ]);
  });

  test("round trips compact text metadata", () => {
    const parts: ChatMessagePart[] = [
      { type: "text", text: "hello" },
      { type: "reasoning", text: "brief summary" },
      { type: "text", text: " world" }
    ];
    const restored = chatMessageFromSession({
      id: "message-1",
      sessionId: "session-1",
      role: "assistant",
      content: "hello world",
      metadata: chatMessageMetadata(parts),
      tokenCount: null,
      byteSize: 11,
      createdAt: "2026-07-14T00:00:00.000Z"
    });

    expect(restored?.parts).toEqual(parts);
    expect(restored?.serverId).toBe("message-1");
    expect(restored?.createdAt).toBe("2026-07-14T00:00:00.000Z");
  });

  test("parses NDJSON across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"type":"text-delta","delta":"hel'));
          controller.enqueue(encoder.encode('lo"}\n{"type":"response-complete"}\n'));
          controller.close();
        }
      })
    );
    const events: unknown[] = [];
    await readAgentEventStream(response, (event) => events.push(event));
    expect(events).toEqual([
      { type: "text-delta", delta: "hello" },
      { type: "response-complete" }
    ]);
  });

  test("parses durable run event envelopes across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          '{"runId":"run-1","sequence":1,"type":"run-start","pay'
        ));
        controller.enqueue(encoder.encode(
          'load":{"originMessageId":"message-1"},"createdAt":"2026-07-30T00:00:00Z"}\n'
        ));
        controller.close();
      }
    }));
    const events: unknown[] = [];
    await readAgentRunEventStream(response, (event) => events.push(event));
    expect(events).toEqual([{
      runId: "run-1",
      sequence: 1,
      type: "run-start",
      payload: { originMessageId: "message-1" },
      createdAt: "2026-07-30T00:00:00Z"
    }]);
  });

  test("projects durable tool approval events into one inline tool card", () => {
    const events = [
      {
        type: "tool-input",
        payload: {
          toolCallId: "call-1",
          toolName: "web_search",
          toolTitle: "Search the web",
          connectionLabel: "Parallel",
          connectionSource: "mcp",
          connectionIconUrl: "https://parallel.ai/favicon.ico",
          input: { query: "Sonoma" }
        }
      },
      {
        type: "tool-approval-required",
        payload: {
          approvalId: "approval-1",
          toolCallId: "call-1",
          toolName: "web_search",
          expiresAt: "2026-07-31T21:00:00.000Z"
        }
      },
      {
        type: "tool-approval-resolved",
        payload: {
          approvalId: "approval-1",
          toolCallId: "call-1",
          toolName: "web_search",
          decision: "approved"
        }
      },
      {
        type: "tool-output",
        payload: { toolCallId: "call-1", toolName: "web_search", output: { results: 2 } }
      }
    ];
    let parts: ChatMessagePart[] = [];
    for (const [index, event] of events.entries()) {
      const projected = agentStreamEventFromRunEvent({
        runId: "run-1",
        sequence: index + 1,
        createdAt: "2026-07-31T20:00:00.000Z",
        ...event
      });
      if (projected) parts = appendAgentStreamEvent(parts, projected);
    }
    expect(parts).toEqual([{
      type: "tool",
      toolCallId: "call-1",
      toolName: "web_search",
      toolTitle: "Search the web",
      connectionLabel: "Parallel",
      connectionSource: "mcp",
      connectionIconUrl: "https://parallel.ai/favicon.ico",
      state: "output-available",
      input: { query: "Sonoma" },
      output: { results: 2 },
      errorText: undefined,
      approvalId: "approval-1",
      approvalExpiresAt: "2026-07-31T21:00:00.000Z",
      approvalDecision: "approved"
    }]);
  });

  test("restores compact tool activity metadata from a persisted message", () => {
    const parts: ChatMessagePart[] = [{
      type: "tool",
      toolCallId: "call-1",
      toolName: "parallel__web_search",
      toolTitle: "Web Search",
      connectionLabel: "Parallel",
      connectionSource: "mcp",
      state: "output-available",
      input: { query: "Sonoma" },
      output: { results: 2 }
    }, {
      type: "text",
      text: "The Woodside Fire is causing the poor air quality."
    }];
    const restored = chatMessageFromSession({
      id: "message-1",
      sessionId: "session-1",
      role: "assistant",
      content: "The Woodside Fire is causing the poor air quality.",
      metadata: chatMessageMetadata(parts),
      tokenCount: null,
      byteSize: 52,
      createdAt: "2026-07-31T21:33:42.992Z"
    });

    expect(restored?.parts).toEqual(parts);
  });

  test("correlates duplicate provider call ids to the latest pending call", () => {
    let parts: ChatMessagePart[] = [];
    parts = appendAgentStreamEvent(parts, {
      type: "tool-input",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      input: { urls: ["https://example.com/one"] }
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-output",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      output: { page: "one" }
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-input",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      input: { urls: ["https://example.com/two"] }
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-output",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      errorText: "second call failed"
    });

    expect(parts).toEqual([
      expect.objectContaining({
        state: "output-available",
        input: { urls: ["https://example.com/one"] },
        output: { page: "one" }
      }),
      expect.objectContaining({
        state: "output-error",
        input: { urls: ["https://example.com/two"] },
        errorText: "second call failed"
      })
    ]);
  });

  test("resolves approval only on the latest reused provider call id", () => {
    let parts: ChatMessagePart[] = [];
    parts = appendAgentStreamEvent(parts, {
      type: "tool-input",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      input: { urls: ["https://example.com/one"] }
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-output",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      output: { page: "one" }
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-input",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      input: { urls: ["https://example.com/two"] }
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-approval-required",
      approvalId: "approval-2",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      expiresAt: "2026-07-31T21:00:00.000Z"
    });
    parts = appendAgentStreamEvent(parts, {
      type: "tool-approval-resolved",
      approvalId: "approval-2",
      toolCallId: "provider-call:0",
      toolName: "web_fetch",
      decision: "approved"
    });

    expect(parts).toEqual([
      expect.objectContaining({
        state: "output-available",
        input: { urls: ["https://example.com/one"] },
        output: { page: "one" }
      }),
      expect.objectContaining({
        state: "approval-responded",
        input: { urls: ["https://example.com/two"] },
        approvalId: "approval-2",
        approvalDecision: "approved"
      })
    ]);
    expect(parts[0]).not.toHaveProperty("approvalDecision");
  });

  test("closes unfinished tool states when a turn stops", () => {
    const parts = finalizePendingToolParts([{
      type: "tool",
      toolCallId: "call-running",
      toolName: "web_fetch",
      state: "input-available",
      input: { url: "https://example.com" }
    }, {
      type: "tool",
      toolCallId: "call-complete",
      toolName: "web_search",
      state: "output-available",
      output: { results: 1 }
    }], "Stopped by user");

    expect(parts[0]).toEqual(expect.objectContaining({
      state: "output-error",
      errorText: "Stopped by user"
    }));
    expect(parts[1]).toEqual(expect.objectContaining({
      state: "output-available",
      output: { results: 1 }
    }));
  });
});
