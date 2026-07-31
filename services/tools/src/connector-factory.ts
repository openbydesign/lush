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
import { OpenApiConnector, type OpenApiConfig } from "./connectors/openapi";
import { defaultEgressPolicy, type EgressPolicy } from "./net/egress";

const RESERVED_CREDENTIAL_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
    {
      const config = parseOpenApiConfig(connection.endpointConfig);
      const headers: Record<string, string> = { ...(config.headers ?? {}) };
      if (options.credential) {
        const headerName = config.authHeader ?? "authorization";
        const scheme = config.authScheme ?? "Bearer ";
        headers[headerName.toLowerCase()] = `${scheme}${options.credential}`;
      }
      return new OpenApiConnector({
        config,
        headers,
        egressPolicy: options.egressPolicy ?? defaultEgressPolicy(),
        maxResponseBytes: options.maxResponseBytes ?? 1_000_000,
        resolver: options.resolver
      });
    }

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
    authHeader: credentialHeaderName(config.authHeader),
    authScheme: typeof config.authScheme === "string" ? config.authScheme : undefined
  };
}

export function parseOpenApiConfig(raw: unknown): OpenApiConfig {
  if (!raw || typeof raw !== "object") {
    throw new ConnectorError(
      "invalid_endpoint",
      "OpenAPI connection is missing endpoint configuration",
      400
    );
  }
  const url = (raw as { url?: unknown }).url;
  if (typeof url !== "string" || !url.trim()) {
    throw new ConnectorError(
      "invalid_endpoint",
      "OpenAPI connection requires a document URL",
      400
    );
  }
  const config = raw as OpenApiConfig;
  return {
    url: url.trim(),
    headers: sanitizeHeaders(config.headers),
    authHeader: credentialHeaderName(config.authHeader),
    authScheme: typeof config.authScheme === "string" ? config.authScheme : undefined
  };
}

function credentialHeaderName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !HEADER_NAME_PATTERN.test(value)) {
    throw new ConnectorError(
      "invalid_endpoint",
      "Credential header name is invalid",
      400
    );
  }
  const normalized = value.toLowerCase();
  if (RESERVED_CREDENTIAL_HEADERS.has(normalized)) {
    throw new ConnectorError(
      "invalid_endpoint",
      `Credential header is reserved and cannot be configured: ${value}`,
      400
    );
  }
  return normalized;
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
