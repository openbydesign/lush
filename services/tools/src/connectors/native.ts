/**
 * Native connector: trusted, in-process Lush tools registered in code with
 * explicit schemas and policy annotations.
 *
 * Native tools are the safest source class — no external egress, no credentials
 * — and serve as the first normalized surface for the gateway. Each tool is a
 * pure(ish) async function whose input is validated against its own schema by
 * the gateway before it reaches the handler here.
 */

import {
  ConnectorError,
  type Connector,
  type ConnectorInvocation,
  type NormalizedToolDefinition,
  type ToolResult
} from "./types";

export type NativeTool = NormalizedToolDefinition & {
  handler: (input: unknown, signal: AbortSignal) => Promise<ToolResult>;
};

export function jsonResult(data: unknown): ToolResult {
  return {
    isError: false,
    content: [{ type: "json", data }],
    structured: data
  };
}

export function textResult(text: string): ToolResult {
  return { isError: false, content: [{ type: "text", text }] };
}

/** The built-in native tool for the first vertical slice: read-only, offline. */
const currentTimeTool: NativeTool = {
  externalName: "current_time",
  title: "Current time",
  description:
    "Return the current server time as an ISO-8601 timestamp and Unix epoch " +
    "milliseconds. Read-only; performs no external calls.",
  inputSchema: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        description:
          "Optional IANA time zone (e.g. 'America/New_York'). Defaults to UTC."
      }
    },
    additionalProperties: false
  },
  outputSchema: {
    type: "object",
    properties: {
      iso: { type: "string" },
      epochMs: { type: "number" },
      timeZone: { type: "string" }
    },
    required: ["iso", "epochMs", "timeZone"]
  },
  annotations: {
    readOnly: true,
    destructive: false,
    idempotent: false,
    openWorld: false
  },
  async handler(input) {
    const timeZone = readTimeZone(input);
    const now = new Date();
    let localized: string;
    try {
      localized = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long"
      }).format(now);
    } catch {
      throw new ConnectorError(
        "invalid_time_zone",
        `Unknown time zone: ${timeZone}`,
        400
      );
    }
    return jsonResult({
      iso: now.toISOString(),
      epochMs: now.getTime(),
      timeZone,
      localized
    });
  }
};

export const builtinNativeTools: NativeTool[] = [currentTimeTool];

export class NativeConnector implements Connector {
  readonly source = "native" as const;

  private readonly tools: Map<string, NativeTool>;

  constructor(tools: NativeTool[] = builtinNativeTools) {
    this.tools = new Map(tools.map((tool) => [tool.externalName, tool]));
  }

  async discover(): Promise<NormalizedToolDefinition[]> {
    return [...this.tools.values()].map(({ handler: _handler, ...definition }) => definition);
  }

  async invoke(invocation: ConnectorInvocation): Promise<ToolResult> {
    const tool = this.tools.get(invocation.externalName);
    if (!tool) {
      throw new ConnectorError(
        "tool_not_found",
        `Unknown native tool: ${invocation.externalName}`,
        404
      );
    }
    return tool.handler(invocation.input, invocation.signal);
  }
}

function readTimeZone(input: unknown): string {
  if (
    input &&
    typeof input === "object" &&
    "timeZone" in input &&
    typeof (input as { timeZone?: unknown }).timeZone === "string" &&
    (input as { timeZone: string }).timeZone.trim()
  ) {
    return (input as { timeZone: string }).timeZone.trim();
  }
  return "UTC";
}
