import {
  ConnectorError,
  restrictiveAnnotations,
  type Connector,
  type ConnectorInvocation,
  type JsonSchema,
  type NormalizedToolDefinition,
  type ToolResult
} from "./types";
import { safeFetch, type EgressPolicy } from "../net/egress";

const SPEC_MAX_BYTES = 2_000_000;
const SCHEMA_MAX_DEPTH = 32;
const SCHEMA_MAX_NODES = 10_000;
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const RESERVED_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  "transfer-encoding"
]);

export type OpenApiConfig = {
  url: string;
  headers?: Record<string, string>;
  authHeader?: string;
  authScheme?: string;
};

type OpenApiSourceMetadata = {
  method: string;
  path: string;
  baseUrl: string;
};

export class OpenApiConnector implements Connector {
  readonly source = "openapi" as const;

  constructor(
    private readonly options: {
      config: OpenApiConfig;
      headers: Record<string, string>;
      egressPolicy: EgressPolicy;
      maxResponseBytes: number;
      resolver?: (host: string) => Promise<string[]>;
    }
  ) {}

  async discover(signal: AbortSignal): Promise<NormalizedToolDefinition[]> {
    const response = await safeFetch(
      this.options.config.url,
      {
        method: "GET",
        headers: { accept: "application/json", ...this.options.headers },
        signal
      },
      this.options.egressPolicy,
      this.options.resolver
    );
    if (!response.ok) {
      throw new ConnectorError(
        "openapi_discovery_failed",
        `OpenAPI document returned HTTP ${response.status}`,
        502
      );
    }

    const document = parseDocument(await readBoundedText(response, SPEC_MAX_BYTES));

    const definitions: NormalizedToolDefinition[] = [];
    const names = new Set<string>();
    const paths = objectValue(document.paths);
    for (const [path, rawPathItem] of Object.entries(paths)) {
      const pathItem = objectValue(resolveRef(document, rawPathItem));
      for (const method of HTTP_METHODS) {
        if (!(method in pathItem)) continue;
        const operation = objectValue(resolveRef(document, pathItem[method]));
        const servers =
          operation.servers ?? pathItem.servers ?? document.servers;
        const baseUrl = resolveBaseUrl(servers, this.options.config.url);
        const externalName = operationName(operation, method, path);
        if (names.has(externalName)) {
          throw new ConnectorError(
            "openapi_duplicate_operation",
            `OpenAPI operation name is not unique: ${externalName}`,
            400
          );
        }
        names.add(externalName);

        const parameters = [
          ...arrayValue(pathItem.parameters),
          ...arrayValue(operation.parameters)
        ].map((value) => objectValue(resolveRef(document, value)));
        const requestBody = objectValue(
          resolveRef(document, operation.requestBody)
        );

        definitions.push({
          externalName,
          title: stringValue(operation.summary) ?? externalName,
          description: stringValue(operation.description) ?? "",
          inputSchema: inputSchema(document, parameters, requestBody),
          outputSchema: outputSchema(document, operation),
          // Remote risk hints never become effective policy. The runtime also
          // re-applies this restrictive class before persistence.
          annotations: restrictiveAnnotations,
          sourceMetadata: {
            method: method.toUpperCase(),
            path,
            baseUrl
          }
        });
      }
    }
    return definitions.sort((a, b) => a.externalName.localeCompare(b.externalName));
  }

  async invoke(invocation: ConnectorInvocation): Promise<ToolResult> {
    const metadata = parseSourceMetadata(invocation.sourceMetadata);
    const input = objectValue(invocation.input);
    const pathInput = objectValue(input.path);
    const queryInput = objectValue(input.query);
    const headerInput = objectValue(input.headers);

    let path = metadata.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = pathInput[name];
      if (value === undefined || value === null) {
        throw new ConnectorError(
          "openapi_path_parameter_missing",
          `Missing OpenAPI path parameter: ${name}`,
          400
        );
      }
      return encodePathParameter(name, value);
    });
    if (!path.startsWith("/")) path = `/${path}`;

    const url = new URL(path, metadata.baseUrl);
    for (const [name, value] of Object.entries(queryInput)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(name, scalarValue(item));
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(name, scalarValue(value));
      }
    }

    const headers: Record<string, string> = {
      accept: "application/json, text/plain;q=0.9",
      ...this.options.headers
    };
    for (const [name, value] of Object.entries(headerInput)) {
      const normalized = name.toLowerCase();
      if (RESERVED_HEADERS.has(normalized)) {
        throw new ConnectorError(
          "openapi_reserved_header",
          `OpenAPI input cannot set reserved header: ${name}`,
          400
        );
      }
      if (value !== undefined && value !== null) headers[normalized] = scalarValue(value);
    }
    if (invocation.idempotencyKey) {
      headers["idempotency-key"] = invocation.idempotencyKey;
    }

    const hasBody = input.body !== undefined && metadata.method !== "GET";
    if (hasBody) headers["content-type"] = "application/json";
    const response = await safeFetch(
      url.toString(),
      {
        method: metadata.method,
        headers,
        body: hasBody ? JSON.stringify(input.body) : undefined,
        signal: invocation.signal
      },
      this.options.egressPolicy,
      this.options.resolver
    );
    const text = await readBoundedText(
      response,
      invocation.limits.maxResponseBytes
    );
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const parsed = contentType.includes("json") && text ? parseJson(text) : undefined;

    if (!response.ok) {
      return {
        isError: true,
        content: [
          parsed === undefined
            ? { type: "text", text: `HTTP ${response.status}: ${text}` }
            : { type: "json", data: { status: response.status, body: parsed } }
        ]
      };
    }
    if (parsed !== undefined) {
      return {
        isError: false,
        content: [{ type: "json", data: parsed }],
        structured: parsed
      };
    }
    return { isError: false, content: [{ type: "text", text }] };
  }
}

