/**
 * Connector plane contracts.
 *
 * A connector is the only code that speaks a source-specific protocol (MCP,
 * OpenAPI, native). Everything above the connector plane works exclusively with
 * these Lush-owned, normalized shapes. External descriptions, schemas, and risk
 * hints that arrive through a connector are untrusted and are treated as such by
 * the gateway; a connector's job is transport and normalization, never policy.
 */

export type JsonSchema = Record<string, unknown>;

export type ToolSource = "mcp" | "openapi" | "native";

/**
 * Tool annotations describe side-effect class. Values that originate from an
 * external source are hints only; Lush-owned policy metadata is authoritative
 * and an unreviewed tool defaults to the more restrictive class.
 */
export type ToolAnnotations = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export const restrictiveAnnotations: ToolAnnotations = {
  readOnly: false,
  destructive: true,
  idempotent: false,
  openWorld: true
};

/**
 * A capability discovered or registered on a connection, before Lush assigns it
 * a stable id. The gateway persists these as `tool_definitions`.
 */
export type NormalizedToolDefinition = {
  externalName: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations: ToolAnnotations;
  /** Source-specific invocation data persisted with the normalized definition. */
  sourceMetadata?: Record<string, unknown>;
};

/**
 * A single content block returned by a tool. Mirrors the MCP content model but
 * is Lush-owned so OpenAPI and native tools normalize into the same shape.
 */
export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "json"; data: unknown }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | { type: "binary"; mimeType: string; base64: string };

/**
 * Lush-owned normalized result. Every connector returns this; the gateway never
 * exposes raw provider envelopes to the runner.
 */
export type ToolResult = {
  isError: boolean;
  content: ToolResultContent[];
  /** Structured output when the tool declares an output schema. */
  structured?: unknown;
};

export type ConnectorInvocation = {
  externalName: string;
  input: unknown;
  sourceMetadata?: unknown;
  /**
   * Bounds enforced by the connector transport in addition to the gateway's own
   * checks. Defense in depth: a connector must not exceed these even if the
   * gateway later re-clamps.
   */
  limits: ConnectorLimits;
  signal: AbortSignal;
  /** Idempotency key for side-effecting sources that support it. */
  idempotencyKey?: string;
};

export type ConnectorLimits = {
  timeoutMs: number;
  maxResponseBytes: number;
};

export const defaultConnectorLimits: ConnectorLimits = {
  timeoutMs: 30_000,
  maxResponseBytes: 1_000_000
};

/**
 * A connector is instantiated per resolved connection with credentials already
 * injected by the control plane. The connector never reads credentials from the
 * database or environment itself.
 */
export interface Connector {
  readonly source: ToolSource;
  /** Discover the tools exposed by this connection, normalized. */
  discover(signal: AbortSignal): Promise<NormalizedToolDefinition[]>;
  /** Invoke one tool and return a normalized result. */
  invoke(invocation: ConnectorInvocation): Promise<ToolResult>;
  /** Release any transport state (MCP sessions, sockets). */
  close?(): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}
