/**
 * Minimal JSON-RPC 2.0 types for the MCP transport.
 *
 * We deliberately implement the protocol directly rather than depend on an
 * external MCP SDK: the plan requires that no external SDK become Lush's
 * canonical domain model, and the client surface we need (initialize, tools,
 * cancellation, bounded results) is small and security-sensitive.
 */

export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export function isJsonRpcResponse(message: unknown): message is JsonRpcResponse {
  return (
    isObject(message) &&
    message.jsonrpc === JSONRPC_VERSION &&
    "id" in message &&
    ("result" in message || "error" in message)
  );
}

export function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return (
    isObject(message) &&
    message.jsonrpc === JSONRPC_VERSION &&
    "id" in message &&
    "method" in message
  );
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