function parseDocument(text: string): Record<string, unknown> {
  const parsed = parseJson(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectorError("invalid_openapi", "OpenAPI document must be a JSON object", 400);
  }
  const version = stringValue((parsed as Record<string, unknown>).openapi);
  if (!version?.startsWith("3.")) {
    throw new ConnectorError("invalid_openapi", "Only OpenAPI 3.x documents are supported", 400);
  }
  return parsed as Record<string, unknown>;
}

function resolveBaseUrl(serversValue: unknown, documentUrl: string): string {
  const declaredServers = arrayValue(serversValue);
  if (declaredServers.length === 0) return new URL("/", documentUrl).toString();

  const documentOrigin = new URL(documentUrl).origin;
  const servers = declaredServers.map((value) => {
    const serverUrl = stringValue(objectValue(value).url);
    if (!serverUrl || /[{}]/.test(serverUrl)) {
      throw new ConnectorError(
        "invalid_openapi_server",
        "OpenAPI server URL is invalid or contains unresolved variables",
        400
      );
    }
    try {
      return new URL(serverUrl, documentUrl);
    } catch (cause) {
      throw new ConnectorError(
        "invalid_openapi_server",
        "OpenAPI server URL is invalid or contains unresolved variables",
        400,
        cause
      );
    }
  });
  if (servers.some((server) => server.origin !== documentOrigin)) {
    throw new ConnectorError(
      "openapi_cross_origin_server",
      "Every OpenAPI server URL must share the document origin so credentials cannot be forwarded cross-origin",
      400
    );
  }
  return servers[0]!.toString();
}

