import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readSseEvents } from "../services/tools/src/connectors/mcp/sse";
import { McpConnector } from "../services/tools/src/connectors/mcp/client";
import { McpTransport } from "../services/tools/src/connectors/mcp/transport";
import type { EgressPolicy } from "../services/tools/src/net/egress";
import { defaultConnectorLimits } from "../services/tools/src/connectors/types";

const localPolicy: EgressPolicy = {
  allowInsecureHttp: true,
  allowPrivateHosts: true,
  maxRedirects: 5
};

const SESSION_ID = "test-session-123";
const PROTOCOL_VERSION = "2025-11-25";

type ServerState = {
  initialized: boolean;
  sawSessionId: boolean;
  sawProtocolHeader: boolean;
  terminated: boolean;
};

const state: ServerState = {
  initialized: false,
  sawSessionId: false,
  sawProtocolHeader: false,
  terminated: false
};

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers }
  });
}

function sseResponse(messages: unknown[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const message of messages) {
        controller.enqueue(
          encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
        );
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" }
  });
}

let server: ReturnType<typeof Bun.serve>;
let endpoint: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (request.method === "DELETE") {
        state.terminated = true;
        return new Response(null, { status: 204 });
      }

      const body = (await request.json()) as {
        id?: unknown;
        method: string;
        params?: Record<string, unknown>;
      };

      if (request.headers.get("mcp-session-id") === SESSION_ID) {
        state.sawSessionId = true;
      }
      if (request.headers.get("mcp-protocol-version")) {
        state.sawProtocolHeader = true;
      }

      switch (body.method) {
        case "initialize":
          state.initialized = true;
          return jsonResponse(
            jsonRpcResult(body.id, {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "mock-mcp", version: "1.2.3" }
            }),
            { "mcp-session-id": SESSION_ID }
          );

        case "notifications/initialized":
          return new Response(null, { status: 202 });

        case "tools/list": {
          const cursor = body.params?.cursor;
          if (!cursor) {
            return jsonResponse(
              jsonRpcResult(body.id, {
                tools: [
                  {
                    name: "echo",
                    description: "Echo the arguments back.",
                    inputSchema: { type: "object" },
                    annotations: { readOnlyHint: true, destructiveHint: false }
                  }
                ],
                nextCursor: "page2"
              })
            );
          }
          return jsonResponse(
            jsonRpcResult(body.id, {
              tools: [
                {
                  name: "add",
                  description: "Add two numbers.",
                  inputSchema: { type: "object" },
                  outputSchema: { type: "object" }
                  // no annotations -> restrictive defaults
                }
              ]
            })
          );
        }

        case "tools/call": {
          const name = body.params?.name;
          const args = body.params?.arguments ?? {};
          if (name === "echo") {
            // Answer over SSE, interleaving a notification before the response
            // to exercise the reader's message filtering.
            return sseResponse([
              { jsonrpc: "2.0", method: "notifications/progress", params: {} },
              jsonRpcResult(body.id, {
                content: [{ type: "text", text: JSON.stringify(args) }]
              })
            ]);
          }
          if (name === "add") {
            const sum =
              Number((args as { a?: number }).a ?? 0) +
              Number((args as { b?: number }).b ?? 0);
            return jsonResponse(
              jsonRpcResult(body.id, {
                content: [{ type: "text", text: String(sum) }],
                structuredContent: { sum }
              })
            );
          }
          if (name === "boom") {
            return jsonResponse({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32000, message: "kaboom" }
            });
          }
          if (name === "huge") {
            return jsonResponse(
              jsonRpcResult(body.id, {
                content: [{ type: "text", text: "x".repeat(10_000) }]
              })
            );
          }
          if (name === "huge_error") {
            return new Response("x".repeat(10_000), {
              status: 500,
              headers: { "content-type": "text/plain" }
            });
          }
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "unknown tool" }
          });
        }

        default:
          return jsonResponse({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "method not found" }
          });
      }
    }
  });
  endpoint = `http://127.0.0.1:${server.port}/mcp`;
});

afterAll(() => {
  server.stop(true);
});

function connector() {
  return new McpConnector({ endpoint, egressPolicy: localPolicy });
}

