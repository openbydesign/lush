import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Message } from "../apps/lush/src/ui/Message";

describe("chat tool activity", () => {
  test("reserves one stable status row before the first tool arrives", () => {
    const html = renderToStaticMarkup(createElement(Message, {
      message: {
        id: "message-1",
        role: "assistant",
        status: "streaming",
        parts: []
      }
    }));

    expect(html.match(/Working/g)).toHaveLength(1);
    expect(html).not.toContain("Thinking...");
  });

  test("renders one collapsed accumulator instead of verbose tool payloads", () => {
    const html = renderToStaticMarkup(createElement(Message, {
      message: {
        id: "message-1",
        role: "assistant",
        status: "complete",
        parts: [{
          type: "tool",
          toolCallId: "call-1",
          toolName: "parallel__web_search",
          toolTitle: "Web Search",
          connectionLabel: "Parallel",
          connectionSource: "mcp",
          state: "output-available",
          input: { query: "Sonoma" },
          output: { results: [{ title: "Result" }] }
        }, {
          type: "text",
          text: "Answer"
        }]
      }
    }));

    expect(html).toContain("Consulted Web Search");
    expect(html).toContain("lush-markdown w-full");
    expect(html).not.toContain("lush-markdown size-full");
    expect(html).toContain('aria-label="Inspect tool calls"');
    expect(html).toContain('aria-label="MCP"');
    expect(html).not.toContain("PARAMETERS");
    expect(html).not.toContain("Result");
    expect(html.indexOf("Consulted Web Search")).toBeLessThan(
      html.indexOf("Answer")
    );
  });

  test("surfaces pending approval actions without expanding call details", () => {
    const html = renderToStaticMarkup(createElement(Message, {
      message: {
        id: "message-1",
        role: "assistant",
        status: "streaming",
        parts: [{
          type: "tool",
          toolCallId: "call-1",
          toolName: "parallel__web_search",
          toolTitle: "Web Search",
          connectionLabel: "Parallel",
          connectionSource: "mcp",
          state: "approval-requested",
          approvalId: "approval-1",
          input: { query: "Sonoma" }
        }]
      },
      onToolApproval: async () => undefined
    }));

    expect(html).toContain("1 tool needs approval");
    expect(html).toContain("Allow once");
    expect(html).toContain("Deny");
    expect(html).not.toContain("PARAMETERS");
  });
});
