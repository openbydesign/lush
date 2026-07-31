/**
 * Stateful MCP client implementing the Lush `Connector` interface over
 * Streamable HTTP.
 *
 * Lifecycle (spec 2025-11-25): initialize -> version/capability negotiation ->
 * notifications/initialized -> tools/list (paginated) / tools/call. The client
 * lazily initializes on first use and caches the negotiated session so repeated
 * discovery/invocation on one connection reuse transport state.
 *
 * Untrusted-input posture: tool descriptions and annotation hints from the
 * server are normalized but never trusted for policy. Missing side-effect hints
 * default to the more restrictive class.
 */

import {
  ConnectorError,
  restrictiveAnnotations,
  type Connector,
  type ConnectorInvocation,
  type JsonSchema,
  type NormalizedToolDefinition,
  type ToolAnnotations,
  type ToolResult,
  type ToolResultContent
} from "../types";
import { defaultEgressPolicy, type EgressPolicy } from "../../net/egress";
import { isObject } from "./jsonrpc";
import { McpTransport } from "./transport";

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26"
]);

const CLIENT_INFO = { name: "lush-tool-gateway", version: "0.1.0" };
const MAX_TOOL_LIST_PAGES = 50;

export type McpConnectorConfig = {
  endpoint: string;
  /** Extra headers, e.g. Authorization for a resolved credential. */
  headers?: Record<string, string>;
  egressPolicy?: EgressPolicy;
  maxResponseBytes?: number;
  /** Injected DNS resolver, for tests. */
  resolver?: (host: string) => Promise<string[]>;
};

export class McpConnector implements Connector {
  readonly source = "mcp" as const;

  private readonly transport: McpTransport;
  private initialized = false;
  private serverInfo: { name?: string; version?: string } = {};

  constructor(private readonly config: McpConnectorConfig) {
    this.transport = new McpTransport({
      endpoint: config.endpoint,
      headers: config.headers ?? {},
      egressPolicy: config.egressPolicy ?? defaultEgressPolicy(),
      maxResponseBytes: config.maxResponseBytes ?? 1_000_000,
      resolver: config.resolver
    });
  }

  async discover(signal: AbortSignal): Promise<NormalizedToolDefinition[]> {
    await this.ensureInitialized(signal);
    return this.listTools(signal);
  }

  async invoke(invocation: ConnectorInvocation): Promise<ToolResult> {
    const timeout = withTimeout(invocation.signal, invocation.limits.timeoutMs);
    try {
      await this.ensureInitialized(timeout.signal);
      const result = await this.transport.request(
        "tools/call",
        {
          name: invocation.externalName,
          arguments: invocation.input ?? {}
        },
        timeout.signal
      );
      return normalizeCallResult(result);
    } finally {
      timeout.dispose();
    }
  }

  async close(): Promise<void> {
    await this.transport.terminate();
    this.initialized = false;
  }

  private async ensureInitialized(signal: AbortSignal): Promise<void> {
    if (this.initialized) {
      return;
    }

    const result = await this.transport.request(
      "initialize",
      {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO
      },
      signal
    );

    if (!isObject(result)) {
      throw new ConnectorError(
        "mcp_protocol_error",
        "MCP initialize returned no result",
        502
      );
    }

    const negotiated = typeof result.protocolVersion === "string"
      ? result.protocolVersion
      : LATEST_PROTOCOL_VERSION;
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(negotiated)) {
      throw new ConnectorError(
        "mcp_unsupported_version",
        `MCP server requires unsupported protocol version ${negotiated}`,
        502
      );
    }
    this.transport.setProtocolVersion(negotiated);

    if (isObject(result.serverInfo)) {
      this.serverInfo = {
        name: asString(result.serverInfo.name),
        version: asString(result.serverInfo.version)
      };
    }

    await this.transport.notify("notifications/initialized", {}, signal);
    this.initialized = true;
  }

  private async listTools(signal: AbortSignal): Promise<NormalizedToolDefinition[]> {
    const tools: NormalizedToolDefinition[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
      const result = await this.transport.request(
        "tools/list",
        cursor ? { cursor } : {},
        signal
      );
      if (!isObject(result) || !Array.isArray(result.tools)) {
        throw new ConnectorError(
          "mcp_protocol_error",
          "MCP tools/list returned a malformed result",
          502
        );
      }

      for (const tool of result.tools) {
        const normalized = normalizeToolDefinition(tool);
        if (normalized) {
          tools.push(normalized);
        }
      }

      cursor = asString(result.nextCursor);
      if (!cursor) {
        return tools;
      }
    }

    throw new ConnectorError(
      "mcp_pagination_limit",
      `MCP tools/list exceeded ${MAX_TOOL_LIST_PAGES} pages`,
      502
    );
  }

  getServerInfo() {
    return this.serverInfo;
  }
}

function normalizeToolDefinition(tool: unknown): NormalizedToolDefinition | null {
  if (!isObject(tool) || typeof tool.name !== "string") {
    return null;
  }
  const inputSchema = isObject(tool.inputSchema)
    ? (tool.inputSchema as JsonSchema)
    : { type: "object" as const };

  return {
    externalName: tool.name,
    title: asString(tool.title) ?? asString(tool.name) ?? tool.name,
    description: asString(tool.description) ?? "",
    inputSchema,
    outputSchema: isObject(tool.outputSchema)
      ? (tool.outputSchema as JsonSchema)
      : undefined,
    annotations: normalizeAnnotations(tool.annotations)
  };
}

/**
 * Map MCP annotation hints, defaulting missing hints to the restrictive class.
 * These are hints only; authoritative policy is assigned by the control plane.
 * The fail-closed defaults are deliberate: absence of an untrusted server hint
 * must never make a tool appear safer or bypass an approval boundary.
 */
function normalizeAnnotations(value: unknown): ToolAnnotations {
  if (!isObject(value)) {
    return { ...restrictiveAnnotations };
  }
  return {
    readOnly: value.readOnlyHint === true,
    destructive: value.destructiveHint !== false,
    idempotent: value.idempotentHint === true,
    openWorld: value.openWorldHint !== false
  };
}

function normalizeCallResult(result: unknown): ToolResult {
  if (!isObject(result)) {
    throw new ConnectorError(
      "mcp_protocol_error",
      "MCP tools/call returned a malformed result",
      502
    );
  }

  const content: ToolResultContent[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const normalized = normalizeContentBlock(block);
      if (normalized) {
        content.push(normalized);
      }
    }
  }

  return {
    isError: result.isError === true,
    content,
    structured:
      "structuredContent" in result ? result.structuredContent : undefined
  };
}

function normalizeContentBlock(block: unknown): ToolResultContent | null {
  if (!isObject(block) || typeof block.type !== "string") {
    return null;
  }
  switch (block.type) {
    case "text":
      return { type: "text", text: asString(block.text) ?? "" };
    case "image":
    case "audio":
      return {
        type: "binary",
        mimeType: asString(block.mimeType) ?? "application/octet-stream",
        base64: asString(block.data) ?? ""
      };
    case "resource": {
      const resource = isObject(block.resource) ? block.resource : {};
      return {
        type: "resource",
        uri: asString(resource.uri) ?? "",
        mimeType: asString(resource.mimeType),
        text: asString(resource.text)
      };
    }
    default:
      return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Derive a child AbortSignal that also fires after `timeoutMs`. Returns the
 * combined signal and a disposer that clears the timer and detaches listeners.
 */
function withTimeout(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new ConnectorError("timeout", "Tool call timed out", 504));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    }
  };
}