describe("readSseEvents", () => {
  test("parses multiple data events and multi-line data", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: message\ndata: one\n\n"));
        controller.enqueue(encoder.encode("data: two\ndata: three\n\n"));
        controller.close();
      }
    });
    const events = [];
    for await (const event of readSseEvents(stream, 10_000, new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toEqual([
      { event: "message", data: "one" },
      { event: "message", data: "two\nthree" }
    ]);
  });
});

describe("McpConnector", () => {
  test("discovers tools across paginated pages with normalized annotations", async () => {
    const tools = await connector().discover(new AbortController().signal);
    expect(tools.map((tool) => tool.externalName)).toEqual(["echo", "add"]);

    const echo = tools[0]!;
    expect(echo.annotations).toEqual({
      readOnly: true,
      destructive: false,
      idempotent: false,
      openWorld: true
    });

    // A tool with no annotation hints defaults to the restrictive class.
    const add = tools[1]!;
    expect(add.annotations).toEqual({
      readOnly: false,
      destructive: true,
      idempotent: false,
      openWorld: true
    });

    expect(state.initialized).toBe(true);
    expect(state.sawSessionId).toBe(true);
    expect(state.sawProtocolHeader).toBe(true);
  });

  test("invokes a tool over an SSE response, ignoring interleaved notifications", async () => {
    const result = await connector().invoke({
      externalName: "echo",
      input: { hello: "world" },
      limits: defaultConnectorLimits,
      signal: new AbortController().signal
    });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ hello: "world" }) }
    ]);
  });

  test("invokes a tool over a JSON response and returns structured output", async () => {
    const result = await connector().invoke({
      externalName: "add",
      input: { a: 2, b: 3 },
      limits: defaultConnectorLimits,
      signal: new AbortController().signal
    });
    expect(result.structured).toEqual({ sum: 5 });
    expect(result.content).toEqual([{ type: "text", text: "5" }]);
  });

  test("surfaces JSON-RPC errors as ConnectorError", async () => {
    await expect(
      connector().invoke({
        externalName: "boom",
        input: {},
        limits: defaultConnectorLimits,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "mcp_rpc_error" });
  });

  test("bounds JSON and HTTP error response bodies before buffering", async () => {
    const bounded = new McpConnector({
      endpoint,
      egressPolicy: localPolicy,
      maxResponseBytes: 512
    });
    const limits = { ...defaultConnectorLimits, maxResponseBytes: 512 };
    await expect(
      bounded.invoke({
        externalName: "huge",
        input: {},
        limits,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "response_too_large" });

    const boundedError = new McpConnector({
      endpoint,
      egressPolicy: localPolicy,
      maxResponseBytes: 512
    });
    await expect(
      boundedError.invoke({
        externalName: "huge_error",
        input: {},
        limits,
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  test("close() terminates the session via DELETE", async () => {
    const client = connector();
    await client.discover(new AbortController().signal);
    await client.close();
    expect(state.terminated).toBe(true);
    expect(client.getServerInfo()).toEqual({ name: "mock-mcp", version: "1.2.3" });
  });
});

describe("McpTransport session isolation", () => {
  test("does not share server-issued session ids across transports", async () => {
    const observedSessions = new Map<string, string | null>();
    const isolationServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const client = request.headers.get("x-test-client") ?? "unknown";
        const body = (await request.json()) as { id: unknown; method: string };
        if (body.method === "initialize") {
          return jsonResponse(
            jsonRpcResult(body.id, { protocolVersion: PROTOCOL_VERSION }),
            { "mcp-session-id": `session-${client}` }
          );
        }
        observedSessions.set(client, request.headers.get("mcp-session-id"));
        return jsonResponse(jsonRpcResult(body.id, {}));
      }
    });

    const makeTransport = (client: string) =>
      new McpTransport({
        endpoint: `http://127.0.0.1:${isolationServer.port}/mcp`,
        headers: { "x-test-client": client },
        egressPolicy: localPolicy,
        maxResponseBytes: 10_000
      });
    const first = makeTransport("first");
    const second = makeTransport("second");
    const signal = new AbortController().signal;

    try {
      await Promise.all([
        first.request("initialize", {}, signal),
        second.request("initialize", {}, signal)
      ]);
      await Promise.all([
        first.request("ping", {}, signal),
        second.request("ping", {}, signal)
      ]);

      expect(observedSessions).toEqual(
        new Map([
          ["first", "session-first"],
          ["second", "session-second"]
        ])
      );
    } finally {
      isolationServer.stop(true);
    }
  });
});
