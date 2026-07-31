/**
 * Build a live connector for a resolved connection.
 *
 * Credentials are resolved server-side by the gateway and passed in here as
 * plaintext for the duration of a single call; they are never read from the
 * database or environment by connector code and never returned to a caller.
 */

import type { ToolConnectionRow } from "@lush/db/schema";
import {
  ConnectorError,
  type Connector
} from "./connectors/types";
import { NativeConnector } from "./connectors/native";
import { McpConnector } from "./connectors/mcp/client";
import { defaultEgressPolicy, type EgressPolicy } from "./net/egress";

export type McpEndpointConfig = {
  url: string;
  /** Optional static headers configured on the connection (never secrets). */
  headers?: Record<string, string>;
  /** Header used to carry the resolved credential. Defaults to Authorization. */
  authHeader?: string;
  /** Scheme prefix for the credential value. Defaults to "Bearer ". */
  authScheme?: string;
};

export type BuildConnectorOptions = {
  connection: ToolConnectionRow;
  /** Resolved credential plaintext, if the connection uses one. */
  credential?: string | null;
  egressPolicy?: EgressPolicy;
  maxResponseBytes?: number;
  resolver?: (host: string) => Promise<string[]>;
};

export function buildConnector(options: BuildConnectorOptions): Connector {
  const { connection } = options;

  switch (connection.source) {
    case "native":
      return new NativeConnector();

    case "mcp": {
      const config = parseMcpConfig(connection.endpointConfig);
      const headers: Record<string, string> = { ...(config.headers ?? {}) };
      if (options.credential) {
        const headerName = config.authHeader ?? "authorization";
        const scheme = config.authScheme ?? "Bearer ";
        headers[headerName.toLowerCase()] = `${scheme}${options.credential}`;
      }
      return new McpConnector({
        endpoint: config.url,
        headers,
        egressPolicy: options.egressPolicy ?? defaultEgressPolicy(),
        maxResponseBytes: options.maxResponseBytes,
        resolver: options.resolver
      });
    }

    case "openapi":
      throw new ConnectorError(
        "unsupported_source",
        "OpenAPI connectors are not yet implemented",
        501
      );

    default:
      throw new ConnectorError(
        "unsupported_source",
        `Unknown connection source: ${connection.source}`,
        400
      );
  }
}

export function parseMcpConfig(raw: unknown): McpEndpointConfig {
  if (!raw || typeof raw !== "object") {
    throw new ConnectorError(
      "invalid_endpoint",
      "MCP connection is missing endpoint configuration",
      400
    );
  }
  const url = (raw as { url?: unknown }).url;
  if (typeof url !== "string" || !url.trim()) {
    throw new ConnectorError(
      "invalid_endpoint",
      "MCP connection requires an endpoint URL",
      400
    );
  }
  const config = raw as McpEndpointConfig;
  return {
    url: url.trim(),
    headers: sanitizeHeaders(config.headers),
    authHeader: typeof config.authHeader === "string" ? config.authHeader : undefined,
    authScheme: typeof config.authScheme === "string" ? config.authScheme : undefined
  };
}

function sanitizeHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