function operationName(
  operation: Record<string, unknown>,
  method: string,
  path: string
): string {
  const operationId = stringValue(operation.operationId)?.trim();
  if (operationId) return operationId;
  return `${method}_${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inputSchema(
  document: Record<string, unknown>,
  parameters: Record<string, unknown>[],
  requestBody: Record<string, unknown>
): JsonSchema {
  const properties = Object.create(null) as Record<string, unknown>;
  const requiredGroups: string[] = [];
  for (const location of ["path", "query", "header"] as const) {
    const located = parameters.filter((parameter) => parameter.in === location);
    if (located.length === 0) continue;
    const groupProperties = Object.create(null) as Record<string, unknown>;
    const groupRequired: string[] = [];
    for (const parameter of located) {
      const name = stringValue(parameter.name);
      if (!name) continue;
      groupProperties[name] = resolveSchema(document, parameter.schema);
      if (parameter.required === true || location === "path") groupRequired.push(name);
    }
    properties[location === "header" ? "headers" : location] = {
      type: "object",
      properties: groupProperties,
      additionalProperties: false,
      ...(groupRequired.length > 0 ? { required: groupRequired } : {})
    };
    if (groupRequired.length > 0) {
      requiredGroups.push(location === "header" ? "headers" : location);
    }
  }

  const content = objectValue(requestBody.content);
  const jsonMedia = objectValue(content["application/json"]);
  if (Object.keys(content).length > 0 && Object.keys(jsonMedia).length === 0) {
    throw new ConnectorError(
      "unsupported_openapi_media_type",
      "OpenAPI request bodies must support application/json",
      400
    );
  }
  if (Object.keys(jsonMedia).length > 0) {
    properties.body = resolveSchema(document, jsonMedia.schema);
    if (requestBody.required === true) requiredGroups.push("body");
  }
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(requiredGroups.length > 0 ? { required: requiredGroups } : {})
  };
}

function outputSchema(
  document: Record<string, unknown>,
  operation: Record<string, unknown>
): JsonSchema | undefined {
  const responses = objectValue(operation.responses);
  const successKey = Object.keys(responses).sort().find((key) => /^2\d\d$/.test(key));
  if (!successKey) return undefined;
  const response = objectValue(resolveRef(document, responses[successKey]));
  const jsonMedia = objectValue(objectValue(response.content)["application/json"]);
  return Object.keys(jsonMedia).length > 0
    ? resolveSchema(document, jsonMedia.schema)
    : undefined;
}

function resolveSchema(document: Record<string, unknown>, value: unknown): JsonSchema {
  const state = { nodes: 0, refs: new Set<string>() };
  const resolved = resolveSchemaValue(document, value, state, 0);
  if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new ConnectorError(
      "unsupported_openapi_schema",
      "OpenAPI tool schemas must resolve to JSON Schema objects",
      400
    );
  }
  return resolved as JsonSchema;
}

function resolveRef(document: Record<string, unknown>, value: unknown): unknown {
  let current = value;
  const seen = new Set<string>();
  while (true) {
    const ref = stringValue(objectValue(current).$ref);
    if (!ref) return current;
    if (seen.has(ref)) {
      throw new ConnectorError("openapi_ref_cycle", `OpenAPI reference cycle: ${ref}`, 400);
    }
    seen.add(ref);
    current = lookupLocalRef(document, ref);
  }
}

function resolveSchemaValue(
  document: Record<string, unknown>,
  value: unknown,
  state: { nodes: number; refs: Set<string> },
  depth: number
): unknown {
  state.nodes += 1;
  if (depth > SCHEMA_MAX_DEPTH || state.nodes > SCHEMA_MAX_NODES) {
    throw new ConnectorError(
      "openapi_schema_too_complex",
      "OpenAPI schema exceeds the supported depth or size limit",
      400
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSchemaValue(document, item, state, depth + 1));
  }
  if (!value || typeof value !== "object") return value;

  const object = value as Record<string, unknown>;
  const ref = stringValue(object.$ref);
  let target: Record<string, unknown> = object;
  if (ref) {
    if (state.refs.has(ref)) {
      throw new ConnectorError("openapi_schema_cycle", `OpenAPI schema reference cycle: ${ref}`, 400);
    }
    state.refs.add(ref);
    const resolved = resolveSchemaValue(
      document,
      lookupLocalRef(document, ref),
      state,
      depth + 1
    );
    state.refs.delete(ref);
    if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)) {
      throw new ConnectorError(
        "unsupported_openapi_schema",
        `OpenAPI schema reference must resolve to an object: ${ref}`,
        400
      );
    }
    target = { ...(resolved as Record<string, unknown>), ...object };
  }

  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(target)) {
    if (key === "$ref") continue;
    output[key] = resolveSchemaValue(document, child, state, depth + 1);
  }
  return output;
}

function lookupLocalRef(document: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    throw new ConnectorError(
      "unsupported_openapi_ref",
      "Only local OpenAPI references are supported",
      400
    );
  }
  let current: unknown = document;
  for (const encoded of ref.slice(2).split("/")) {
    const segment = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    const object = objectValue(current);
    if (!Object.prototype.hasOwnProperty.call(object, segment)) {
      throw new ConnectorError(
        "invalid_openapi_ref",
        `OpenAPI reference was not found: ${ref}`,
        400
      );
    }
    current = object[segment];
  }
  return current;
}

function encodePathParameter(name: string, value: unknown): string {
  const raw = scalarValue(value);
  if (raw === "." || raw === ".." || /[%/\\]/.test(raw)) {
    throw new ConnectorError(
      "openapi_path_parameter_unsafe",
      `OpenAPI path parameter cannot contain dot segments or encoded separators: ${name}`,
      400
    );
  }
  return encodeURIComponent(raw);
}

function parseSourceMetadata(value: unknown): OpenApiSourceMetadata {
  const metadata = objectValue(value);
  const method = stringValue(metadata.method);
  const path = stringValue(metadata.path);
  const baseUrl = stringValue(metadata.baseUrl);
  if (!method || !path || !baseUrl || !HTTP_METHODS.includes(method.toLowerCase() as never)) {
    throw new ConnectorError("invalid_openapi_operation", "Stored OpenAPI operation metadata is invalid", 500);
  }
  return { method: method.toUpperCase(), path, baseUrl };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ConnectorError("response_too_large", `Response exceeds ${maxBytes} bytes`, 413);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ConnectorError("response_too_large", `Response exceeds ${maxBytes} bytes`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (cause) {
    throw new ConnectorError("invalid_json", "Remote endpoint returned invalid JSON", 502, cause);
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function scalarValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new ConnectorError("invalid_openapi_parameter", "OpenAPI parameters must be scalar values", 400);
}
