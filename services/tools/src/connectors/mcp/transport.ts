/**
 * MCP Streamable HTTP transport (spec revision 2025-11-25).
 *
 * A single HTTP endpoint carries all JSON-RPC traffic. Each client message is
 * POSTed; the server answers either with a single `application/json` body or a
 * `text/event-stream` that may interleave notifications and server->client
 * requests before the response to our request. The transport owns the mutable
 * transport state: the negotiated protocol version and the `Mcp-Session-Id`.
 *
 * The session id is transport state, never authentication — it is bound to the
 * gateway connection worker and is never treated as a credential.
 */

import { ConnectorError } from "../types";
import { safeFetch, type EgressPolicy } from "../../net/egress";
import { readSseEvents } from "./sse";
import {
  JSONRPC_VERSION,
  isJsonRpcResponse,
  type JsonRpcId,
  type JsonRpcResponse
} from "./jsonrpc";

export type McpTransportOptions = {
  endpoint: string;
  headers: Record<string, string>;
  egressPolicy: EgressPolicy;
  maxResponseBytes: number;
  resolver?: (host: string) => Promise<string[]>;
};

export class McpTransport {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;

  constructor(private readonly options: McpTransportOptions) {}

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Send a request and await its matching JSON-RPC response. */
  async request(
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post(
      { jsonrpc: JSONRPC_VERSION, id, method, params },
      signal
    );

    if (response.status === 404 && this.sessionId) {
      // The server expired our session. Surface a distinct code so the worker
      // can re-initialize rather than treating it as a tool failure.
      throw new ConnectorError(
        "mcp_session_expired",
        "MCP session expired; re-initialization required",
        409
      );
    }
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new ConnectorError(
        "mcp_http_error",
        `MCP request '${method}' failed with ${response.status}: ${body || response.statusText}`,
        502
      );
    }

    this.captureSession(response);

    const rpc = await this.readResponse(response, id, signal);
    if (rpc.error) {
      throw new ConnectorError(
        "mcp_rpc_error",
        `MCP '${method}' error ${rpc.error.code}: ${rpc.error.message}`,
        502,
        rpc.error.data
      );
    }
    return rpc.result;
  }

  /** Fire-and-forget notification (no id, no response expected). */
  async notify(
    method: string,
    params: unknown,
    signal: AbortSignal
  ): Promise<void> {
    const response = await this.post(
      { jsonrpc: JSONRPC_VERSION, method, params },
      signal
    );
    // Notifications should be answered with 202 Accepted, but some servers reply
    // 200 with an empty body. Anything else is an error.
    if (!response.ok) {
      const body = await safeReadText(response);
      throw new ConnectorError(
        "mcp_http_error",
        `MCP notification '${method}' failed with ${response.status}: ${body}`,
        502
      );
    }
    await response.body?.cancel().catch(() => {});
  }

  /** Terminate the session (best-effort DELETE). */
  async terminate(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      const response = await safeFetch(
        this.options.endpoint,
        { method: "DELETE", headers: this.buildHeaders(false) },
        this.options.egressPolicy,
        this.options.resolver
      );
      // Drain the body so the connection can be reused/closed cleanly.
      await response.body?.cancel().catch(() => {});
    } catch {
      // Termination is best-effort; a failed DELETE must not surface an error.
    } finally {
      this.sessionId = null;
    }
  }

  private async post(
    message: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<Response> {
    return safeFetch(
      this.options.endpoint,
      {
        method: "POST",
        headers: this.buildHeaders(true),
        body: JSON.stringify(message),
        signal
      },
      this.options.egressPolicy,
      this.options.resolver
    );
  }

  private buildHeaders(withBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.options.headers,
      accept: "application/json, text/event-stream"
    };
    if (withBody) {
      headers["content-type"] = "application/json";
    }
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }
    if (this.protocolVersion) {
      headers["mcp-protocol-version"] = this.protocolVersion;
    }
    return headers;
  }

  private captureSession(response: Response) {
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  private async readResponse(
    response: Response,
    id: JsonRpcId,
    signal: AbortSignal
  ): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      const body = await response.json().catch(() => undefined);
      if (isJsonRpcResponse(body) && body.id === id) {
        return body;
      }
      throw new ConnectorError(
        "mcp_protocol_error",
        "MCP server returned a malformed JSON response",
        502
      );
    }

    if (contentType.includes("text/event-stream") && response.body) {
      for await (const event of readSseEvents(
        response.body,
        this.options.maxResponseBytes,
        signal
      )) {
        const parsed = safeParseJson(event.data);
        // Ignore notifications and server->client requests: sampling and
        // elicitation are not supported in the MVP and must never bypass the
        // run capability model. We only resolve our own response.
        if (isJsonRpcResponse(parsed) && parsed.id === id) {
          return parsed;
        }
      }
      throw new ConnectorError(
        "mcp_protocol_error",
        "MCP event stream closed before returning a response",
        502
      );
    }

    throw new ConnectorError(
      "mcp_protocol_error",
      `Unexpected MCP content-type: ${contentType || "(none)"}`,
      502
    );
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return "";
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
