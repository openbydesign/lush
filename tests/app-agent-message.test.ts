import { describe, expect, test } from "bun:test";
import {
  appendAgentStreamEvent,
  chatMessageFromSession,
  chatMessageMetadata,
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
});
